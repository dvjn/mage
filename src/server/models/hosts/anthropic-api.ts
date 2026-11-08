// Lists the models an Anthropic API key can use, from the Anthropic API, and streams replies from
// its Messages endpoint with the AI SDK's Anthropic provider. A connection's proxy takes the place
// of the API for both, with its headers added. The Claude sign-in lists and replies the same way.

import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import type { Instructions } from "ai";
import * as z from "zod";

import type { Catalog } from "@/server/models/catalog.ts";
import type { ModelGateway, ModelRequest } from "@/server/models/gateway.ts";

import { type InlineChanges, type ProviderErrors, streamReply } from "./ai-sdk-stream.ts";

export const API_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      max_input_tokens: z.number().int().positive().nullish(),
      capabilities: z
        .object({ thinking: z.object({ supported: z.boolean() }).nullish() })
        .nullish(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

export function createAnthropicKeyCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return anthropicCatalog(fetchFn, (access) => ({ "x-api-key": access }));
}

// The model list, read with the headers that carry the connection's key or token.
export function anthropicCatalog(
  fetchFn: typeof fetch,
  authHeaders: (access: string) => Record<string, string>,
): Catalog {
  return {
    async list(token, signal) {
      const models: z.infer<typeof modelsSchema>["data"] = [];
      let after: string | null | undefined;
      do {
        const query = new URLSearchParams({ limit: "1000", ...(after && { after_id: after }) });
        const res = await fetchFn(`${token.proxy?.baseUrl ?? API_URL}/models?${query.toString()}`, {
          headers: {
            Accept: "application/json",
            "anthropic-version": API_VERSION,
            ...authHeaders(token.access),
            ...token.proxy?.headers,
          },
          signal,
        });
        if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
        const body = modelsSchema.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new Error("model list response is not a list");
        models.push(...body.data.data);
        after = body.data.has_more ? body.data.last_id : null;
      } while (after);
      return models.map((model) => ({
        id: model.id,
        name: model.display_name,
        ...(model.max_input_tokens && { contextWindow: model.max_input_tokens }),
        ...(model.capabilities?.thinking && { reasoning: model.capabilities.thinking.supported }),
      }));
    },
  };
}

// A rate limit reset as epoch seconds or an RFC 3339 time.
export function instant(value: string | undefined) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? new Date(seconds * 1000) : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

// The Anthropic API explains its limits in `anthropic-ratelimit-*` headers: per-minute request and
// token limits, each with when it resets.
export const anthropicErrors: ProviderErrors = {
  explains: (name) => name.startsWith("anthropic-ratelimit-") || name === "request-id",
  resetsAt(headers) {
    const minute = ["requests", "tokens", "input-tokens", "output-tokens"]
      .filter((limit) => headers[`anthropic-ratelimit-${limit}-remaining`] === "0")
      .map((limit) => instant(headers[`anthropic-ratelimit-${limit}-reset`]))
      .filter((at): at is Date => at !== null)
      .toSorted((a, b) => b.getTime() - a.getTime());
    return minute[0] ?? null;
  },
};

// The models that take system messages mid-conversation, and with them tools turned on there.
const MID_CONVERSATION_SYSTEM =
  /^claude-(?:(?:fable|mythos)-5(?:-1)?|opus-(?:4-8|5|5-5)|sonnet-5-5|haiku-5-5)(?:-\d{8})?$/;

// The models that take an effort change in a system message mid-conversation.
const MESSAGE_EFFORT =
  /^claude-(?:(?:fable|mythos)-5-1|opus-5(?:-5)?|sonnet-5-5|haiku-5-5)(?:-\d{8})?$/;

// What a request is sent with so that what changes in the thread leaves its start as it was, for
// the models that take changes mid-conversation: each searchable tool declared from the first
// request but not loaded, and loaded where a system message adds it; and, while the thread's
// first effort and the one asked for now are known, the first as the request's own, each change
// since told where it happened. Otherwise the effort asked for now is the request's own.
function changesFor(request: ModelRequest) {
  const tools = MID_CONVERSATION_SYSTEM.test(request.model);
  const pinned = MESSAGE_EFFORT.test(request.model) && request.effort && request.firstEffort;
  const changes: InlineChanges | undefined =
    tools || pinned
      ? {
          ...(tools && { deferred: { anthropic: { deferLoading: true } } }),
          message({ tools: added, effort }) {
            const toolChanges = tools
              ? (added ?? []).map((name) => ({ type: "tool_addition", toolName: name }))
              : [];
            const told = pinned ? effort : undefined;
            if (toolChanges.length === 0 && !told) return null;
            return {
              anthropic: {
                ...(toolChanges.length > 0 && { toolChanges }),
                ...(told && { effort: told }),
              },
            };
          },
        }
      : undefined;
  return { effort: pinned ? request.firstEffort : request.effort, changes };
}

// A cache breakpoint on Anthropic's Messages API, under any host that serves it. The API caches
// only up to these, for five minutes from each use.
export const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

// Replies through the provider's Messages API with the system prompt given, cached up to its
// breakpoints. A model that can think does so at the effort asked for, and streams its thinking;
// one that takes them is told tools turned on and effort changes mid-conversation.
export function anthropicReply(
  provider: AnthropicProvider,
  request: ModelRequest,
  signal: AbortSignal,
  options: { system: Instructions; errors: ProviderErrors },
) {
  const { effort, changes } = changesFor(request);
  return streamReply(provider.messages(request.model), request, signal, {
    system: options.system,
    // Adaptive thinking at that effort, or a thinking budget for models without it.
    ...(effort && { reasoning: effort }),
    errors: options.errors,
    ...(changes && { changes }),
    cache: ANTHROPIC_CACHE,
  });
}

// Replies through the Anthropic Messages API with an API key, the instructions as the system
// prompt.
export function createAnthropicKeyGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      // Without a key the provider falls back to one from the environment.
      if (!token.access) throw new Error("the connection has no API key");
      const provider = createAnthropic({
        baseURL: token.proxy?.baseUrl ?? API_URL,
        apiKey: token.access,
        headers: { "user-agent": "mage", ...token.proxy?.headers },
        fetch: fetchFn,
      });
      yield* anthropicReply(provider, request, signal, {
        system: request.instructions,
        errors: anthropicErrors,
      });
    },
  };
}

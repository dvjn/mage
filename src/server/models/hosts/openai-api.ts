// Lists the models an OpenAI API key can chat with, from the OpenAI API, and streams replies from
// its Responses endpoint with the AI SDK's OpenAI provider. A connection's proxy takes the place of
// the API for both, with its headers added.

import { createOpenAI, openai } from "@ai-sdk/openai";
import * as z from "zod";

import type { Catalog } from "@/server/models/catalog.ts";
import type { Effort, ModelGateway, ModelRequest } from "@/server/models/gateway.ts";

import {
  type InlineChanges,
  type ProviderErrors,
  streamReply,
  toolName,
  type ToolSearch,
} from "./ai-sdk-stream.ts";

const API_URL = "https://api.openai.com/v1";

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), created: z.number().optional() })),
});

// The list names every model the key may call, chat or not, and says nothing else about them; the
// chat models are told apart by their names.
const CHAT = /^(gpt-|chatgpt-|o\d)/;
const NOT_CHAT = /audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/;
// Models that think before they answer.
const REASONING = /^(o\d|gpt-[5-9])/;

export function createOpenAIKeyCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return {
    async list(token, signal) {
      const res = await fetchFn(`${token.proxy?.baseUrl ?? API_URL}/models`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token.access}`,
          ...token.proxy?.headers,
        },
        signal,
      });
      if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
      const body = modelsSchema.safeParse(await res.json().catch(() => null));
      if (!body.success) throw new Error("model list response is not a list");
      return body.data.data
        .filter((model) => CHAT.test(model.id) && !NOT_CHAT.test(model.id))
        .toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
        .map((model) => ({ id: model.id, name: model.id, reasoning: REASONING.test(model.id) }));
    },
  };
}

// The OpenAI API explains its limits in `x-ratelimit-*` headers.
export const openaiErrors: ProviderErrors = {
  explains: (name) => name.startsWith("x-ratelimit-") || name === "x-request-id",
};

// The models that take an effort change in the conversation, as a configuration update.
function takesEffortChanges(model: string) {
  const major = /^gpt-(\d+)/.exec(model)?.[1];
  return major !== undefined && Number(major) >= 6;
}

// The effort a Responses request is sent with, and how it tells a change: for a model that takes
// changes in the conversation, while the thread's first effort and the one asked for now are
// known, the first, each change since told where it happened, so the request's start stays as it
// was; otherwise the effort asked for now.
export function responsesEffort(request: ModelRequest): {
  effort?: Effort;
  changes?: InlineChanges;
} {
  if (!request.effort || !request.firstEffort || !takesEffortChanges(request.model)) {
    return { ...(request.effort && { effort: request.effort }) };
  }
  return {
    effort: request.firstEffort,
    changes: {
      message: ({ effort }) => (effort ? { openai: { reasoningEffortUpdate: effort } } : null),
    },
  };
}

// The models with a tool search of their own, from GPT-5.4 on.
function takesToolSearch(model: string) {
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(model);
  if (!version) return false;
  const [major, minor] = [Number(version[1]), Number(version[2] ?? 0)];
  return major > 5 || (major === 5 && minor >= 4);
}

// The Responses API's tool search, run by whoever asked: the search tool is offered as it, and each
// search gives back the tools it turned on, which the API adds at the end of the context so the
// cached prompt before them stays as it was.
const RESPONSES_SEARCH: ToolSearch = {
  tool: (search) =>
    openai.tools.toolSearch({
      execution: "client",
      description: search.description,
      parameters: search.inputSchema,
    }),
  input: (callId, input) => ({ arguments: input, call_id: callId }),
  // A search call's item needs an id of its kind; nothing is kept between requests to look it up.
  callOptions(callId) {
    const itemId = `tsc_${callId.replace(/^call_/, "")}`;
    return { openai: { itemId }, azure: { itemId } };
  },
  inputOf(input) {
    const call = (typeof input === "string" ? JSON.parse(input) : input) as { arguments?: unknown };
    return call.arguments ?? {};
  },
  output: (_result, tools) => ({
    type: "json",
    value: {
      tools: tools.map((tool) => ({
        type: "function",
        name: toolName(tool.id),
        description: tool.description,
        parameters: tool.inputSchema as never,
        defer_loading: true,
      })),
    },
  }),
};

// The tool search a Responses request is sent with, for a model that has one.
export function responsesSearch(request: ModelRequest) {
  return takesToolSearch(request.model) ? { search: RESPONSES_SEARCH } : {};
}

// Replies through the Responses endpoint with the instructions as the system prompt. A model that
// can think is given the effort and streams a summary of its reasoning; one that takes them is told
// effort changes in the conversation, and turns tools on with its own tool search. The API caches
// prompts by itself; the thread keys its cache.
export function createOpenAIKeyGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      // Without a key the provider falls back to one from the environment.
      if (!token.access) throw new Error("the connection has no API key");
      const provider = createOpenAI({
        baseURL: token.proxy?.baseUrl ?? API_URL,
        apiKey: token.access,
        ...(token.proxy && { headers: token.proxy.headers }),
        fetch: fetchFn,
      });
      const { effort, changes } = responsesEffort(request);
      yield* streamReply(provider.responses(request.model), request, signal, {
        system: request.instructions,
        providerOptions: {
          openai: {
            // Each request carries the whole conversation, so the API keeps nothing.
            store: false,
            promptCacheKey: request.sessionId,
            ...(effort && { reasoningEffort: effort, reasoningSummary: "auto" }),
          },
        },
        errors: openaiErrors,
        ...(changes && { changes }),
        ...responsesSearch(request),
        toolChoiceCached: true,
      });
    },
  };
}

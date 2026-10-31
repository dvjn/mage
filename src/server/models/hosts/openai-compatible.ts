// Lists and replies with the models of every host that speaks OpenAI's Chat Completions: a lab's or
// an inference cloud's API with a key, or a server people run, at the address they gave, with an
// optional key. The list is the host's own, whichever of the shapes hosts answer with, filtered to
// models that chat; a host with none, or a server whose list is missing, gives what Mage knows it
// serves and the ids people typed. Replies stream with the AI SDK's OpenAI-compatible provider. A
// connection's proxy takes the place of the host's address for both, with its headers added.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import * as z from "zod";

import { knownModels, withTyped } from "@/server/models/model-data.ts";
import type { Catalog, CatalogModel } from "@/server/models/catalog.ts";
import type { ModelGateway, ModelToken } from "@/server/models/gateway.ts";
import { type HostId, hostOf, listOf } from "@/shared/hosts.ts";
import { makerNamed } from "@/shared/makers.ts";

import { type ProviderErrors, streamReply } from "./ai-sdk-stream.ts";

// Where the connection's requests go: its proxy, the server's address it was given, or the host's
// own address with the connection's settings in place of the `{name}`s in it.
export function baseUrlOf(host: HostId, token: Pick<ModelToken, "proxy" | "settings">) {
  const settings = token.settings ?? {};
  const base =
    token.proxy?.baseUrl ??
    settings.baseUrl ??
    (hostOf(host).baseUrl ?? "").replace(/\{(\w+)\}/g, (_, name: string) =>
      encodeURIComponent(settings[name] ?? ""),
    );
  if (!base) throw new Error("the connection has no address");
  return base.replace(/\/+$/, "");
}

const numeric = z.number().int().positive().nullish().catch(null);

// One model in a list, in any of the shapes hosts give: OpenAI's `id`, others' `name`, and the
// context window and thinking under the names each host uses, with what says it is not for chat.
const listedSchema = z.looseObject({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  display_name: z.string().optional(),
  owned_by: z.string().optional(),
  // Together's kind of model; Mistral's and GitHub's capabilities and output.
  type: z.string().optional(),
  capabilities: z.unknown().optional(),
  supported_output_modalities: z.array(z.string()).optional(),
  architecture: z.object({ output_modalities: z.array(z.string()).optional() }).optional(),
  context_length: numeric,
  context_window: numeric,
  max_context_length: numeric,
  max_model_len: numeric,
  limits: z.object({ max_input_tokens: numeric }).optional(),
  supported_parameters: z.array(z.string()).optional(),
});

type Listed = z.infer<typeof listedSchema>;

const listSchema = z.union([
  z.array(listedSchema),
  z.object({ data: z.array(listedSchema) }).transform((body) => body.data),
  z.object({ models: z.array(listedSchema) }).transform((body) => body.models),
]);

// Models no one chats with, by their names.
const NOT_CHAT =
  /embed|whisper|tts|transcri|rerank|moderation|guard|dall-e|image|stable-diffusion|flux|audio|speech|realtime|ocr/i;

function chats(model: Listed, id: string) {
  if (NOT_CHAT.test(id)) return false;
  if (model.type && !["chat", "language", "code", "model"].includes(model.type)) return false;
  const outputs = model.architecture?.output_modalities ?? model.supported_output_modalities;
  if (outputs && !outputs.includes("text")) return false;
  const capabilities = model.capabilities;
  if (capabilities && typeof capabilities === "object" && "completion_chat" in capabilities) {
    return capabilities.completion_chat !== false;
  }
  return true;
}

// The models a list names that chat, in its order, each once.
export function chatModels(body: unknown): CatalogModel[] {
  const parsed = listSchema.safeParse(body);
  if (!parsed.success) throw new Error("model list response is not a list");
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of parsed.data) {
    const id = (model.id ?? model.name ?? "").replace(/^models\//, "");
    if (!id || seen.has(id) || !chats(model, id)) continue;
    seen.add(id);
    const contextWindow =
      model.context_length ??
      model.context_window ??
      model.max_context_length ??
      model.max_model_len ??
      model.limits?.max_input_tokens;
    const name = model.display_name ?? (model.id && model.name) ?? id;
    models.push({
      id,
      name,
      ...(contextWindow && { contextWindow }),
      ...(model.supported_parameters && {
        reasoning: model.supported_parameters.includes("reasoning"),
      }),
    });
    const maker = makerNamed(model.owned_by);
    if (maker) models.at(-1)!.maker = maker;
  }
  return models;
}

export function createCompatibleCatalog(host: HostId, fetchFn: typeof fetch = fetch): Catalog {
  const { models: path } = hostOf(host);
  return {
    async list(token, signal) {
      const typed = listOf(token.settings?.models);
      if (!path) return withTyped(host, knownModels(host), typed);
      const base = baseUrlOf(host, token);
      const res = await fetchFn(/^https?:/.test(path) ? path : `${base}${path}`, {
        headers: {
          Accept: "application/json",
          ...(token.access && { Authorization: `Bearer ${token.access}` }),
          ...token.proxy?.headers,
        },
        signal,
      });
      // A server with no list still has the models Mage knows of it and those people typed.
      if (res.status === 404) {
        const fallback = withTyped(host, knownModels(host), typed);
        if (fallback.length > 0) return fallback;
      }
      if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
      return withTyped(host, chatModels(await res.json().catch(() => null)), typed);
    },
  };
}

// Hosts explain their limits in OpenAI's `x-ratelimit-*` headers, when they do.
export const compatibleErrors: ProviderErrors = {
  explains: (name) =>
    name.startsWith("x-ratelimit-") || name.endsWith("request-id") || name === "cf-ray",
};

// Replies through the host's Chat Completions endpoint, the instructions as the system prompt; a
// model that can think is asked for the effort.
export function createCompatibleGateway(host: HostId, fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      const provider = createOpenAICompatible({
        name: host,
        baseURL: baseUrlOf(host, token),
        ...(token.access && { apiKey: token.access }),
        headers: { ...token.proxy?.headers },
        includeUsage: true,
        fetch: fetchFn,
      });
      yield* streamReply(provider.chatModel(request.model), request, signal, {
        system: request.instructions,
        ...(request.effort && { reasoning: request.effort }),
        errors: compatibleErrors,
      });
    },
  };
}

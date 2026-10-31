// Lists the models an OpenAI API key can chat with, from the OpenAI API, and streams replies from
// its Responses endpoint with the AI SDK's OpenAI provider. A connection's proxy takes the place of
// the API for both, with its headers added.

import { createOpenAI } from "@ai-sdk/openai";
import * as z from "zod";

import type { Catalog } from "@/server/models/catalog.ts";
import type { ModelGateway } from "@/server/models/gateway.ts";

import { type ProviderErrors, streamReply } from "./ai-sdk-stream.ts";

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

// Replies through the Responses endpoint with the instructions as the system prompt. A model that
// can think is given the effort and streams a summary of its reasoning.
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
      yield* streamReply(provider.responses(request.model), request, signal, {
        system: request.instructions,
        ...(request.effort && {
          providerOptions: {
            openai: { reasoningEffort: request.effort, reasoningSummary: "auto" },
          },
        }),
        errors: openaiErrors,
      });
    },
  };
}

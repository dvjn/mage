// Lists the models a Gemini API key can chat with, from the Gemini API, and streams replies from it
// with the AI SDK's Google provider. A connection's proxy takes the place of the API for both, with
// its headers added.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import * as z from "zod";

import { type ProviderErrors, streamReply } from "@/adapters/ai-sdk-stream.ts";
import { described } from "@/adapters/model-data.ts";
import type { Catalog, CatalogModel } from "@/ports/catalog.ts";
import type { ModelGateway } from "@/ports/model-gateway.ts";
import { HOSTS } from "@/shared/hosts.ts";

const API_URL = HOSTS.google.baseUrl;

const modelsSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        inputTokenLimit: z.number().int().positive().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
        thinking: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

// Gemini's own models, not the embedding, image or audio ones beside them.
const CHAT = /^(gemini|gemma)-/;
const NOT_CHAT = /embedding|image|tts|audio|live|robotics|aqa/;

export function createGeminiCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return {
    async list(token, signal) {
      const models: CatalogModel[] = [];
      let page: string | undefined;
      do {
        const query = new URLSearchParams({ pageSize: "1000", ...(page && { pageToken: page }) });
        const res = await fetchFn(`${token.proxy?.baseUrl ?? API_URL}/models?${query.toString()}`, {
          headers: {
            Accept: "application/json",
            "x-goog-api-key": token.access,
            ...token.proxy?.headers,
          },
          signal,
        });
        if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
        const body = modelsSchema.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new Error("model list response is not a list");
        for (const model of body.data.models) {
          const id = model.name.replace(/^models\//, "");
          if (!CHAT.test(id) || NOT_CHAT.test(id)) continue;
          if (!model.supportedGenerationMethods?.includes("generateContent")) continue;
          models.push(
            described("google", {
              id,
              name: model.displayName ?? id,
              ...(model.inputTokenLimit && { contextWindow: model.inputTokenLimit }),
              ...(model.thinking !== undefined && { reasoning: model.thinking }),
            }),
          );
        }
        page = body.data.nextPageToken;
      } while (page);
      return models;
    },
  };
}

// Google names requests in `x-goog-*` headers.
export const googleErrors: ProviderErrors = {
  explains: (name) => name.startsWith("x-goog-") || name.endsWith("request-id"),
};

// Replies through the Gemini API, the instructions as the system prompt. A model that can think
// does so at the effort asked for, and streams its thoughts.
export function createGeminiGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      // Without a key the provider falls back to one from the environment.
      if (!token.access) throw new Error("the connection has no API key");
      const provider = createGoogleGenerativeAI({
        baseURL: token.proxy?.baseUrl ?? API_URL,
        apiKey: token.access,
        headers: { ...token.proxy?.headers },
        fetch: fetchFn,
      });
      yield* streamReply(provider(request.model), request, signal, {
        system: request.instructions,
        ...(request.effort && { reasoning: request.effort }),
        errors: googleErrors,
      });
    },
  };
}

// OpenCode Console (Zen) and Go: independent live catalogs and billing, with Console API keys.
// Console translates every paid/Go text model to Chat Completions. This keeps the same stream
// and usage handling for all makers. Free-tier chat models require OpenCode itself and are left
// out. Go's list prices describe allowance consumption, not a per-token charge to estimate.
import * as z from "zod";

import type { Catalog, CatalogModel } from "@/server/models/catalog.ts";
import type { ModelGateway } from "@/server/models/gateway.ts";
import type { ModelPricing } from "@/shared/model-pricing.ts";
import { makerOf } from "@/shared/makers.ts";

import { baseUrlOf, createCompatibleGateway } from "./openai-compatible.ts";

type OpenCodeHost = "opencode-zen" | "opencode-go";
const rate = z.number().nonnegative();
const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      canonical_id: z.string().optional(),
      type: z.string().optional(),
      modalities: z.object({ output: z.array(z.string()).optional() }).optional(),
      capabilities: z
        .object({
          reasoning: z.object({ supported: z.boolean().optional() }).optional(),
          tools: z.object({ supported: z.boolean().optional() }).optional(),
        })
        .optional(),
      limit: z
        .object({
          input: z.number().int().positive().optional(),
          context: z.number().int().positive().optional(),
        })
        .optional(),
      cost: z
        .object({
          text: z
            .object({
              input: z
                .object({
                  price: rate.optional(),
                  cache: z.object({ read: rate.optional(), write: rate.optional() }).optional(),
                })
                .optional(),
              output: z.object({ price: rate.optional() }).optional(),
            })
            .optional(),
          multipliers: z.array(z.unknown()).optional(),
        })
        .optional(),
    }),
  ),
});

type Listed = z.infer<typeof modelsSchema>["data"][number];

function pricingOf(model: Listed): ModelPricing | undefined {
  const text = model.cost?.text;
  // Scheduled/long-context multipliers are reported in the API's charge; a flat rate would
  // misstate them if that response had no cost. Only estimate the uncomplicated text rates.
  if (!text || model.cost?.multipliers?.length) return undefined;
  const input = text.input?.price;
  const output = text.output?.price;
  if (input === undefined || output === undefined) return undefined;
  const cache = text.input?.cache;
  return {
    input: input / 1_000_000,
    output: output / 1_000_000,
    ...(cache?.read !== undefined && { cacheRead: cache.read / 1_000_000 }),
    ...(cache?.write !== undefined && { cacheWrite: cache.write / 1_000_000 }),
  };
}

export function createOpenCodeAdapters(
  host: OpenCodeHost,
  fetchFn: typeof fetch = fetch,
): {
  catalog: Catalog;
  gateway: ModelGateway;
} {
  const catalog: Catalog = {
    async list(token, signal) {
      if (!token.access) throw new Error("the connection has no API key");
      const res = await fetchFn(`${baseUrlOf(host, token)}/v1/models`, {
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
      const models = new Map<string, CatalogModel>();
      for (const model of body.data.data) {
        if (model.type && model.type !== "chat") continue;
        if (model.modalities?.output && !model.modalities.output.includes("text")) continue;
        if (model.capabilities?.tools?.supported === false) continue;
        const text = model.cost?.text;
        if (
          /(?:^|-)free(?:-|$)/i.test(model.id) ||
          (text?.input?.price === 0 && text.output?.price === 0)
        )
          continue;
        if (models.has(model.id)) continue;
        const contextWindow = model.limit?.input ?? model.limit?.context;
        const reasoning = model.capabilities?.reasoning?.supported;
        const maker = makerOf(null, model.canonical_id ?? model.id);
        const pricing = host === "opencode-zen" ? pricingOf(model) : undefined;
        models.set(model.id, {
          id: model.id,
          name: model.name || model.id,
          ...(contextWindow && { contextWindow }),
          ...(reasoning !== undefined && { reasoning }),
          ...(maker && { maker }),
          ...(pricing && { pricing }),
        });
      }
      return [...models.values()];
    },
  };
  const compatible = createCompatibleGateway(host, fetchFn);
  const gateway: ModelGateway = {
    async *stream(token, request, signal) {
      if (!token.access) throw new Error("the connection has no API key");
      if (!request.sessionId) throw new Error("OpenCode requests need a session id");
      yield* compatible.stream(
        {
          ...token,
          proxy: {
            baseUrl: `${baseUrlOf(host, token)}/openai/v1`,
            headers: { ...token.proxy?.headers, "x-opencode-session": request.sessionId },
          },
        },
        request,
        signal,
      );
    },
  };
  return { catalog, gateway };
}

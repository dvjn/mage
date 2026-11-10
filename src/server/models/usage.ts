// Preserve the provider's charge when reported; otherwise estimate once from the rates known
// at call time. Calls with no rate stay unpriced, including subscription sign-ins.
import type { LanguageModelUsage } from "ai";
import * as z from "zod";

import { estimateCost, type ModelPricing } from "@/shared/model-pricing.ts";
import type { Usage } from "@/shared/threads/events.ts";

const rawUsageSchema = z.object({
  cost: z.number().nonnegative().optional(),
  opencode: z
    .object({
      estimated: z.boolean().optional(),
      tokens: z
        .object({
          input: z.number().int().nonnegative(),
          output: z.number().int().nonnegative(),
          cache_read: z.number().int().nonnegative().optional(),
          cache_write_5m: z.number().int().nonnegative().optional(),
          cache_write_1h: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  cache_creation: z
    .object({ ephemeral_1h_input_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});
const metadataSchema = z.object({
  gateway: z.object({ cost: z.union([z.number(), z.string()]) }).optional(),
});

export function providerUsage(usage: LanguageModelUsage, metadata?: unknown): Usage {
  const raw = rawUsageSchema.safeParse(usage.raw);
  const gateway = metadataSchema.safeParse(metadata);
  const gatewayCost = gateway.success ? gateway.data.gateway?.cost : undefined;
  const charged =
    raw.success && raw.data.cost !== undefined
      ? raw.data.cost
      : gatewayCost !== undefined && String(gatewayCost).trim() !== ""
        ? Number(gatewayCost)
        : undefined;
  const cache = usage.inputTokenDetails;
  const billed = raw.success ? raw.data.opencode?.tokens : undefined;
  const read = billed?.cache_read ?? cache.cacheReadTokens;
  const write1h =
    billed?.cache_write_1h ??
    (raw.success ? raw.data.cache_creation?.ephemeral_1h_input_tokens : undefined);
  const write =
    billed && (billed.cache_write_5m !== undefined || billed.cache_write_1h !== undefined)
      ? (billed.cache_write_5m ?? 0) + (billed.cache_write_1h ?? 0)
      : cache.cacheWriteTokens;
  return {
    inputTokens: billed ? billed.input + (read ?? 0) + (write ?? 0) : (usage.inputTokens ?? 0),
    outputTokens: billed?.output ?? usage.outputTokens ?? 0,
    ...(read && { cacheReadTokens: read }),
    ...(write && { cacheWriteTokens: write }),
    ...(write1h && { cacheWrite1hTokens: write1h }),
    ...(charged !== undefined &&
      Number.isFinite(charged) &&
      charged >= 0 && {
        cost: {
          usd: charged,
          source: raw.success && raw.data.opencode?.estimated ? "estimated" : "provider",
        },
      }),
  };
}

export function pricedUsage(usage: Usage, pricing?: ModelPricing): Usage {
  if (usage.cost || !pricing) return usage;
  const usd = estimateCost(pricing, usage);
  return usd === undefined ? usage : { ...usage, cost: { usd, source: "estimated" } };
}

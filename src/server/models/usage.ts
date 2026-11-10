// Preserve the provider's charge when reported; otherwise estimate once from the rates known
// at call time. Calls with no rate stay unpriced, including subscription sign-ins.
import type { LanguageModelUsage } from "ai";
import * as z from "zod";

import { estimateCost, type ModelPricing } from "@/shared/model-pricing.ts";
import type { Usage } from "@/shared/threads/events.ts";

const rawUsageSchema = z.object({
  cost: z.number().nonnegative().optional(),
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
  const write1h = raw.success ? raw.data.cache_creation?.ephemeral_1h_input_tokens : undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cache.cacheReadTokens && { cacheReadTokens: cache.cacheReadTokens }),
    ...(cache.cacheWriteTokens && { cacheWriteTokens: cache.cacheWriteTokens }),
    ...(write1h && { cacheWrite1hTokens: write1h }),
    ...(charged !== undefined &&
      Number.isFinite(charged) &&
      charged >= 0 && {
        cost: { usd: charged, source: "provider" },
      }),
  };
}

export function pricedUsage(usage: Usage, pricing?: ModelPricing): Usage {
  if (usage.cost || !pricing) return usage;
  const usd = estimateCost(pricing, usage);
  return usd === undefined ? usage : { ...usage, cost: { usd, source: "estimated" } };
}

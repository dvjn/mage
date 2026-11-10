// Standard text-generation rates in USD per token. Long-context tiers replace the rates for
// the whole call once its input exceeds the threshold; these are estimates, not invoices.
import * as z from "zod";

const rate = z.number().nonnegative();
const ratesSchema = z.object({
  input: rate,
  output: rate,
  cacheRead: rate.optional(),
  cacheWrite: rate.optional(),
  cacheWrite1h: rate.optional(),
});

export const modelPricingSchema = ratesSchema.extend({
  tiers: z.array(ratesSchema.partial().extend({ above: z.number().int().positive() })).optional(),
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

export function estimateCost(
  pricing: ModelPricing,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite1hTokens?: number;
  },
): number | undefined {
  let rates = pricing;
  for (const tier of [...(pricing.tiers ?? [])].sort((a, b) => a.above - b.above)) {
    if (usage.inputTokens > tier.above) rates = { ...rates, ...tier };
  }
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const write1h = usage.cacheWrite1hTokens ?? 0;
  const plain = usage.inputTokens - read - write;
  if (plain < 0 || write1h > write) return undefined;
  if (read > 0 && rates.cacheRead === undefined) return undefined;
  if (write > write1h && rates.cacheWrite === undefined) return undefined;
  if (write1h > 0 && rates.cacheWrite1h === undefined) return undefined;
  const usd =
    plain * rates.input +
    usage.outputTokens * rates.output +
    read * (rates.cacheRead ?? 0) +
    (write - write1h) * (rates.cacheWrite ?? 0) +
    write1h * (rates.cacheWrite1h ?? 0);
  return Number.isFinite(usd) ? usd : undefined;
}

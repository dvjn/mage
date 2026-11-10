// Adds usage without losing cache counts or the costs recorded when each call completed.
import * as z from "zod";

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  cacheWrite1hTokens: z.number().int().nonnegative().optional(),
  cost: z
    .object({
      usd: z.number().nonnegative(),
      source: z.enum(["provider", "estimated", "mixed"]),
      partial: z.literal(true).optional(),
      backfilled: z.literal(true).optional(),
      cacheUnknown: z.literal(true).optional(),
      ratesAsOf: z.iso.date().optional(),
    })
    .optional(),
});

export type Usage = z.infer<typeof usageSchema>;

export function addUsage(total: Usage, used: Usage) {
  const hadUsage = total.inputTokens + total.outputTokens > 0;
  const hasUsage = used.inputTokens + used.outputTokens > 0;
  const previous = total.cost;
  if (used.cost) {
    total.cost = {
      usd: (previous?.usd ?? 0) + used.cost.usd,
      source: previous && previous.source !== used.cost.source ? "mixed" : used.cost.source,
      ...((previous?.partial || used.cost.partial || (hadUsage && !previous)) && { partial: true }),
      ...((previous?.backfilled || used.cost.backfilled) && { backfilled: true }),
      ...((previous?.cacheUnknown || used.cost.cacheUnknown) && { cacheUnknown: true }),
    };
  } else if (previous && hasUsage) {
    total.cost = { ...previous, partial: true };
  }
  total.inputTokens += used.inputTokens;
  total.outputTokens += used.outputTokens;
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "cacheWrite1hTokens"] as const) {
    if (used[key] !== undefined) total[key] = (total[key] ?? 0) + used[key];
  }
}

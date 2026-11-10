import { describe, expect, it } from "vite-plus/test";

import { estimateCost } from "./model-pricing.ts";

describe("usage cost", () => {
  const rates = {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite: 0.00000375,
    cacheWrite1h: 0.000006,
  };

  it("charges cached tokens separately without counting them twice", () => {
    expect(
      estimateCost(rates, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        cacheWrite1hTokens: 50,
      }),
    ).toBeCloseTo(
      200 * rates.input +
        100 * rates.output +
        600 * rates.cacheRead +
        150 * rates.cacheWrite +
        50 * rates.cacheWrite1h,
    );
  });

  it("applies long-context rates to the whole call, strictly above the threshold", () => {
    const pricing = {
      input: 0.000002,
      output: 0.000012,
      tiers: [{ above: 200000, input: 0.000004, output: 0.000018 }],
    };
    expect(estimateCost(pricing, { inputTokens: 200000, outputTokens: 100 })).toBeCloseTo(0.4012);
    expect(estimateCost(pricing, { inputTokens: 200001, outputTokens: 100 })).toBeCloseTo(0.801804);
  });

  it("keeps missing cache prices unknown and accepts explicitly free rates", () => {
    expect(estimateCost({ input: 0, output: 0 }, { inputTokens: 100, outputTokens: 20 })).toBe(0);
    expect(
      estimateCost(
        { input: 0.1, output: 0.2 },
        { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      ),
    ).toBeUndefined();
    expect(
      estimateCost(rates, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 101 }),
    ).toBeUndefined();
  });
});

import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { pricedUsage, providerUsage } from "./usage.ts";
import { createCompatibleGateway } from "./hosts/openai-compatible.ts";

function sdkUsage(raw: LanguageModelUsage["raw"]): LanguageModelUsage {
  return {
    inputTokens: 1000,
    outputTokens: 100,
    totalTokens: 1100,
    inputTokenDetails: { noCacheTokens: 300, cacheReadTokens: 500, cacheWriteTokens: 200 },
    outputTokenDetails: { textTokens: 80, reasoningTokens: 20 },
    raw,
  };
}

describe("provider usage", () => {
  it("uses OpenCode's billed cache counts and preserves whether BYOK cost is estimated", () => {
    const usage = providerUsage(
      sdkUsage({
        cost: 0.005,
        opencode: {
          estimated: true,
          tokens: {
            input: 1200,
            output: 300,
            cache_read: 8000,
            cache_write_5m: 300,
            cache_write_1h: 50,
          },
        },
      }),
    );
    expect(usage).toEqual({
      inputTokens: 9550,
      outputTokens: 300,
      cacheReadTokens: 8000,
      cacheWriteTokens: 350,
      cacheWrite1hTokens: 50,
      cost: { usd: 0.005, source: "estimated" },
    });
  });
  it("preserves the API's monetary cost through an OpenRouter stream", async () => {
    const body =
      [
        {
          id: "chat-1",
          choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
        },
        {
          id: "chat-1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_tokens_details: { cached_tokens: 500 },
            cost: 0.0042,
          },
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    const gateway = createCompatibleGateway(
      "openrouter",
      async () =>
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const events = [];
    for await (const event of gateway.stream(
      { access: "key", accountId: null },
      {
        model: "anthropic/claude-sonnet-4.6",
        instructions: "Reply briefly.",
        messages: [{ role: "user", text: "Hello" }],
        maxSteps: 1,
        sessionId: "t1",
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.find((event) => event.type === "step-end")).toEqual({
      type: "step-end",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cost: { usd: 0.0042, source: "provider" },
      },
    });
  });
  it("prefers a reported cost, including zero, over a rate estimate", () => {
    for (const cost of [0, 0.005]) {
      const usage = providerUsage(
        sdkUsage({ cost, cache_creation: { ephemeral_1h_input_tokens: 50 } }),
      );
      expect(usage).toMatchObject({
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
        cacheWrite1hTokens: 50,
        cost: { usd: cost, source: "provider" },
      });
      expect(pricedUsage(usage, { input: 1, output: 1 })).toBe(usage);
    }
  });

  it("uses gateway metadata when supplied and refuses invalid monetary amounts", () => {
    expect(providerUsage(sdkUsage(undefined), { gateway: { cost: "0.003" } }).cost).toEqual({
      usd: 0.003,
      source: "provider",
    });
    for (const cost of [-1, "not a number", "Infinity"]) {
      expect(providerUsage(sdkUsage(undefined), { gateway: { cost } }).cost).toBeUndefined();
    }
  });

  it("estimates standard usage only when rates are known", () => {
    const usage = { inputTokens: 1000, outputTokens: 100 };
    expect(pricedUsage(usage)).toBe(usage);
    const priced = pricedUsage(usage, { input: 0.000003, output: 0.000015 });
    expect(priced.cost?.source).toBe("estimated");
    expect(priced.cost?.usd).toBeCloseTo(0.0045);
  });
});

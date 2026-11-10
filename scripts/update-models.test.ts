import { describe, expect, it } from "vite-plus/test";

import {
  hostModelId,
  modelData,
  priceData,
  refusal,
  sortedJson,
  stampLicense,
} from "./update-models.ts";

const upstream = {
  sample_spec: { mode: "chat", litellm_provider: "openai" },
  "claude-big": {
    mode: "chat",
    litellm_provider: "anthropic",
    max_input_tokens: 1000000,
    supports_reasoning: true,
    input_cost_per_token: 0.000003,
  },
  "claude-old": { mode: "chat", litellm_provider: "anthropic", deprecation_date: "2026-01-01" },
  "claude-later": { mode: "chat", litellm_provider: "anthropic", deprecation_date: "2027-01-01" },
  "text-embedding-3": { mode: "embedding", litellm_provider: "openai" },
  "ft:gpt-4o": { mode: "chat", litellm_provider: "openai" },
  "groq/openai/gpt-oss-120b": { mode: "chat", litellm_provider: "groq", max_input_tokens: 131072 },
  "us.anthropic.claude-big": { mode: "chat", litellm_provider: "bedrock_converse" },
  "bedrock/us-east-1/anthropic.claude-big": { mode: "chat", litellm_provider: "bedrock" },
  "bedrock/anthropic.claude-big": {
    mode: "chat",
    litellm_provider: "bedrock",
    max_input_tokens: 200000,
  },
  "vertex_ai/claude-big@default": { mode: "chat", litellm_provider: "vertex_ai-anthropic_models" },
  "gemini-big": { mode: "chat", litellm_provider: "vertex_ai-language-models" },
  "perplexity/sonar": { mode: "chat", litellm_provider: "perplexity" },
  "perplexity/llama-2-70b-chat": { mode: "chat", litellm_provider: "perplexity" },
  "together-ai-up-to-4b": { mode: "chat", litellm_provider: "together_ai" },
  "together_ai/meta-llama/Llama-big": { mode: "chat", litellm_provider: "together_ai" },
  "unknown/model": { mode: "chat", litellm_provider: "someone_else" },
};

describe("the model data", () => {
  it("vendors standard USD rates, free tokens, cache rates and long-context tiers", () => {
    const entry = {
      input_cost_per_token: 0,
      output_cost_per_token: 0.000012,
      cache_read_input_token_cost: 0.0000002,
      cache_creation_input_token_cost: 0.000003,
      cache_creation_input_token_cost_above_1hr: 0.000004,
      input_cost_per_token_above_200k_tokens: 0.000004,
      output_cost_per_token_above_200k_tokens: 0.000018,
      cache_read_input_token_cost_above_200k_tokens: 0.0000004,
      input_cost_per_token_batches: 0.000001,
      input_cost_per_token_priority: 0.0000036,
    };
    const pricing = {
      input: 0,
      output: 0.000012,
      cacheRead: 0.0000002,
      cacheWrite: 0.000003,
      cacheWrite1h: 0.000004,
      tiers: [{ above: 200000, input: 0.000004, output: 0.000018, cacheRead: 0.0000004 }],
    };
    expect(priceData(entry)).toEqual(pricing);
    expect(
      modelData({ fresh: { ...entry, mode: "chat", litellm_provider: "openai" } }, "2026-11-10"),
    ).toEqual({ openai: { fresh: { pricing } } });
  });

  it("does not invent prices for missing, negative or non-finite rates", () => {
    expect(priceData({ input_cost_per_token: 0.1 })).toBeUndefined();
    expect(priceData({ input_cost_per_token: -1, output_cost_per_token: 0.1 })).toBeUndefined();
    expect(
      priceData({ input_cost_per_token: Infinity, output_cost_per_token: 0.1 }),
    ).toBeUndefined();
  });
  it("takes each host's chat models still served, by the ids the host knows them by", () => {
    expect(modelData(upstream, "2026-10-25")).toEqual({
      anthropic: {
        "claude-big": { contextWindow: 1000000, reasoning: true },
        "claude-later": {},
      },
      bedrock: {
        "anthropic.claude-big": { contextWindow: 200000 },
        "us.anthropic.claude-big": {},
      },
      groq: { "openai/gpt-oss-120b": { contextWindow: 131072 } },
      perplexity: { sonar: {} },
      together: { "meta-llama/Llama-big": {} },
      vertex: { "claude-big@default": {}, "gemini-big": {} },
    });
  });

  it("strips only a route LiteLLM adds, keeping a host's own segments", () => {
    expect(hostModelId("groq/openai/gpt-oss-120b", "groq")).toBe("openai/gpt-oss-120b");
    expect(hostModelId("vertex_ai/meta/llama-maas", "vertex_ai-llama_models")).toBe(
      "meta/llama-maas",
    );
    expect(hostModelId("azure/eu/gpt-4o", "azure")).toBeNull();
    expect(hostModelId("ft:gpt-4o", "openai")).toBeNull();
  });

  it("refuses data that is empty, loses a host, or shrinks by more than a fifth", () => {
    const five = { anthropic: Object.fromEntries("abcde".split("").map((id) => [id, {}])) };
    expect(refusal(null, {})).toMatch(/empty/);
    expect(refusal(null, five)).toBeNull();
    expect(refusal({ ...five, groq: { x: {} } }, five)).toMatch(/groq/);
    expect(refusal(five, { anthropic: { a: {}, b: {}, c: {} } })).toMatch(
      /3 models where there were 5/,
    );
    expect(refusal(five, { anthropic: { a: {}, b: {}, c: {}, d: {} } })).toBeNull();
  });

  it("is written with every key in order", () => {
    expect(sortedJson({ b: { z: 1, a: 2 }, a: [3, 1] })).toBe(
      '{\n  "a": [\n    3,\n    1\n  ],\n  "b": {\n    "a": 2,\n    "z": 1\n  }\n}\n',
    );
  });

  it("says in its licence where it came from", () => {
    const license = "x\nUpstream commit: old\nUpstream sha256: old\nRetrieved:       old\ny";
    expect(stampLicense(license, "abc", "def", "2026-10-25")).toBe(
      "x\nUpstream commit: abc\nUpstream sha256: def\nRetrieved:       2026-10-25\ny",
    );
  });
});

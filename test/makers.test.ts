import { describe, expect, it } from "vite-plus/test";

import { HOSTS, hostOf } from "@/shared/hosts.ts";
import { makerOf } from "@/shared/makers.ts";

describe("who makes a model", () => {
  it.each([
    // The maker's own API says so for every model it serves.
    ["anthropic", "claude-opus-5-5", "anthropic"],
    ["anthropic", "some-new-name", "anthropic"],
    ["mistral", "open-new-thing", "mistral"],
    ["codex", "gpt-6-luna", "openai"],
    // Hosts that give ids as `maker/model`.
    ["openrouter", "anthropic/claude-sonnet-5", "anthropic"],
    ["openrouter", "x-ai/grok-4.3", "xai"],
    ["openrouter", "moonshotai/kimi-k3", "moonshot"],
    ["together", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta"],
    ["together", "zai-org/GLM-5.3", "zhipu"],
    ["vercel", "alibaba/qwen-3-235b", "qwen"],
    ["huggingface", "deepseek-ai/DeepSeek-V4-Pro", "deepseek"],
    ["cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "meta"],
    // Bedrock's `maker.model`, with or without a geography.
    ["bedrock", "us.anthropic.claude-opus-5-5", "anthropic"],
    ["bedrock", "global.anthropic.claude-sonnet-5", "anthropic"],
    ["bedrock", "meta.llama4-maverick-17b-instruct-v1:0", "meta"],
    ["bedrock", "amazon.nova-pro-v1:0", "amazon"],
    ["bedrock", "openai.gpt-oss-120b-1:0", "openai"],
    // Names alone, wherever they are served.
    ["groq", "openai/gpt-oss-120b", "openai"],
    ["groq", "gpt-oss-20b", "openai"],
    ["groq", "llama-3.3-70b-versatile", "meta"],
    ["cerebras", "qwen-3-235b-a22b", "qwen"],
    ["fireworks", "accounts/fireworks/models/deepseek-v3p1", "deepseek"],
    ["vertex", "gemini-3.8-flash", "google"],
    ["vertex", "claude-opus-5-5@default", "anthropic"],
    ["azure", "gpt-6-sol", "openai"],
    ["azure", "Phi-4-reasoning", "microsoft"],
    ["ollama", "gemma-4-26b", "google"],
    // Names that look like Bedrock's but are not.
    ["openai", "gpt-4.1", "openai"],
    ["custom", "claude-3.5-sonnet", "anthropic"],
    ["custom", "deepseek-v3.2", "deepseek"],
    // No one can tell.
    ["custom", "my-finetune", null],
    ["bedrock", "writer.palmyra-x5-v1:0", null],
  ] as const)("on %s, %s is %s's", (host, id, maker) => {
    expect(makerOf(hostOf(host), id)).toBe(maker);
  });

  it("takes the host's own word for it first", () => {
    expect(makerOf(HOSTS.groq, "some-model", { maker: "Meta" })).toBe("meta");
    expect(makerOf(HOSTS.groq, "llama-model", { maker: "unknown-org" })).toBe("meta");
  });

  it("with no host, goes by the id", () => {
    expect(makerOf(null, "claude-gone")).toBe("anthropic");
    expect(makerOf(null, "echo")).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { ModelGateway, ModelRequest, ModelToken } from "@/server/models/gateway.ts";

import { createBedrockGateway } from "./amazon-bedrock.ts";
import { createAzureGateway } from "./azure.ts";
import { createOpenAIKeyGateway } from "./openai-api.ts";

// Records each request's body and refuses it, so that only what was asked for is seen.
function refusingFetch() {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
    return Response.json({ message: "no" }, { status: 400 });
  }) as typeof fetch;
  return { fetchFn, bodies };
}

const request: Omit<ModelRequest, "beforeStep" | "model"> = {
  instructions: "You are the agent.",
  messages: [
    { role: "user", text: "[Ada Lovelace] How do engines compute?" },
    { role: "assistant", text: "With gears." },
    { role: "user", text: "[Grace Hopper] // lunch?" },
    { role: "user", text: "[Ada Lovelace] And looms?" },
  ],
  maxSteps: 5,
  sessionId: "thread-1",
  tools: [{ id: "thread.rename", description: "Rename.", inputSchema: { type: "object" } }],
};

async function ask(gateway: ModelGateway, token: ModelToken, model: string) {
  const events = gateway.stream(token, { ...request, model }, new AbortController().signal);
  await expect(
    (async () => {
      for await (const _ of events);
    })(),
  ).rejects.toThrow();
}

const CACHE_POINT = { cachePoint: { type: "default" } };

describe("Bedrock prompt cache", () => {
  const token = { access: "bedrock-key", accountId: null, settings: { region: "us-east-1" } };

  it("marks Claude's request after its system prompt, the agent's last reply and the last message", async () => {
    const { fetchFn, bodies } = refusingFetch();

    await ask(createBedrockGateway(fetchFn), token, "global.anthropic.claude-haiku-5-5");

    const [body] = bodies as [
      { system: unknown[]; messages: { content: unknown[] }[]; toolConfig: unknown },
    ];
    expect(body.system).toEqual([{ text: "You are the agent." }, CACHE_POINT]);
    // The people's two messages are one turn, marked once at its end.
    expect(body.messages.map((message) => message.content)).toEqual([
      [{ text: "[Ada Lovelace] How do engines compute?" }],
      [{ text: "With gears." }, CACHE_POINT],
      [{ text: "[Grace Hopper] // lunch?" }, { text: "[Ada Lovelace] And looms?" }, CACHE_POINT],
    ]);
    expect(JSON.stringify(body.toolConfig)).not.toContain("cachePoint");
  });

  it("leaves the other models' requests unmarked", async () => {
    const { fetchFn, bodies } = refusingFetch();

    await ask(createBedrockGateway(fetchFn), token, "global.openai.gpt-6.1-terra");

    expect(JSON.stringify(bodies[0])).not.toContain("cachePoint");
  });
});

describe("OpenAI prompt cache", () => {
  it("keys an API key's cache by the thread", async () => {
    const { fetchFn, bodies } = refusingFetch();

    await ask(createOpenAIKeyGateway(fetchFn), { access: "sk-key", accountId: null }, "gpt-5.5");

    expect(bodies[0]).toMatchObject({ prompt_cache_key: "thread-1" });
  });

  it("keys an Azure resource's cache by the thread, and marks Claude's there", async () => {
    const { fetchFn, bodies } = refusingFetch();
    const token = {
      access: "azure-key",
      accountId: null,
      settings: { endpoint: "https://team.openai.azure.com" },
    };
    const gateway = createAzureGateway(fetchFn);

    await ask(gateway, token, "gpt-5.5");
    await ask(gateway, token, "claude-sonnet-5-5");

    const [openai, claude] = bodies as [Record<string, unknown>, { system: unknown[] }];
    expect(openai).toMatchObject({ prompt_cache_key: "thread-1" });
    expect(claude.system).toEqual([
      { type: "text", text: "You are the agent.", cache_control: { type: "ephemeral" } },
    ]);
  });
});

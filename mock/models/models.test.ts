import { describe, expect, it } from "vite-plus/test";

import type {
  ModelEvent,
  ModelGateway,
  ModelMessage,
  ModelRequest,
} from "@/server/models/gateway.ts";
import { ModelError } from "@/server/models/gateway.ts";
import {
  createAnthropicKeyCatalog,
  createAnthropicKeyGateway,
} from "@/server/models/hosts/anthropic-api.ts";
import { createGeminiCatalog, createGeminiGateway } from "@/server/models/hosts/google-gemini.ts";
import {
  createOpenAIKeyCatalog,
  createOpenAIKeyGateway,
} from "@/server/models/hosts/openai-api.ts";
import {
  createCompatibleCatalog,
  createCompatibleGateway,
} from "@/server/models/hosts/openai-compatible.ts";

import { modelsStandIn } from "./models.ts";

const ORIGIN = "http://models.test";

const standIn = modelsStandIn({
  pieceMs: 0,
  lists: {
    "/v1": [{ id: "llama-echo", owner: "meta" }],
    "/openai/v1": [{ id: "gpt-5-echo" }],
    "/anthropic/v1": [{ id: "claude-echo-5", name: "Claude Echo" }],
    "/google/v1beta": [{ id: "gemini-echo" }],
  },
});
const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
  standIn(new Request(input, init))) as typeof fetch;

// Each provider as Mage reaches it, through a proxy to the stand-in.
// Gemini has no event for a failure mid-reply; its stream breaks off instead.
const providers: {
  name: string;
  gateway: ModelGateway;
  base: string;
  model: string;
  failureSaid?: false;
}[] = [
  {
    name: "OpenAI Chat Completions",
    gateway: createCompatibleGateway("custom", fetchFn),
    base: "/v1",
    model: "llama-echo",
  },
  {
    name: "Anthropic Messages",
    gateway: createAnthropicKeyGateway(fetchFn),
    base: "/anthropic/v1",
    model: "claude-echo-5",
  },
  {
    name: "OpenAI Responses",
    gateway: createOpenAIKeyGateway(fetchFn),
    base: "/openai/v1",
    model: "gpt-5-echo",
  },
  {
    name: "Gemini",
    gateway: createGeminiGateway(fetchFn),
    base: "/google/v1beta",
    model: "gemini-echo",
    failureSaid: false,
  },
];

const tools = [
  {
    id: "notes.add",
    description: "Add a note.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
];

function requestOf(model: string, messages: ModelMessage[], more: Partial<ModelRequest> = {}) {
  return {
    model,
    instructions: "You are a stand-in.",
    messages,
    maxSteps: 5,
    sessionId: "thread-1",
    tools,
    ...more,
  } satisfies ModelRequest;
}

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: ModelEvent[], type: "delta" | "reasoning" = "delta") {
  return events.flatMap((event) => (event.type === type ? [event.text] : [])).join("");
}

async function failure(stream: AsyncIterable<ModelEvent>) {
  try {
    await collect(stream);
  } catch (err) {
    return err as Error;
  }
  throw new Error("the reply did not fail");
}

describe.each(providers)("the stand-in over $name", ({ gateway, base, model, failureSaid }) => {
  const token = {
    access: "sk-stand-in",
    accountId: null,
    proxy: { baseUrl: `${ORIGIN}${base}`, headers: {} },
  };
  const stream = (messages: ModelMessage[], more?: Partial<ModelRequest>) =>
    gateway.stream(token, requestOf(model, messages, more), new AbortController().signal);

  it("streams its words and how many messages it read", async () => {
    const events = await collect(stream([{ role: "user", text: "Hello" }]));
    expect(events[0]).toEqual({ type: "step-start" });
    expect(textOf(events)).toBe("I have read 1 message, and so the engine turns its wheels and");
    expect(events.filter((event) => event.type === "delta").length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: "step-end" });
  });

  it("calls a tool a line asks for, by its id, and says what it gave back", async () => {
    const asked = '^tool notes.add {"title":"Looms"}';
    const events = await collect(stream([{ role: "user", text: asked }]));
    const call = events.find((event) => event.type === "tool-call");
    expect(call).toMatchObject({ toolId: "notes.add", input: { title: "Looms" } });

    const after = await collect(
      stream([
        { role: "user", text: asked },
        { role: "assistant", text: "", toolCalls: [call as never] },
        {
          role: "tool",
          results: [
            {
              callId: (call as { callId: string }).callId,
              toolId: "notes.add",
              output: { ok: true, value: { id: "n1" } },
            },
          ],
        },
      ]),
    );
    expect(textOf(after)).toContain('said: ok {"id":"n1"}');
    expect(after.some((event) => event.type === "tool-call")).toBe(false);
  });

  it("says it cannot use a tool it is not offered", async () => {
    const events = await collect(stream([{ role: "user", text: "^tool looms.weave {}" }]));
    expect(textOf(events)).toContain("I cannot use looms.weave here.");
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
  });

  it("replies with what follows a say line", async () => {
    const events = await collect(stream([{ role: "user", text: "^say\nPunched cards." }]));
    expect(textOf(events)).toBe("Punched cards.");
  });

  it("thinks before it answers when asked to", async () => {
    const events = await collect(
      stream([{ role: "user", text: "Think it over" }], { effort: "low" }),
    );
    expect(textOf(events, "reasoning")).toContain("Considering the gears");
  });

  it("fails mid-reply with the text a fail line gives", async () => {
    const err = await failure(stream([{ role: "user", text: "^fail The looms jammed." }]));
    if (failureSaid !== false) expect(err.message).toContain("The looms jammed.");
  });

  it("refuses with a status, as a limit when it is 429", async () => {
    const err = await failure(
      stream([{ role: "user", text: "^status 429 retry-after=0 Slow down" }]),
    );
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("limit");
    expect((err as ModelError).detail).toContain("Slow down");
  });

  it("refuses a key it is told to, as a sign-in that no longer works", async () => {
    const err = await failure(stream([{ role: "user", text: "^status 401 Bad key" }]));
    expect((err as ModelError).kind).toBe("auth");
  });

  it("drops the connection after its words", async () => {
    const events: ModelEvent[] = [];
    let err: unknown;
    try {
      for await (const event of stream([{ role: "user", text: "^drop" }])) events.push(event);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect(textOf(events)).toContain("I have read 1 message");
    expect(events.some((event) => event.type === "step-end")).toBe(false);
  });

  it("waits before it starts when told to stall", async () => {
    const started = Date.now();
    await collect(stream([{ role: "user", text: "^stall 150" }]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe("the stand-in's model lists", () => {
  const at = (base: string) => ({
    access: "sk-stand-in",
    accountId: null,
    proxy: { baseUrl: `${ORIGIN}${base}`, headers: {} },
  });
  const signal = new AbortController().signal;

  it("answers each provider's list in its shape, by the prefix it is under", async () => {
    expect(await createCompatibleCatalog("custom", fetchFn).list(at("/v1"), signal)).toEqual([
      expect.objectContaining({ id: "llama-echo" }),
    ]);
    expect(await createOpenAIKeyCatalog(fetchFn).list(at("/openai/v1"), signal)).toEqual([
      expect.objectContaining({ id: "gpt-5-echo" }),
    ]);
    expect(await createAnthropicKeyCatalog(fetchFn).list(at("/anthropic/v1"), signal)).toEqual([
      expect.objectContaining({ id: "claude-echo-5", name: "Claude Echo" }),
    ]);
    expect(await createGeminiCatalog(fetchFn).list(at("/google/v1beta"), signal)).toEqual([
      expect.objectContaining({ id: "gemini-echo" }),
    ]);
  });

  it("has no list under a prefix it was not given", async () => {
    await expect(
      createCompatibleCatalog("custom", fetchFn).list(at("/nowhere"), signal),
    ).rejects.toThrow();
  });
});

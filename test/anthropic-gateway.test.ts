import { describe, expect, it } from "vite-plus/test";

import { createAnthropicKeyGateway } from "@/adapters/anthropic-api.ts";
import { type ModelEvent, ModelError, type ModelRequest } from "@/ports/model-gateway.ts";

const token = { access: "sk-ant-key", accountId: null };

// One Messages stream as the Anthropic API sends it, as server-sent events.
function sse(events: object[]) {
  const body = events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function reply(text: string[], usage = { input_tokens: 12, output_tokens: 4 }) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.map((delta) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: "message_stop" },
  ];
}

// A reply that thinks first.
function thought(thinking: string[], text: string[]) {
  const [start, , , ...rest] = reply([]);
  return [
    start!,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    ...thinking.map((delta) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: delta },
    })),
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ...text.map((delta) => ({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: delta },
    })),
    { type: "content_block_stop", index: 1 },
    ...rest,
  ];
}

function recordingFetch(responses: Response[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: (await request.json()) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (!response) throw new Error("no more responses");
    return response;
  }) as typeof fetch;
  return { fetchFn, requests };
}

const request: Omit<ModelRequest, "beforeStep"> = {
  model: "claude-sonnet-4-5",
  instructions: "You are the agent in Mage.",
  messages: [
    { role: "user", text: "[Ada Lovelace] How do engines compute?" },
    { role: "assistant", text: "With gears." },
    { role: "user", text: "[Grace Hopper] And looms?" },
  ],
  maxSteps: 5,
  sessionId: "thread-1",
};

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Anthropic API key gateway", () => {
  it("asks the Messages API with the key", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    await collect(
      createAnthropicKeyGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    const [sent] = requests;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(Object.fromEntries(sent!.headers)).toMatchObject({
      "x-api-key": "sk-ant-key",
      "anthropic-version": "2023-06-01",
    });
    expect(sent?.headers.has("authorization")).toBe(false);
    expect(sent?.headers.get("user-agent")).toMatch(/^mage\b/);
    expect(sent?.body).toMatchObject({
      model: "claude-sonnet-4-5",
      stream: true,
      system: [{ type: "text", text: "You are the agent in Mage." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "[Ada Lovelace] How do engines compute?" }],
        },
        { role: "assistant", content: [{ type: "text", text: "With gears." }] },
        { role: "user", content: [{ type: "text", text: "[Grace Hopper] And looms?" }] },
      ],
    });
  });

  it("asks a connection's proxy instead, with its headers added", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Hi"]))]);
    const proxy = { baseUrl: "https://proxy.example.com/v1", headers: { "x-team": "blue" } };

    await collect(
      createAnthropicKeyGateway(fetchFn).stream(
        { ...token, proxy },
        request,
        new AbortController().signal,
      ),
    );

    expect(requests[0]?.url).toBe("https://proxy.example.com/v1/messages");
    expect(Object.fromEntries(requests[0]!.headers)).toMatchObject({
      "x-api-key": "sk-ant-key",
      "x-team": "blue",
    });
  });

  it("streams the reply as steps, deltas and usage", async () => {
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    const events = await collect(
      createAnthropicKeyGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "step-start" },
      { type: "delta", text: "Punched" },
      { type: "delta", text: " cards." },
      { type: "step-end", usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
  });

  it("asks a model to think at the effort, and streams its thinking", async () => {
    const { fetchFn, requests } = recordingFetch([sse(thought(["Gears", " turn."], ["Gears."]))]);

    const events = await collect(
      createAnthropicKeyGateway(fetchFn).stream(
        token,
        { ...request, model: "claude-opus-5-5", effort: "low" },
        new AbortController().signal,
      ),
    );

    expect(requests[0]?.body).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(events).toEqual([
      { type: "step-start" },
      { type: "reasoning", text: "Gears" },
      { type: "reasoning", text: " turn." },
      { type: "delta", text: "Gears." },
      { type: "step-end", usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
  });

  it("gives an older model a thinking budget, and a model without an effort no thinking", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Hi"])), sse(reply(["Hi"]))]);
    const gateway = createAnthropicKeyGateway(fetchFn);
    const signal = new AbortController().signal;

    await collect(gateway.stream(token, { ...request, effort: "medium" }, signal));
    await collect(gateway.stream(token, request, signal));

    expect(requests[0]?.body.thinking).toMatchObject({ type: "enabled" });
    expect(requests[1]?.body).not.toHaveProperty("thinking");
  });

  it("throws what the API says when it refuses the request", async () => {
    // A refusal that is not worth retrying.
    const refusal = new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "model: unknown model" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const { fetchFn } = recordingFetch([refusal, refusal.clone(), refusal.clone()]);

    await expect(
      collect(
        createAnthropicKeyGateway(fetchFn).stream(token, request, new AbortController().signal),
      ),
    ).rejects.toThrow(/unknown model/);
  });

  it("reads a limit's reset and explaining headers from a 429 with an empty body", async () => {
    const limited = () =>
      new Response(null, {
        status: 429,
        headers: {
          "retry-after": "0",
          "request-id": "req_1",
          "anthropic-ratelimit-requests-remaining": "10",
          "anthropic-ratelimit-requests-reset": "2026-10-24T10:00:30Z",
          "anthropic-ratelimit-input-tokens-remaining": "0",
          "anthropic-ratelimit-input-tokens-reset": "2026-10-24T10:00:20Z",
          "anthropic-ratelimit-output-tokens-remaining": "0",
          "anthropic-ratelimit-output-tokens-reset": "2026-10-24T10:00:40Z",
          "x-unrelated": "1",
        },
      });
    const { fetchFn } = recordingFetch([limited(), limited(), limited()]);

    const failed = await collect(
      createAnthropicKeyGateway(fetchFn).stream(token, request, new AbortController().signal),
    ).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(ModelError);
    const { kind, resetsAt, detail } = failed as ModelError;
    expect(kind).toBe("limit");
    // The latest of the limits used up; the request limit is not.
    expect(resetsAt).toEqual(new Date("2026-10-24T10:00:40Z"));
    expect(detail.split("\n")).toEqual([
      "429 (empty body)",
      "anthropic-ratelimit-input-tokens-remaining: 0",
      "anthropic-ratelimit-input-tokens-reset: 2026-10-24T10:00:20Z",
      "anthropic-ratelimit-output-tokens-remaining: 0",
      "anthropic-ratelimit-output-tokens-reset: 2026-10-24T10:00:40Z",
      "anthropic-ratelimit-requests-remaining: 10",
      "anthropic-ratelimit-requests-reset: 2026-10-24T10:00:30Z",
      "request-id: req_1",
      "retry-after: 0",
    ]);
  });

  it.each([
    [401, { type: "authentication_error", message: "invalid x-api-key" }, "auth"],
    [404, { type: "not_found_error", message: "model: claude-gone" }, "model"],
    [400, { type: "invalid_request_error", message: "model: unknown model" }, "model"],
    [529, { type: "overloaded_error", message: "Overloaded" }, "network"],
  ])("sorts a %i refusal as a %s failure", async (status, error, kind) => {
    const refusal = () =>
      Response.json({ type: "error", error }, { status, headers: { "retry-after": "0" } });
    const { fetchFn } = recordingFetch([refusal(), refusal(), refusal()]);

    await expect(
      collect(
        createAnthropicKeyGateway(fetchFn).stream(token, request, new AbortController().signal),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ kind, detail: `${status} ${error.message}\nretry-after: 0` }),
    );
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);
    const events: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of createAnthropicKeyGateway(fetchFn).stream(
          token,
          request,
          controller.signal,
        )) {
          events.push(event);
          if (event.type === "delta") controller.abort(new Error("stopped"));
        }
      })(),
    ).rejects.toThrow();
    expect(events.filter((event) => event.type === "step-end")).toEqual([]);
  });

  it("needs a key rather than falling back to one from the environment", async () => {
    const { fetchFn, requests } = recordingFetch([]);

    await expect(
      collect(
        createAnthropicKeyGateway(fetchFn).stream(
          { access: "", accountId: null },
          request,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/API key/);
    expect(requests).toEqual([]);
  });
});

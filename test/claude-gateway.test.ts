import { describe, expect, it } from "vite-plus/test";

import { createClaudeGateway } from "@/adapters/anthropic-claude.ts";
import type { ModelEvent, ModelRequest } from "@/ports/model-gateway.ts";

const token = { access: "access-token", accountId: null };

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

describe("Claude gateway", () => {
  it("asks the Messages API with the OAuth token as a bearer token", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    await collect(
      createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    const [sent] = requests;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(Object.fromEntries(sent!.headers)).toMatchObject({
      authorization: "Bearer access-token",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(sent?.headers.has("x-api-key")).toBe(false);
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

  it("never names Claude Code", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Hi"]))]);

    await collect(
      createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    const [sent] = requests;
    expect(sent?.headers.has("x-app")).toBe(false);
    const sentText = JSON.stringify([...sent!.headers, sent!.body]).toLowerCase();
    expect(sentText).not.toMatch(/claude-cli|claude-code|claude code/);
  });

  it("streams the reply as steps, deltas and usage", async () => {
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    const events = await collect(
      createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "step-start" },
      { type: "delta", text: "Punched" },
      { type: "delta", text: " cards." },
      { type: "step-end", usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
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
      collect(createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal)),
    ).rejects.toThrow(/unknown model/);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);
    const events: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of createClaudeGateway(fetchFn).stream(
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

  it("needs an access token rather than falling back to an API key", async () => {
    const { fetchFn, requests } = recordingFetch([]);

    await expect(
      collect(
        createClaudeGateway(fetchFn).stream(
          { access: "", accountId: null },
          request,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/access token/);
    expect(requests).toEqual([]);
  });
});

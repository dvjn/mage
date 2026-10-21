import { describe, expect, it } from "vite-plus/test";

import { createCodexGateway } from "@/adapters/openai-codex.ts";
import { type ModelEvent, ModelError, type ModelRequest } from "@/ports/model-gateway.ts";

const token = { access: "access-token", accountId: "account-1" };

// One Responses stream as the Codex backend sends it, as server-sent events.
function sse(events: object[]) {
  const body = events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function reply(text: string[], usage = { input_tokens: 12, output_tokens: 4 }) {
  let sequence = 0;
  const next = () => (sequence += 1);
  return [
    {
      type: "response.created",
      sequence_number: next(),
      response: { id: "resp_1", created_at: 1760000000, model: "gpt-5.5" },
    },
    {
      type: "response.output_item.added",
      sequence_number: next(),
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
    ...text.map((delta) => ({
      type: "response.output_text.delta",
      sequence_number: next(),
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_item.done",
      sequence_number: next(),
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: text.join(""), annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: next(),
      response: {
        id: "resp_1",
        created_at: 1760000000,
        model: "gpt-5.5",
        usage: {
          ...usage,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
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
  model: "gpt-5.5",
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

describe("Codex gateway", () => {
  it("asks the Codex backend the way the Codex CLI does", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    await collect(createCodexGateway(fetchFn).stream(token, request, new AbortController().signal));

    const [sent] = requests;
    expect(sent?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(Object.fromEntries(sent!.headers)).toMatchObject({
      authorization: "Bearer access-token",
      "chatgpt-account-id": "account-1",
      originator: "mage",
      "openai-beta": "responses=experimental",
      "session-id": "thread-1",
      "x-client-request-id": "thread-1",
    });
    expect(sent?.body).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      store: false,
      instructions: "You are the agent in Mage.",
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-1",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "[Ada Lovelace] How do engines compute?" }],
        },
        { role: "assistant", content: "With gears." },
        { role: "user", content: [{ type: "input_text", text: "[Grace Hopper] And looms?" }] },
      ],
    });
    // The backend refuses these.
    expect(sent?.body).not.toHaveProperty("max_output_tokens");
    expect(sent?.body).not.toHaveProperty("temperature");
    expect(JSON.stringify(sent?.body.input)).not.toContain('"system"');
  });

  it("streams the reply as steps, deltas and usage", async () => {
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);

    const events = await collect(
      createCodexGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "step-start" },
      { type: "delta", text: "Punched" },
      { type: "delta", text: " cards." },
      { type: "step-end", usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
  });

  it("throws what the backend says when it refuses the request", async () => {
    // A refusal that is not worth retrying.
    const refusal = new Response(
      JSON.stringify({
        error: {
          message: "Unsupported parameter: max_output_tokens",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const { fetchFn } = recordingFetch([refusal, refusal.clone(), refusal.clone()]);

    await expect(
      collect(createCodexGateway(fetchFn).stream(token, request, new AbortController().signal)),
    ).rejects.toThrow(/max_output_tokens/);
  });

  it("reads a usage limit's reset from the backend's 429 and keeps its limit headers", async () => {
    const limited = () =>
      Response.json(
        {
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "plus",
            resets_at: 1792000000,
          },
        },
        {
          status: 429,
          headers: {
            "retry-after": "0",
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": "1791990000",
            "cf-ray": "abc",
          },
        },
      );
    const { fetchFn } = recordingFetch([limited(), limited(), limited()]);

    const failed = await collect(
      createCodexGateway(fetchFn).stream(token, request, new AbortController().signal),
    ).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(ModelError);
    const { kind, resetsAt, detail } = failed as ModelError;
    expect(kind).toBe("limit");
    expect(resetsAt).toEqual(new Date(1792000000 * 1000));
    expect(detail.split("\n")).toEqual([
      "429 The usage limit has been reached",
      "retry-after: 0",
      "x-codex-primary-reset-at: 1791990000",
      "x-codex-primary-used-percent: 100",
      "x-codex-primary-window-minutes: 300",
    ]);
  });

  it("takes the reset of a used-up window when the body has none", async () => {
    const limited = () =>
      new Response(null, {
        status: 429,
        headers: {
          "retry-after": "0",
          "x-codex-primary-used-percent": "40",
          "x-codex-primary-reset-at": "1791990000",
          "x-codex-secondary-used-percent": "100",
          "x-codex-secondary-reset-at": "1792500000",
        },
      });
    const { fetchFn } = recordingFetch([limited(), limited(), limited()]);

    await expect(
      collect(createCodexGateway(fetchFn).stream(token, request, new AbortController().signal)),
    ).rejects.toThrow(
      expect.objectContaining({ kind: "limit", resetsAt: new Date(1792500000 * 1000) }),
    );
  });

  it.each([
    [401, "auth"],
    [400, "model"],
    [503, "network"],
  ])("sorts a %i refusal as a %s failure", async (status, kind) => {
    const message =
      kind === "model" ? "The 'gpt-x' model is not supported with a ChatGPT account." : "Nope";
    const refusal = () =>
      Response.json({ detail: message }, { status, headers: { "retry-after": "0" } });
    const { fetchFn } = recordingFetch([refusal(), refusal(), refusal()]);

    await expect(
      collect(createCodexGateway(fetchFn).stream(token, request, new AbortController().signal)),
    ).rejects.toThrow(
      expect.objectContaining({ kind, detail: `${status} ${message}\nretry-after: 0` }),
    );
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const { fetchFn } = recordingFetch([sse(reply(["Punched", " cards."]))]);
    const events: ModelEvent[] = [];

    await expect(
      (async () => {
        for await (const event of createCodexGateway(fetchFn).stream(
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

  it("needs the ChatGPT account id", async () => {
    const { fetchFn, requests } = recordingFetch([]);

    await expect(
      collect(
        createCodexGateway(fetchFn).stream(
          { access: "a", accountId: null },
          request,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/account id/);
    expect(requests).toEqual([]);
  });
});

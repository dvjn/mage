import { describe, expect, it } from "vite-plus/test";

import { type ModelEvent, ModelError, type ModelRequest } from "@/server/models/gateway.ts";

import { createAnthropicKeyGateway } from "./anthropic-api.ts";

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
  instructions: "You are the agent.",
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

// A reply that calls a tool after a few words.
function toolUse(name: string, json: string) {
  const [start, ...rest] = reply(["On it."]);
  const ending = rest.slice(-2);
  return [
    start!,
    ...rest.slice(0, -2),
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: json },
    },
    { type: "content_block_stop", index: 1 },
    { ...ending[0]!, delta: { stop_reason: "tool_use", stop_sequence: null } },
    ending[1]!,
  ];
}

describe("Anthropic API key gateway", () => {
  it("offers tools by names the API takes, and ends the request with the calls asked for", async () => {
    const { fetchFn, requests } = recordingFetch([
      sse(toolUse("thread__rename", '{"title":"Engines"}')),
    ]);
    const tools = [
      {
        id: "thread.rename",
        description: "Rename this thread.",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
    ];

    const events = await collect(
      createAnthropicKeyGateway(fetchFn).stream(
        token,
        {
          ...request,
          tools,
          messages: [
            ...request.messages,
            {
              role: "assistant",
              text: "",
              toolCalls: [{ callId: "toolu_0", toolId: "thread.info", input: {} }],
            },
            {
              role: "tool",
              results: [
                { callId: "toolu_0", toolId: "thread.info", output: { ok: false, error: "No." } },
              ],
            },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.tools).toEqual([
      expect.objectContaining({ name: "thread__rename", description: "Rename this thread." }),
    ]);
    expect((requests[0]!.body.messages as unknown[]).slice(-2)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_0", name: "thread__info", input: {} }],
      },
      {
        role: "user",
        content: [
          expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_0", is_error: true }),
        ],
      },
    ]);
    expect(events).toContainEqual({
      type: "tool-call",
      callId: "toolu_1",
      toolId: "thread.rename",
      input: { title: "Engines" },
    });
    expect(events.at(-1)).toMatchObject({ type: "step-end" });
  });

  it("declares searchable tools left out from the start and turns them on mid-conversation, where the model takes that", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Hi"])), sse(reply(["Hi"]))]);
    const gateway = createAnthropicKeyGateway(fetchFn);
    const tool = (id: string) => ({ id, description: id, inputSchema: { type: "object" } });
    const searching: Omit<ModelRequest, "beforeStep"> = {
      ...request,
      tools: [tool("thread.rename")],
      searchable: [tool("mcp.notes.echo"), tool("mcp.notes.add")],
      toolsOn: ["mcp.notes.add"],
      messages: [...request.messages, { role: "change", tools: ["mcp.notes.add"] }],
    };
    const signal = new AbortController().signal;

    await collect(gateway.stream(token, { ...searching, model: "claude-opus-5-5" }, signal));
    await collect(gateway.stream(token, searching, signal));

    const [deferring, appending] = requests.map((sent) => sent.body) as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(deferring.tools).toEqual([
      expect.not.objectContaining({ defer_loading: true }),
      expect.objectContaining({ name: "mcp__notes__echo", defer_loading: true }),
      expect.objectContaining({ name: "mcp__notes__add", defer_loading: true }),
    ]);
    expect((deferring.messages as unknown[]).at(-1)).toEqual({
      role: "system",
      content: [
        { type: "tool_addition", tool: { type: "tool_reference", name: "mcp__notes__add" } },
      ],
    });
    // A model without mid-conversation changes is sent those turned on after the rest.
    expect((appending.tools as { name: string }[]).map((sent) => sent.name)).toEqual([
      "thread__rename",
      "mcp__notes__add",
    ]);
    expect(JSON.stringify(appending.messages)).not.toContain("tool_addition");
  });

  it("keeps the thread's first effort and tells a change in the conversation, where the model takes that", async () => {
    const { fetchFn, requests } = recordingFetch([sse(reply(["Hi"])), sse(reply(["Hi"]))]);
    const gateway = createAnthropicKeyGateway(fetchFn);
    const changed: Omit<ModelRequest, "beforeStep"> = {
      ...request,
      effort: "high",
      firstEffort: "low",
      messages: [...request.messages, { role: "change", effort: "high" }],
    };
    const signal = new AbortController().signal;

    await collect(gateway.stream(token, { ...changed, model: "claude-opus-5-5" }, signal));
    await collect(gateway.stream(token, { ...changed, model: "claude-sonnet-5" }, signal));

    const [pinned, plain] = requests;
    expect(pinned?.body.output_config).toEqual({ effort: "low" });
    expect((pinned!.body.messages as unknown[]).at(-1)).toEqual({
      role: "system",
      content: [],
      output_config: { effort: "high" },
    });
    expect(pinned?.headers.get("anthropic-beta")).toContain("mid-conversation-output-config");
    expect(plain?.body.output_config).toEqual({ effort: "high" });
    expect(JSON.stringify(plain?.body.messages)).not.toContain('"system"');
  });

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
      system: [{ type: "text", text: "You are the agent." }],
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

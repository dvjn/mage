import { describe, expect, it } from "vite-plus/test";

import type { ModelEvent, ModelRequest } from "@/server/models/gateway.ts";

import { claudeErrors, createClaudeCatalog, createClaudeGateway } from "./anthropic-claude.ts";

const token = { access: "sk-ant-oat-token", accountId: "acct-123" };

// A short Messages stream as the Anthropic API sends it, as server-sent events.
function sse() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function recordingFetch(responses: Response[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      url: request.url,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    });
    const response = responses.shift();
    if (!response) throw new Error("no more responses");
    return response;
  }) as typeof fetch;
  return { fetchFn, requests };
}

const request: Omit<ModelRequest, "beforeStep"> = {
  model: "claude-opus-5-5",
  instructions: "You are the agent.",
  messages: [{ role: "user", text: "[Ada Lovelace] How do engines compute?" }],
  maxSteps: 5,
  sessionId: "thread-1",
};

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Claude sign-in gateway", () => {
  it("asks with the account's token as Claude Code does, its identity the first system block", async () => {
    const { fetchFn, requests } = recordingFetch([sse()]);

    const events = await collect(
      createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal),
    );

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    const [sent] = requests;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-ant-oat-token");
    expect(sent?.headers.has("x-api-key")).toBe(false);
    expect(sent?.headers.get("anthropic-beta")?.split(",")).toEqual(
      expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20"]),
    );
    expect(sent?.headers.get("user-agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+\b/);
    expect(sent?.headers.get("x-app")).toBe("cli");
    expect(sent?.body?.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are the agent." },
    ]);
  });

  it("keeps the API key host's searchable tools and effort changes", async () => {
    const { fetchFn, requests } = recordingFetch([sse()]);
    const tool = (id: string) => ({ id, description: id, inputSchema: { type: "object" } });

    await collect(
      createClaudeGateway(fetchFn).stream(
        token,
        {
          ...request,
          searchable: [tool("mcp.notes.add")],
          toolsOn: ["mcp.notes.add"],
          effort: "high",
          firstEffort: "low",
          messages: [...request.messages, { role: "change", tools: ["mcp.notes.add"] }],
        },
        new AbortController().signal,
      ),
    );

    const body = requests[0]?.body;
    expect(body?.tools).toEqual([
      expect.objectContaining({ name: "mcp__notes__add", defer_loading: true }),
    ]);
    expect(body?.output_config).toEqual({ effort: "low" });
    expect(body?.system).toHaveLength(2);
  });

  it("asks a connection's proxy instead, with its headers added", async () => {
    const { fetchFn, requests } = recordingFetch([sse()]);
    const proxy = { baseUrl: "https://proxy.example.com/v1", headers: { "x-team": "blue" } };

    await collect(
      createClaudeGateway(fetchFn).stream(
        { ...token, proxy },
        request,
        new AbortController().signal,
      ),
    );

    expect(requests[0]?.url).toBe("https://proxy.example.com/v1/messages");
    expect(requests[0]?.headers.get("x-team")).toBe("blue");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-ant-oat-token");
  });

  it("shows what the API says when it refuses the request", async () => {
    const said = "Third-party apps now draw from your extra usage, not your plan limits.";
    const refusal = () =>
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message: said } },
        { status: 400 },
      );
    const { fetchFn } = recordingFetch([refusal(), refusal(), refusal()]);

    await expect(
      collect(createClaudeGateway(fetchFn).stream(token, request, new AbortController().signal)),
    ).rejects.toThrow(`400 ${said}`);
  });

  it("needs a token rather than falling back to a key from the environment", async () => {
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

describe("Claude sign-in catalog", () => {
  it("lists the account's models with its token", async () => {
    const { fetchFn, requests } = recordingFetch([
      Response.json({
        data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000 }],
        has_more: false,
      }),
    ]);

    const models = await createClaudeCatalog(fetchFn).list(token);

    expect(models).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1000 },
    ]);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(Object.fromEntries(requests[0]!.headers)).toMatchObject({
      authorization: "Bearer sk-ant-oat-token",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    });
    expect(requests[0]?.headers.has("x-api-key")).toBe(false);
  });
});

describe("Claude sign-in limits", () => {
  it("reads when the account's window or extra usage resets", () => {
    const now = new Date("2026-10-24T10:00:00Z");
    expect(
      claudeErrors.resetsAt?.({ "anthropic-ratelimit-unified-reset": "1793095200" }, null, now),
    ).toEqual(new Date(1793095200 * 1000));
    expect(
      claudeErrors.resetsAt?.(
        {
          "anthropic-ratelimit-unified-7d-status": "rejected",
          "anthropic-ratelimit-unified-7d-reset": "2026-10-30T00:00:00Z",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-reset": "2026-10-24T12:00:00Z",
        },
        null,
        now,
      ),
    ).toEqual(new Date("2026-10-30T00:00:00Z"));
  });
});

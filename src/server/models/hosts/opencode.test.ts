import { describe, expect, it } from "vite-plus/test";

import { createHostAdapters } from "@/server/models/hosts.ts";
import type { ModelEvent, ModelRequest, ModelToken } from "@/server/models/gateway.ts";
import { splitValues } from "@/shared/hosts.ts";

import { createOpenCodeAdapters } from "./opencode.ts";

const plans = [
  ["opencode-zen", "https://opencode.ai/inference"],
  ["opencode-go", "https://opencode.ai/inference/go"],
] as const;
const token: ModelToken = { access: "oc_sk_test", accountId: null };
const paid = {
  id: "kimi-k3",
  name: "Kimi K3",
  canonical_id: "moonshotai/kimi-k3",
  type: "chat",
  modalities: { output: ["text"] },
  capabilities: { reasoning: { supported: true }, tools: { supported: true } },
  limit: { context: 256000, input: 240000 },
  cost: { text: { input: { price: 3, cache: { read: 0, write: 3.75 } }, output: { price: 15 } } },
  // Catalog-provided endpoints must never redirect our requests or their credentials.
  api: { "chat-completions": { base_url: "https://untrusted.example" } },
};

const request: ModelRequest = {
  model: "kimi-k3",
  instructions: "Reply briefly.",
  messages: [{ role: "user", text: "Hello" }],
  maxSteps: 1,
  sessionId: "thread-1",
};

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function response(model: string, cost: number) {
  const chunks = [
    {
      id: "reply",
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
    },
    {
      id: "reply",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 2,
        total_tokens: 17,
        cost,
        opencode: {
          billing_source: cost === 0 ? "go" : "balance",
          tokens: {
            input: 10,
            output: 2,
            cache_read: 5,
            cache_write_5m: 0,
            cache_write_1h: 0,
          },
        },
      },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe.each(plans)("%s", (host, base) => {
  it("connects with a sealed API key and lists its own paid chat catalog with live metadata", async () => {
    expect(splitValues(host, "api_key", { apiKey: " oc_sk_test " })).toMatchObject({
      ok: true,
      secrets: { apiKey: "oc_sk_test" },
      settings: { method: "api_key" },
    });
    const requests: Request[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        data: [
          paid,
          paid,
          { id: "big-pickle", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
          { id: "another-free" },
          { ...paid, id: "image-only", modalities: { output: ["image"] } },
          { ...paid, id: "embedding", type: "embedding" },
          { ...paid, id: "no-tools", capabilities: { tools: { supported: false } } },
        ],
      });
    };
    const controller = new AbortController();
    const models = await createHostAdapters(fetchFn).catalogs[host].list(token, controller.signal);
    expect(models).toEqual([
      {
        id: "kimi-k3",
        name: "Kimi K3",
        maker: "moonshot",
        contextWindow: 240000,
        reasoning: true,
        ...(host === "opencode-zen" && {
          pricing: { input: 0.000003, output: 0.000015, cacheRead: 0, cacheWrite: 0.00000375 },
        }),
      },
    ]);
    expect(requests[0]?.url).toBe(`${base}/v1/models`);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer oc_sk_test");
    controller.abort();
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it("streams translated text models with stable thread sessions and the reported charge", async () => {
    const sent: { request: Request; body: Record<string, unknown> }[] = [];
    const cost = host === "opencode-go" ? 0 : 0.0042;
    const adapters = createHostAdapters(async (input, init) => {
      const http = new Request(input, init);
      const body = (await http.json()) as Record<string, unknown>;
      sent.push({ request: http, body });
      return response(String(body.model), cost);
    });
    for (const model of ["kimi-k3", "gpt-6-luna", "claude-haiku-5-5", "gemini-4-argon"]) {
      const events = await collect(
        adapters.gateways[host].stream(token, { ...request, model }, new AbortController().signal),
      );
      expect(events).toContainEqual({ type: "delta", text: "Hello" });
      expect(events.find((event) => event.type === "step-end")).toEqual({
        type: "step-end",
        usage: {
          inputTokens: 15,
          outputTokens: 2,
          cacheReadTokens: 5,
          cost: { usd: cost, source: "provider" },
        },
      });
    }
    await collect(
      adapters.gateways[host].stream(
        token,
        { ...request, sessionId: "thread-2" },
        new AbortController().signal,
      ),
    );
    expect(sent.map(({ request: http }) => http.headers.get("x-opencode-session"))).toEqual([
      "thread-1",
      "thread-1",
      "thread-1",
      "thread-1",
      "thread-2",
    ]);
    expect(
      sent.every(({ request: http }) => http.url === `${base}/openai/v1/chat/completions`),
    ).toBe(true);
    expect(
      sent.every(({ request: http }) => http.headers.get("authorization") === "Bearer oc_sk_test"),
    ).toBe(true);
    expect(sent[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("uses the proxy for lists and replies, retaining headers and refreshing the session id", async () => {
    const requests: Request[] = [];
    const adapters = createOpenCodeAdapters(host, async (input, init) => {
      const http = new Request(input, init);
      requests.push(http);
      return http.method === "GET" ? Response.json({ data: [paid] }) : response("kimi-k3", 0);
    });
    const proxied = {
      ...token,
      proxy: {
        baseUrl: "https://proxy.example/console/",
        headers: {
          "x-proxy-key": "proxy-key",
          "x-opencode-session": "stale",
        },
      },
    };
    await adapters.catalog.list(proxied);
    await collect(adapters.gateway.stream(proxied, request, new AbortController().signal));
    expect(requests.map((http) => http.url)).toEqual([
      "https://proxy.example/console/v1/models",
      "https://proxy.example/console/openai/v1/chat/completions",
    ]);
    expect(requests[1]?.headers.get("x-proxy-key")).toBe("proxy-key");
    expect(requests[1]?.headers.get("x-opencode-session")).toBe("thread-1");
  });

  it("refuses missing keys and sessions and surfaces invalid lists or provider errors", async () => {
    const adapters = createOpenCodeAdapters(host, async () =>
      Response.json({ message: "no" }, { status: 403 }),
    );
    await expect(adapters.catalog.list({ access: "", accountId: null })).rejects.toThrow(
      "no API key",
    );
    await expect(adapters.catalog.list(token)).rejects.toThrow("403");
    await expect(
      collect(
        adapters.gateway.stream(
          { access: "", accountId: null },
          request,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("no API key");
    await expect(
      collect(
        adapters.gateway.stream(token, { ...request, sessionId: "" }, new AbortController().signal),
      ),
    ).rejects.toThrow("session id");
    const malformed = createOpenCodeAdapters(host, async () =>
      Response.json({ data: "not models" }),
    );
    await expect(malformed.catalog.list(token)).rejects.toThrow("not a list");
  });
});

it("does not estimate a flat Zen price when its live catalog specifies price multipliers", async () => {
  const { catalog } = createOpenCodeAdapters("opencode-zen", async () =>
    Response.json({
      data: [
        {
          ...paid,
          cost: {
            ...paid.cost,
            multipliers: [{ factor: 2, when: { input_tokens: { gt: 200000 } } }],
          },
        },
      ],
    }),
  );
  expect((await catalog.list(token))[0]?.pricing).toBeUndefined();
});

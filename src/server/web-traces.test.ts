import { describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import type { Guests } from "@/server/guests/service.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import { createTraceRelay } from "@/server/kernel/trace-relay.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import type { Connections } from "@/server/models/connections.ts";
import type { Models } from "@/server/models/service.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Identity } from "@/server/orgs/identity.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import type { Skills } from "@/server/skills/service.ts";
import type { Artifacts } from "@/server/artifacts/service.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import type { Threads } from "@/server/threads/service.ts";

import { type AppOptions, createApp } from "./app.ts";

const signedIn: Identity = {
  resolve: () => Promise.resolve({ userId: "u1", email: "ada@example.com", principal: null }),
  profile: () => Promise.reject(new Error("unused")),
};
const signedOut: Identity = {
  resolve: () => Promise.resolve(null),
  profile: () => Promise.reject(new Error("signed out")),
};

function app(identity: Identity, traceRelay?: AppOptions["traceRelay"]) {
  return createApp({
    handleAuth: () => Promise.resolve(new Response(null, { status: 404 })),
    identity,
    connections: {} as Connections,
    models: {} as Models,
    spaces: {} as Spaces,
    threads: {} as Threads,
    guests: {} as Guests,
    orgs: {} as Orgs,
    groups: {} as Groups,
    tools: {} as ToolDecisions,
    toolPolicies: {} as ToolPolicies,
    mcp: {} as McpServers,
    instructions: {} as Instructions,
    skills: {} as Skills,
    artifacts: {} as Artifacts,
    logger: createLogger({ write() {} }),
    signInOptions: { oidc: null },
    pingDatabase: () => Promise.resolve(true),
    ...(traceRelay && { traceRelay }),
  });
}

// A collector that records what reached it.
function collector() {
  const received: { url: string; type: string | null; body: string; auth: string | null }[] = [];
  const relay = createTraceRelay({
    url: "http://collector:4318/v1/traces",
    headers: { authorization: "Bearer collector-token" },
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      received.push({
        url: url as string,
        type: headers.get("content-type"),
        auth: headers.get("authorization"),
        body: new TextDecoder().decode(init?.body as ArrayBuffer),
      });
      return Response.json({ partialSuccess: {} });
    },
  });
  return { relay, received };
}

function spans(type = "application/json") {
  return {
    method: "POST",
    headers: { "content-type": type },
    body: JSON.stringify({ resourceSpans: [] }),
  };
}

describe("POST /api/web/traces", () => {
  it("passes a signed-in person's spans on to the collector", async () => {
    const { relay, received } = collector();
    const res = await app(signedIn, relay).request("/api/web/traces", spans());
    expect(res.status).toBe(200);
    expect(received).toEqual([
      {
        url: "http://collector:4318/v1/traces",
        type: "application/json",
        auth: "Bearer collector-token",
        body: '{"resourceSpans":[]}',
      },
    ]);
  });

  it("refuses someone signed out", async () => {
    const { relay, received } = collector();
    const res = await app(signedOut, relay).request("/api/web/traces", spans());
    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it("refuses what is not OTLP", async () => {
    const { relay, received } = collector();
    const res = await app(signedIn, relay).request("/api/web/traces", spans("text/plain"));
    expect(res.status).toBe(415);
    expect(received).toEqual([]);
  });

  it("is not found while tracing is off", async () => {
    const res = await app(signedIn).request("/api/web/traces", spans());
    expect(res.status).toBe(404);
  });
});

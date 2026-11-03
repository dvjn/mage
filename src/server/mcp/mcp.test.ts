import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { modelToolNames } from "@/server/agent/tools.ts";
import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { MCP_ORIGIN, setup } from "@/server/testing/workspace.ts";
import {
  MCP_INSTRUCTIONS_MAX,
  mcpHeadersInputSchema,
  type McpServerSummary,
  mcpSlugOf,
} from "@/shared/mcp.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { ActorSummary } from "@/shared/threads/events.ts";
import {
  EDITORS,
  TOOL_OFF,
  type ToolsetSetting,
  WIRE_NAME_MAX,
  wireToolName,
} from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import {
  MCP_API_KEY,
  MCP_BEARER_TOKEN,
  MODERN_REVISION,
  mcpStandIn,
  NOTES_GUIDE,
  NOTES_INSTRUCTIONS,
} from "../../../e2e/mcp-server.ts";
import { contentsOf, RESOURCE_TEXT_MAX, textLike } from "./resources.ts";
import {
  keptInstructions,
  mergeHeaders,
  outputOf,
  riskOfAnnotations,
  secretHint,
  uniqueSlug,
} from "./service.ts";

// Makes an org policy every call of which waits for anyone who can edit the thread, and gives its id.
async function signOff(
  api: (method: string, path: string, cookie: string, body?: object) => Promise<Response>,
  cookie: string,
) {
  const res = await api("POST", "/org/tool-policies", cookie, {
    name: "Sign-off",
    color: "orange",
    use: "none",
    users: [],
    approvers: [EDITORS],
    independent: false,
  });
  return ((await res.json()) as { id: string }).id;
}

const bearer = [{ name: "Authorization", value: `Bearer ${MCP_BEARER_TOKEN}` }];

// The row of the thread as its reader sees it.
function rowIn(detail: ThreadDetail, id: string) {
  return detail.rows.find((row) => row.id === id);
}

// The JSON-RPC methods the requests sent were for.
function methodsOf(requests: Request[]) {
  return Promise.all(
    requests
      .filter((req) => req.method === "POST")
      .map(async (req) => ((await req.clone().json()) as { method?: string }).method),
  );
}

describe("headers", () => {
  it("are named once each in lower case, on one line, never ones the transport sets", () => {
    expect(mcpHeadersInputSchema.parse([{ name: "X-Api-Key", value: "k" }])).toEqual([
      { name: "x-api-key", value: "k" },
    ]);
    const refused = (headers: { name: string; value: string | null }[]) =>
      mcpHeadersInputSchema.safeParse(headers).error?.issues[0]?.message;
    expect(
      refused([
        { name: "X-Key", value: "a" },
        { name: "x-key", value: "b" },
      ]),
    ).toBe("Give each header once");
    expect(refused([{ name: "Mcp-Session-Id", value: "a" }])).toBe(
      "Mage sets mcp-session-id itself",
    );
    expect(refused([{ name: "bad name", value: "a" }])).toBe("bad name is not a header name");
    expect(refused([{ name: "x-key", value: "a\r\nb" }])).toBe("Header values are one line");
    expect(refused([{ name: "Authorization", value: "Bearer t" }])).toBeUndefined();
  });

  it("keep a stored value where none is given, and need one for a new name", () => {
    const stored = { "x-api-key": "old-secret-value" };
    expect(mergeHeaders([{ name: "x-api-key", value: null }], stored)).toEqual(stored);
    expect(mergeHeaders([{ name: "x-api-key", value: "new" }], stored)).toEqual({
      "x-api-key": "new",
    });
    expect(() => mergeHeaders([{ name: "x-other", value: null }], stored)).toThrow(
      "Give a value for x-other",
    );
  });

  it("show only the end of a long value", () => {
    expect(secretHint("Bearer mcp-journey-token")).toBe("…oken");
    expect(secretHint("short")).toBe("••••");
  });
});

describe("a tool's result", () => {
  it("keeps structured content, else the text, and an error as its text", () => {
    expect(
      outputOf({ content: [{ type: "text", text: "{}" }], structuredContent: { id: "n" } }),
    ).toEqual({ ok: true, value: { id: "n" } });
    expect(
      outputOf({
        content: [
          { type: "text", text: "Here" },
          { type: "image", mimeType: "image/png", data: "…" },
          { type: "resource_link", name: "Spec", uri: "file:///spec.md" },
        ],
      }),
    ).toEqual({ ok: true, value: "Here\n[image image/png]\nSpec file:///spec.md" });
    expect(outputOf({ content: [{ type: "text", text: "No note" }], isError: true })).toEqual({
      ok: false,
      error: "No note",
    });
  });

  it("asks each time for a tool its server marks destructive, and not for a read-only one", () => {
    expect(riskOfAnnotations({ destructiveHint: true })).toBe("ask");
    expect(riskOfAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("normal");
    expect(riskOfAnnotations({ destructiveHint: false })).toBe("normal");
    expect(riskOfAnnotations(undefined)).toBe("normal");
  });
});

// Ada's org, with helpers to add servers and read them.
async function orgWithServers() {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  async function add(body: object, path = "/org/mcp-servers", who = ada) {
    const res = await workspace.api("POST", path, who.cookie, body);
    return { status: res.status, body: (await res.json()) as McpServerSummary & { error: string } };
  }
  async function orgTools(who = ada) {
    const res = await workspace.api("GET", "/org/tools", who.cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as ToolsetSetting[];
  }
  async function spaceTools(spaceId: string, who = ada) {
    const res = await workspace.api("GET", `/spaces/${spaceId}/tools`, who.cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as ToolsetSetting[];
  }
  return { ...workspace, ada, add, orgTools, spaceTools };
}

describe("an org's MCP servers", () => {
  it("list their tools over Streamable HTTP with headers that are never given back", async () => {
    const { ada, add, orgTools, api, db, mcpNetwork } = await orgWithServers();

    const { status, body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/headers/mcp`,
      auth: { kind: "headers", headers: bearer },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: "Notes",
      status: "ok",
      error: null,
      transport: "streamable-http",
      serverInfo: { name: "Notes", version: "1.0.0" },
      toolCount: 3,
      auth: { kind: "headers", headers: [{ name: "authorization", hint: "…oken" }] },
    });
    const listed = await api("GET", "/org/mcp-servers", ada.cookie);
    expect(JSON.stringify(await listed.json())).not.toContain(MCP_BEARER_TOKEN);
    const sealed = db.select().from(schema.mcpCredential).all();
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.sealed.toString("latin1")).not.toContain(MCP_BEARER_TOKEN);
    expect(mcpNetwork.requests.every((req) => req.headers.get("authorization"))).toBe(true);

    const notes = (await orgTools()).find((toolset) => toolset.id === `mcp:${body.id}`);
    expect(notes).toMatchObject({ title: "Notes", source: "mcp", scope: "org" });
    expect(notes?.tools.map((tool) => [tool.id, tool.policy, tool.definition.title])).toEqual([
      [`mcp:${body.id}/echo`, null, "Echo"],
      [`mcp:${body.id}/add_note`, null, "Add note"],
      [`mcp:${body.id}/delete_note`, null, "Delete note"],
    ]);
    expect(notes?.tools[0]?.definition.annotations).toEqual({ readOnlyHint: true });
  });

  it("say when the server does not take the headers, and read it again once they change", async () => {
    const { ada, add, api } = await orgWithServers();
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/headers/mcp`,
      auth: { kind: "headers", headers: [{ name: "X-Api-Key", value: "wrong-key-value" }] },
    });
    expect(body).toMatchObject({
      status: "error",
      error: "The server did not accept the headers (HTTP 401).",
      toolCount: 0,
    });

    const res = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: { kind: "headers", headers: [{ name: "x-api-key", value: MCP_API_KEY }] },
    });
    expect(await res.json()).toMatchObject({ status: "ok", error: null, toolCount: 3 });
    const kept = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      name: "Team notes",
      auth: { kind: "headers", headers: [{ name: "x-api-key", value: null }] },
    });
    expect(await kept.json()).toMatchObject({ name: "Team notes", status: "ok" });
  });

  it("fall back to HTTP+SSE for a server that only speaks it", async () => {
    const { add } = await orgWithServers();
    const { body } = await add({ name: "Old", url: `${MCP_ORIGIN}/sse`, auth: { kind: "none" } });
    expect(body).toMatchObject({
      status: "ok",
      transport: "sse",
      protocolVersion: "2025-11-25",
      toolCount: 3,
    });
  });

  it("speak the 2026-07-28 revision with a server that speaks only it, never initializing", async () => {
    const { add, mcpNetwork } = await orgWithServers();
    const { body } = await add({
      name: "Modern",
      url: `${MCP_ORIGIN}/modern/headers/mcp`,
      auth: { kind: "headers", headers: bearer },
    });
    expect(body).toMatchObject({
      status: "ok",
      error: null,
      transport: "streamable-http",
      protocolVersion: MODERN_REVISION,
      serverInfo: { name: "Notes", version: "1.0.0" },
      toolCount: 3,
    });
    expect(await methodsOf(mcpNetwork.requests)).toEqual([
      "server/discover",
      "tools/list",
      "prompts/list",
    ]);
  });

  it("ask again which revision a server speaks when read again, as one may move to a later one", async () => {
    const { ada, add, api, mcpNetwork } = await orgWithServers();
    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    expect(body).toMatchObject({ protocolVersion: "2025-11-25" });

    const upgraded = mcpStandIn({ origin: MCP_ORIGIN });
    mcpNetwork.handle = (req) => upgraded(new Request(`${MCP_ORIGIN}/modern/mcp`, req));
    const read = await api("POST", `/mcp-servers/${body.id}/refresh`, ada.cookie);
    expect(await read.json()).toMatchObject({ status: "ok", protocolVersion: MODERN_REVISION });
  });

  it("fall back to the initialize handshake with a server of an older revision", async () => {
    const { add } = await orgWithServers();
    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    expect(body).toMatchObject({
      status: "ok",
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
      toolCount: 3,
    });
  });

  it("keep their tools while the server is down, and say why until it answers", async () => {
    const { ada, add, api, mcpNetwork, orgTools } = await orgWithServers();
    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    mcpNetwork.up = false;

    const down = await api("POST", `/mcp-servers/${body.id}/refresh`, ada.cookie);
    expect(await down.json()).toMatchObject({
      status: "error",
      error: "Could not reach localhost:4791 (ECONNREFUSED).",
      toolCount: 3,
    });
    expect((await orgTools()).find((t) => t.id === `mcp:${body.id}`)?.tools).toHaveLength(3);

    mcpNetwork.up = true;
    const back = await api("POST", `/mcp-servers/${body.id}/refresh`, ada.cookie);
    expect(await back.json()).toMatchObject({ status: "ok", error: null });
  });

  it("refuse addresses that are not http(s), and only the org's owners manage them", async () => {
    const { add, signUp, join, yourSpace, ada, api } = await orgWithServers();
    const bad = await add({ name: "X", url: "file:///etc/passwd", auth: { kind: "none" } });
    expect(bad).toMatchObject({ status: 400, body: { error: "Give an http or https address" } });

    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    const space = await yourSpace(ada.cookie);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
    const refused = await add(
      { name: "Mine", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } },
      "/org/mcp-servers",
      grace,
    );
    expect(refused.status).toBe(403);
    expect((await api("DELETE", `/mcp-servers/${body.id}`, grace.cookie)).status).toBe(403);
    expect((await api("GET", `/mcp-servers/${body.id}`, grace.cookie)).status).toBe(200);
    expect((await api("DELETE", `/mcp-servers/${body.id}`, ada.cookie)).status).toBe(200);
    expect((await api("GET", `/mcp-servers/${body.id}`, ada.cookie)).status).toBe(404);
  });
});

// Follows the authorization server's page back to Mage's callback, as the browser would.
async function authorizeInBrowser(
  workspace: Awaited<ReturnType<typeof orgWithServers>>,
  serverId: string,
  who = workspace.ada,
) {
  const res = await workspace.api("POST", `/mcp-servers/${serverId}/authorize`, who.cookie);
  const started = (await res.json()) as { status: string; url: string };
  expect(started.status).toBe("redirect");
  const page = await workspace.mcpNetwork.handle(new Request(started.url));
  expect(page.status).toBe(302);
  const back = new URL(page.headers.get("location")!);
  return {
    started: new URL(started.url),
    callback: await workspace.app.request(`${back.pathname}${back.search}`, {
      headers: { Cookie: who.cookie },
    }),
  };
}

describe("OAuth", () => {
  it("publishes Mage's client metadata document to anyone", async () => {
    const { app } = setup();
    const res = await app.request("/api/mcp/oauth/client.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.json()).toEqual({
      client_id: "http://localhost:4783/api/mcp/oauth/client.json",
      client_name: "Mage",
      client_uri: "http://localhost:4783",
      redirect_uris: ["http://localhost:4783/api/mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("registers Mage, authorizes it with PKCE for the server, and keeps the tokens sealed", async () => {
    const workspace = await orgWithServers();
    const { add, db } = workspace;
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    expect(body).toMatchObject({
      status: "needs_auth",
      auth: { kind: "oauth", authorized: false, registration: null },
    });

    const { started, callback } = await authorizeInBrowser(workspace, body.id);
    expect(started.origin + started.pathname).toBe(`${MCP_ORIGIN}/authorize`);
    expect(started.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.searchParams.get("resource")).toBe(`${MCP_ORIGIN}/oauth/mcp`);
    expect(started.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4783/api/mcp/oauth/callback",
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/org/tools/mcp/${body.id}`);

    const res = await workspace.api("GET", `/mcp-servers/${body.id}`, workspace.ada.cookie);
    const server = (await res.json()) as McpServerSummary;
    expect(server).toMatchObject({
      status: "ok",
      toolCount: 3,
      auth: { kind: "oauth", authorized: true, registration: "dynamic", issuer: MCP_ORIGIN },
    });
    expect(server.auth.kind === "oauth" && server.auth.clientId).toMatch(/^client-/);
    const sealed = db.select().from(schema.mcpCredential).all()[0]!.sealed.toString("latin1");
    expect(sealed).not.toContain("access_token");
  });

  it("ignores a callback for someone else, and asks to reconnect once the tokens are revoked", async () => {
    const workspace = await orgWithServers();
    const { add, api, ada, mcpNetwork, signUp } = workspace;
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    const started = (await (
      await api("POST", `/mcp-servers/${body.id}/authorize`, ada.cookie)
    ).json()) as { url: string };
    const page = await mcpNetwork.handle(new Request(started.url));
    const back = new URL(page.headers.get("location")!);
    const eve = await signUp("Eve", "eve@example.com");
    const theirs = await workspace.app.request(`${back.pathname}${back.search}`, {
      headers: { Cookie: eve.cookie },
    });
    expect(theirs.headers.get("location")).toBe("/org/tools");
    const still = await api("GET", `/mcp-servers/${body.id}`, ada.cookie);
    expect(await still.json()).toMatchObject({ status: "needs_auth" });

    await authorizeInBrowser(workspace, body.id);
    await mcpNetwork.handle(new Request(`${MCP_ORIGIN}/control/revoke`, { method: "POST" }));
    const refreshed = await api("POST", `/mcp-servers/${body.id}/refresh`, ada.cookie);
    expect(await refreshed.json()).toMatchObject({
      status: "needs_auth",
      error: "The server needs Mage authorized again.",
      toolCount: 3,
    });
    const again = await authorizeInBrowser(workspace, body.id);
    expect(again.callback.status).toBe(302);
    const ok = await api("GET", `/mcp-servers/${body.id}`, ada.cookie);
    expect(await ok.json()).toMatchObject({ status: "ok", error: null });
  });

  it("authorizes Mage for a server that speaks only the 2026-07-28 revision", async () => {
    const workspace = await orgWithServers();
    const { body } = await workspace.add({
      name: "Modern",
      url: `${MCP_ORIGIN}/modern/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    expect(body).toMatchObject({ status: "needs_auth", protocolVersion: null });

    const { started } = await authorizeInBrowser(workspace, body.id);
    expect(started.searchParams.get("resource")).toBe(`${MCP_ORIGIN}/modern/oauth/mcp`);
    const res = await workspace.api("GET", `/mcp-servers/${body.id}`, workspace.ada.cookie);
    expect(await res.json()).toMatchObject({
      status: "ok",
      protocolVersion: MODERN_REVISION,
      toolCount: 3,
      auth: { kind: "oauth", authorized: true },
    });
  });

  it("uses a client people entered where the server registers none, and says so without one", async () => {
    const workspace = await orgWithServers();
    workspace.mcpNetwork.handle = mcpStandIn({
      origin: MCP_ORIGIN,
      registration: false,
      clients: [{ id: "mage-app", secret: "app-secret-0123456789" }],
    });
    const { body: bare } = await workspace.add({
      name: "Bare",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    const refused = await workspace.api(
      "POST",
      `/mcp-servers/${bare.id}/authorize`,
      workspace.ada.cookie,
    );
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toMatch(/registration/i);

    const { body } = await workspace.add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: "mage-app", clientSecret: "app-secret-0123456789" },
    });
    const { started } = await authorizeInBrowser(workspace, body.id);
    expect(started.searchParams.get("client_id")).toBe("mage-app");
    const res = await workspace.api("GET", `/mcp-servers/${body.id}`, workspace.ada.cookie);
    const server = await res.json();
    expect(server).toMatchObject({
      status: "ok",
      auth: { kind: "oauth", clientId: "mage-app", registration: "manual", authorized: true },
    });
    expect(JSON.stringify(server)).not.toContain("app-secret");
  });
});

describe("a space's MCP servers", () => {
  it("are added by its managers, for its threads alone, while the org lets spaces have them", async () => {
    const workspace = await orgWithServers();
    const { ada, add, api, createSpace, join, signUp, orgTools, spaceTools, yourSpace } = workspace;
    const own = await yourSpace(ada.cookie);
    const lab = await createSpace(ada.cookie, "Lab");
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), lab.id, "owner");
    const alan = join(await signUp("Alan Turing", "alan@example.com"), lab.id, "messager");
    const server = { name: "Lab notes", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } };

    expect((await add(server, `/spaces/${lab.id}/mcp-servers`, alan)).status).toBe(403);
    const { status, body } = await add(server, `/spaces/${lab.id}/mcp-servers`, grace);
    expect(status).toBe(200);
    expect(body).toMatchObject({ spaceId: lab.id, status: "ok", toolCount: 3 });

    const inLab = (await spaceTools(lab.id)).find((t) => t.id === `mcp:${body.id}`);
    expect(inLab).toMatchObject({ scope: "space", title: "Lab notes" });
    expect(inLab?.tools.map((tool) => [tool.orgPolicy, tool.policy])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect((await spaceTools(own.id)).some((t) => t.id === `mcp:${body.id}`)).toBe(false);
    expect((await orgTools()).some((t) => t.id === `mcp:${body.id}`)).toBe(false);
    const listed = await api("GET", `/spaces/${lab.id}/mcp-servers`, grace.cookie);
    expect(await listed.json()).toMatchObject({ allowed: true, org: [], own: [{ id: body.id }] });

    // A space sets its own servers' tools as it likes.
    const set = await api("PATCH", `/spaces/${lab.id}/tools`, grace.cookie, {
      toolIds: [`mcp:${body.id}/add_note`],
      policy: TOOL_OFF,
    });
    expect(set.status).toBe(200);
    const unknown = await api("PATCH", `/spaces/${own.id}/tools`, ada.cookie, {
      toolIds: [`mcp:${body.id}/add_note`],
      policy: TOOL_OFF,
    });
    expect(unknown.status).toBe(404);

    const off = await api("PUT", "/org/mcp-servers/space-servers", ada.cookie, { allowed: false });
    expect(await off.json()).toMatchObject({ spaceServers: false });
    expect((await spaceTools(lab.id)).some((t) => t.id === `mcp:${body.id}`)).toBe(true);
    expect(
      workspace.tools
        .definitions({ id: lab.id, orgId: ada.orgId })
        .some((t) => t.name.startsWith(`mcp:${body.id}/`)),
    ).toBe(false);
    const again = await add(server, `/spaces/${lab.id}/mcp-servers`, grace);
    expect(again).toMatchObject({
      status: 403,
      body: { error: "The organization does not let spaces add MCP servers" },
    });
    const policy = await api("PUT", "/org/mcp-servers/space-servers", grace.cookie, {
      allowed: true,
    });
    expect(policy.status).toBe(403);
  });
});

describe("turning an MCP server off", () => {
  it("takes its tools from every space while keeping them, and a space takes one of the org's from itself alone", async () => {
    const workspace = await orgWithServers();
    const { ada, add, api, createSpace, join, signUp, orgTools, spaceTools, yourSpace, tools } =
      workspace;
    const own = await yourSpace(ada.cookie);
    const lab = await createSpace(ada.cookie, "Lab");
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), lab.id, "owner");
    const alan = join(await signUp("Alan Turing", "alan@example.com"), lab.id, "messager");
    const { body } = await add({ name: "Notes", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    const toolset = `mcp:${body.id}`;
    const offered = (spaceId: string) =>
      tools
        .definitions({ id: spaceId, orgId: ada.orgId })
        .some((tool) => tool.name.startsWith(`${toolset}/`));
    expect(body.enabled).toBe(true);
    expect(offered(own.id)).toBe(true);

    // Off for everyone: its tools go, its connection and count stay.
    const refused = await api("PUT", `/mcp-servers/${body.id}/enabled`, grace.cookie, {
      enabled: false,
    });
    expect(refused.status).toBe(403);
    const off = await api("PUT", `/mcp-servers/${body.id}/enabled`, ada.cookie, { enabled: false });
    expect(await off.json()).toMatchObject({ enabled: false, status: "ok", toolCount: 3 });
    expect((await orgTools()).some((t) => t.id === toolset)).toBe(true);
    expect(offered(own.id)).toBe(false);
    expect(offered(lab.id)).toBe(false);
    const inLab = await api("GET", `/spaces/${lab.id}/mcp-servers`, grace.cookie);
    expect(await inLab.json()).toMatchObject({
      org: [{ id: body.id, enabled: false, inSpace: true }],
      own: [],
    });
    const notWhileOff = await api("PUT", `/spaces/${lab.id}/mcp-servers/${body.id}`, grace.cookie, {
      enabled: true,
    });
    expect(notWhileOff.status).toBe(409);
    expect(await notWhileOff.json()).toEqual({ error: "The organization turned this server off" });

    const on = await api("PUT", `/mcp-servers/${body.id}/enabled`, ada.cookie, { enabled: true });
    expect(await on.json()).toMatchObject({ enabled: true });
    expect(offered(own.id)).toBe(true);

    // Off in the lab alone, by those who manage it.
    const notAlan = await api("PUT", `/spaces/${lab.id}/mcp-servers/${body.id}`, alan.cookie, {
      enabled: false,
    });
    expect(notAlan.status).toBe(403);
    const inLabOff = await api("PUT", `/spaces/${lab.id}/mcp-servers/${body.id}`, grace.cookie, {
      enabled: false,
    });
    expect(await inLabOff.json()).toMatchObject({
      org: [{ id: body.id, enabled: true, inSpace: false }],
    });
    expect(offered(lab.id)).toBe(false);
    expect(offered(own.id)).toBe(true);
    expect((await spaceTools(lab.id)).some((t) => t.id === toolset)).toBe(true);
    expect((await spaceTools(own.id)).some((t) => t.id === toolset)).toBe(true);
    expect((await orgTools()).some((t) => t.id === toolset)).toBe(true);

    // Only the org's servers are the space's to turn off this way.
    const labNotes = await add(
      { name: "Lab notes", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } },
      `/spaces/${lab.id}/mcp-servers`,
      grace,
    );
    const notOrg = await api(
      "PUT",
      `/spaces/${lab.id}/mcp-servers/${labNotes.body.id}`,
      grace.cookie,
      { enabled: false },
    );
    expect(notOrg.status).toBe(404);
    const ownOff = await api("PUT", `/mcp-servers/${labNotes.body.id}/enabled`, grace.cookie, {
      enabled: false,
    });
    expect(await ownOff.json()).toMatchObject({ enabled: false, spaceId: lab.id });
    expect((await spaceTools(lab.id)).some((t) => t.id === `mcp:${labNotes.body.id}`)).toBe(true);
    expect(
      tools
        .definitions({ id: lab.id, orgId: ada.orgId })
        .some((t) => t.name.startsWith(`mcp:${labNotes.body.id}/`)),
    ).toBe(false);
  });

  it("keeps permissions editable while off and preserves a space's switch across org changes", async () => {
    const { ada, add, api, yourSpace, tools, spaceTools } = await orgWithServers();
    const space = { ...(await yourSpace(ada.cookie)), orgId: ada.orgId };
    const { body: server } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/headers/mcp`,
      auth: { kind: "headers", headers: bearer },
    });
    const toolset = `mcp:${server.id}`;
    const echo = `${toolset}/echo`;
    const setHere = (enabled: boolean) =>
      api("PUT", `/spaces/${space.id}/mcp-servers/${server.id}`, ada.cookie, { enabled });
    const setEverywhere = (enabled: boolean) =>
      api("PUT", `/mcp-servers/${server.id}/enabled`, ada.cookie, { enabled });
    expect((await setHere(false)).status).toBe(200);
    expect((await setEverywhere(false)).status).toBe(200);
    const asks = await signOff(api, ada.cookie);
    const orgMode = await api("PATCH", "/org/tools", ada.cookie, { toolIds: [echo], policy: asks });
    expect(orgMode.status).toBe(200);
    const spaceMode = await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, {
      toolIds: [echo],
      policy: TOOL_OFF,
    });
    expect(spaceMode.status).toBe(200);
    expect(
      (await spaceTools(space.id)).find((t) => t.id === toolset)?.tools.find((t) => t.id === echo),
    ).toMatchObject({ orgPolicy: asks, policy: TOOL_OFF });
    expect(tools.offered(space).some((t) => t.name.startsWith(`${toolset}/`))).toBe(false);

    const on = await setEverywhere(true);
    expect(await on.json()).toMatchObject({
      enabled: true,
      status: "ok",
      toolCount: 3,
      auth: server.auth,
    });
    expect(tools.definitions(space).some((t) => t.name.startsWith(`${toolset}/`))).toBe(false);
    expect((await setHere(true)).status).toBe(200);
    expect(tools.definitions(space).some((t) => t.name === echo)).toBe(true);
    expect(tools.offered(space).some((t) => t.name === echo)).toBe(false);
    expect(
      (await spaceTools(space.id)).find((t) => t.id === toolset)?.tools.find((t) => t.id === echo),
    ).toMatchObject({ orgPolicy: asks, policy: TOOL_OFF });
  });

  it("does not let another organization change either switch", async () => {
    const { ada, add, api, signUp, yourSpace } = await orgWithServers();
    const { body: server } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/mcp`,
      auth: { kind: "none" },
    });
    const other = await signUp("Grace Hopper", "grace@example.com");
    const otherSpace = await yourSpace(other.cookie);
    const global = await api("PUT", `/mcp-servers/${server.id}/enabled`, other.cookie, {
      enabled: false,
    });
    expect(global.status).toBe(404);
    const local = await api(
      "PUT",
      `/spaces/${otherSpace.id}/mcp-servers/${server.id}`,
      other.cookie,
      { enabled: false },
    );
    expect(local.status).toBe(404);
    const unchanged = await api("GET", `/mcp-servers/${server.id}`, ada.cookie);
    expect(await unchanged.json()).toMatchObject({ enabled: true });
  });
});

// A thread whose org has the stand-in MCP server, and the ids and model names of its tools.
async function mcpThread(url = `${MCP_ORIGIN}/headers/mcp`) {
  const workspace = await agentThread();
  const { ada, api, model, events } = workspace;
  const res = await api("POST", "/org/mcp-servers", ada.cookie, {
    name: "Notes",
    url,
    auth: { kind: "headers", headers: bearer },
  });
  const server = (await res.json()) as McpServerSummary;
  const id = (tool: string) => `mcp:${server.id}/${tool}`;
  // What the model knows the tool by.
  const named = (tool: string) => `mcp.notes.${tool}`;
  // Has the model call the tool in its next step. An MCP tool is left out until searched for, so
  // the model first turns it on by name with the tool search, a step of its own.
  async function calls(toolId: string, input: unknown) {
    if (toolId.startsWith("mcp")) {
      const search = await model.next();
      search.startStep();
      search.toolCall(`call-${model.calls.length}`, "mcp._.search_tools", {
        select: [toolId.startsWith("mcp:") ? toolId.split("/").at(-1)! : toolId],
      });
      search.endStep();
      search.end();
    }
    const call = await model.next();
    call.startStep();
    call.toolCall(`call-${model.calls.length}`, toolId, input);
    call.endStep();
    call.end();
    return call;
  }
  // The thread's tool calls, past those searching for tools unless asked for.
  function toolRows(searches = false) {
    return transcriptOf(events())
      .rows.filter((row) => row.kind === "tool")
      .filter((row) => searches || row.toolId !== "mcp._.search_tools");
  }
  return { ...workspace, server, id, named, calls, toolRows };
}

describe("MCP tools in a thread", () => {
  it("run through the server with its headers, and give back its structured content", async () => {
    const { ada, api, thread, post, calls, model, worker, start, id, named, toolRows } =
      await mcpThread();
    start();

    await post(ada, "Write a note");
    const first = await calls(named("add_note"), { title: "Engines", body: "They compute" });
    const next = await model.next();
    next.reply("Written.");
    await worker.idle();

    // The tool searched for is offered; the others are still listed for searching.
    expect(first.tools).toContain(named("add_note"));
    expect(first.request.instructions).toContain(`- ${named("echo")}: Say the text back.`);
    expect(first.request.tools?.find((tool) => tool.id === named("add_note"))?.inputSchema).toEqual(
      expect.objectContaining({ required: ["title"] }),
    );
    expect(toolRows().map((row) => [row.state, row.risk])).toEqual([["ran", "normal"]]);
    expect(next.texts.at(-1)).toBe(
      `result ${named("add_note")}: {"ok":true,"value":{"id":"note-1","title":"Engines","words":2}}`,
    );

    // The thread's tool definitions name the server; Mage's own name their toolset.
    const detail = (await (
      await api("GET", `/threads/${thread.id}`, ada.cookie)
    ).json()) as ThreadDetail;
    expect(detail.tools.find((tool) => tool.name === id("add_note"))).toMatchObject({
      title: "Add note",
      toolset: "Notes",
    });
    expect(detail.tools.find((tool) => tool.name === "thread.rename")).toMatchObject({
      title: "Rename",
      toolset: "Thread",
    });
  });

  it("run on a server of the 2026-07-28 revision, and go straight to initialize on an older one", async () => {
    for (const [path, methods] of [
      ["/modern/headers/mcp", ["server/discover", "tools/call"]],
      ["/headers/mcp", ["initialize", "notifications/initialized", "tools/call"]],
    ] as const) {
      const { ada, post, calls, model, worker, start, named, mcpNetwork } = await mcpThread(
        `${MCP_ORIGIN}${path}`,
      );
      start();
      mcpNetwork.requests.length = 0;

      await post(ada, "Say it");
      await calls(named("echo"), { text: "hello" });
      const next = await model.next();
      next.reply("Said.");
      await worker.idle();

      expect(next.texts.at(-1)).toBe(
        `result ${named("echo")}: {"ok":true,"value":{"text":"hello"}}`,
      );
      expect(await methodsOf(mcpNetwork.requests)).toEqual(methods);
    }
  });

  it("ask before one the server marks destructive, and fail clearly when the server is down", async () => {
    const workspace = await mcpThread();
    const { ada, post, calls, model, worker, start, id, toolRows, api, thread, mcpNetwork } =
      workspace;
    start();

    await post(ada, "Delete note-9");
    await calls(id("delete_note"), { id: "note-9" });
    await worker.idle();
    expect(toolRows().map((row) => [row.state, row.risk])).toEqual([["pending", "ask"]]);

    mcpNetwork.up = false;
    const callId = toolRows()[0]!.id;
    const decided = await api(
      "POST",
      `/threads/${thread.id}/tools/${callId}/decision`,
      ada.cookie,
      {
        allow: true,
        scope: "once",
      },
    );
    expect(decided.status).toBe(200);
    const next = await model.next();
    next.reply("It is down.");
    await worker.idle();

    expect(toolRows().map((row) => row.state)).toEqual(["failed"]);
    expect(next.texts.at(-1)).toContain("Notes: Could not reach localhost:4791 (ECONNREFUSED).");
    const server = await api("GET", `/mcp-servers/${workspace.server.id}`, ada.cookie);
    expect(await server.json()).toMatchObject({ status: "error" });
  });

  it.each(["org", "space"] as const)(
    "does not execute an approved pending call after the server is off in the %s",
    async (scope) => {
      const {
        ada,
        api,
        post,
        calls,
        model,
        worker,
        start,
        id,
        toolRows,
        thread,
        server,
        mcpNetwork,
        events,
      } = await mcpThread();
      start();
      await post(ada, "Delete note-9");
      await calls(id("delete_note"), { id: "note-9" });
      await worker.idle();
      expect(toolRows()[0]?.state).toBe("pending");
      const endpoint =
        scope === "org"
          ? `/mcp-servers/${server.id}/enabled`
          : `/spaces/${thread.spaceId}/mcp-servers/${server.id}`;
      expect((await api("PUT", endpoint, ada.cookie, { enabled: false })).status).toBe(200);
      mcpNetwork.requests.length = 0;
      const callId = toolRows()[0]!.id;
      const approved = await api(
        "POST",
        `/threads/${thread.id}/tools/${callId}/decision`,
        ada.cookie,
        { allow: true, scope: "once" },
      );
      expect(approved.status).toBe(200);
      const next = await model.next();
      next.reply("The server is off.");
      await worker.idle();
      expect(events()).toContainEqual(
        expect.objectContaining({
          type: "tool.denied",
          data: expect.objectContaining({ callId, reason: "stale" }),
        }),
      );
      expect(await methodsOf(mcpNetwork.requests)).not.toContain("tools/call");
      expect(next.tools.some((tool) => tool.startsWith(`mcp:${server.id}/`))).toBe(false);
    },
  );

  it("are not offered when off, and a removed server's tools go with it", async () => {
    const { ada, post, model, worker, start, id, named, api, server, db } = await mcpThread();
    await api("PATCH", "/org/tools", ada.cookie, { toolIds: [id("echo")], policy: TOOL_OFF });
    start();

    await post(ada, "Hello");
    const first = await model.next();
    first.reply("Hi.");
    await worker.idle();
    expect(first.request.instructions).not.toContain(`- ${named("echo")}:`);
    expect(first.request.instructions).toContain(`- ${named("add_note")}:`);

    await api("DELETE", `/mcp-servers/${server.id}`, ada.cookie);
    expect(
      db
        .select()
        .from(schema.mcpCredential)
        .where(eq(schema.mcpCredential.serverId, server.id))
        .all(),
    ).toEqual([]);
    await post(ada, "Again");
    const second = await model.next();
    second.reply("Hi.");
    await worker.idle();
    expect(second.tools.some((tool) => tool.startsWith("mcp"))).toBe(false);
    expect(second.request.instructions).not.toContain("mcp.notes");
  });
});

describe("an MCP server's instructions", () => {
  it("are trimmed, cut to the cap and marked so, and none when empty", () => {
    expect(keptInstructions("  Be brief.\n")).toEqual({
      instructions: "Be brief.",
      instructionsCut: false,
    });
    expect(keptInstructions("x".repeat(MCP_INSTRUCTIONS_MAX))).toEqual({
      instructions: "x".repeat(MCP_INSTRUCTIONS_MAX),
      instructionsCut: false,
    });
    expect(keptInstructions(`${"x".repeat(MCP_INSTRUCTIONS_MAX)}y`)).toEqual({
      instructions: "x".repeat(MCP_INSTRUCTIONS_MAX),
      instructionsCut: true,
    });
    expect(keptInstructions("  ")).toEqual({ instructions: null, instructionsCut: false });
    expect(keptInstructions(null)).toEqual({ instructions: null, instructionsCut: false });
  });

  it("are kept each time its tools are read, in either revision, and kept while it is down", async () => {
    const { ada, add, api, mcpNetwork } = await orgWithServers();
    const refresh = async (id: string) =>
      (await (
        await api("POST", `/mcp-servers/${id}/refresh`, ada.cookie)
      ).json()) as McpServerSummary;
    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    expect(body).toMatchObject({ instructions: NOTES_INSTRUCTIONS, instructionsCut: false });
    const modern = await add({
      name: "Modern",
      url: `${MCP_ORIGIN}/modern/mcp`,
      auth: { kind: "none" },
    });
    expect(modern.body).toMatchObject({ instructions: NOTES_INSTRUCTIONS });

    mcpNetwork.handle = mcpStandIn({
      origin: MCP_ORIGIN,
      instructions: `  ${"y".repeat(MCP_INSTRUCTIONS_MAX + 10)}  `,
    });
    expect(await refresh(body.id)).toMatchObject({
      instructions: "y".repeat(MCP_INSTRUCTIONS_MAX),
      instructionsCut: true,
    });

    mcpNetwork.up = false;
    expect(await refresh(body.id)).toMatchObject({ status: "error", instructionsCut: true });

    mcpNetwork.up = true;
    mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, instructions: null });
    expect(await refresh(body.id)).toMatchObject({ instructions: null, instructionsCut: false });
  });

  it("reach the prompt after the space's, only for servers with a tool on in the space", async () => {
    const { ada, api, thread, post, model, worker, start, mcpNetwork } = await mcpThread();
    mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, instructions: "Search before writing." });
    const other = (await (
      await api("POST", "/org/mcp-servers", ada.cookie, {
        name: "Other",
        url: `${MCP_ORIGIN}/mcp`,
        auth: { kind: "none" },
      })
    ).json()) as McpServerSummary;
    await api("PUT", `/spaces/${thread.spaceId}/instructions`, ada.cookie, { text: "Cite ids." });
    start();

    await post(ada, "Hello");
    const first = await model.next();
    first.reply("Hi.");
    await worker.idle();
    const prompt = first.request.instructions;
    const at = (text: string) => prompt.indexOf(text);
    expect(at("Instructions from this space:\nCite ids.")).toBeGreaterThan(0);
    expect(at("not the organization's")).toBeGreaterThan(at("Cite ids."));
    expect(prompt).toContain(
      `From the MCP server Notes, about its tools \`mcp.notes.*\`:\n${NOTES_INSTRUCTIONS}`,
    );
    expect(at("From the MCP server Other, about its tools `mcp.other.*`:")).toBeGreaterThan(
      at("From the MCP server Notes"),
    );

    // With each of its tools off in the space, a server says nothing.
    await api("PATCH", `/spaces/${thread.spaceId}/tools`, ada.cookie, {
      toolIds: ["echo", "add_note", "delete_note"].map((tool) => `mcp:${other.id}/${tool}`),
      policy: TOOL_OFF,
    });
    await post(ada, "Again");
    const second = await model.next();
    second.reply("Hi.");
    await worker.idle();
    expect(second.request.instructions).toContain("From the MCP server Notes");
    expect(second.request.instructions).not.toContain("Search before writing.");
    expect(second.request.instructions).not.toContain("MCP server Other");
  });
});

describe("an MCP server's address", () => {
  it("with no path is tried again at /mcp, and the address that answered is kept", async () => {
    const { add } = await orgWithServers();
    for (const url of [MCP_ORIGIN, `${MCP_ORIGIN}/`]) {
      const { status, body } = await add({ name: "Open", url, auth: { kind: "none" } });
      expect(status).toBe(200);
      expect(body).toMatchObject({ url: `${MCP_ORIGIN}/mcp`, status: "ok", toolCount: 3 });
    }
  });

  it("finds a server behind OAuth at /mcp by its resource metadata, and authorizes Mage for it", async () => {
    const workspace = await orgWithServers();
    workspace.mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, oauthPath: "/mcp" });
    const { body } = await workspace.add({
      name: "Notes",
      url: MCP_ORIGIN,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    expect(body).toMatchObject({ url: `${MCP_ORIGIN}/mcp`, status: "needs_auth" });

    const { started } = await authorizeInBrowser(workspace, body.id);
    expect(started.searchParams.get("resource")).toBe(`${MCP_ORIGIN}/mcp`);
    const res = await workspace.api("GET", `/mcp-servers/${body.id}`, workspace.ada.cookie);
    expect(await res.json()).toMatchObject({ status: "ok", toolCount: 3 });
  });

  it("finds a server at /mcp that refuses the initialize handshake for a later revision", async () => {
    const { add, mcpNetwork } = await orgWithServers();
    const modern = mcpStandIn({ origin: MCP_ORIGIN });
    mcpNetwork.handle = async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      return modern(new Request(`${MCP_ORIGIN}/modern/mcp`, req));
    };
    const { status, body } = await add({ name: "Modern", url: MCP_ORIGIN, auth: { kind: "none" } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      url: `${MCP_ORIGIN}/mcp`,
      status: "ok",
      protocolVersion: MODERN_REVISION,
      toolCount: 3,
    });
  });

  it("says so when neither it nor /mcp answers as an MCP server, and keeps nothing", async () => {
    const { add, ada, api, mcpNetwork } = await orgWithServers();
    mcpNetwork.handle = async () => new Response(null, { status: 405 });
    const refused = await add({ name: "Site", url: MCP_ORIGIN, auth: { kind: "none" } });
    expect(refused).toMatchObject({
      status: 400,
      body: {
        error: "This address didn't answer as an MCP server. MCP servers usually live at /mcp.",
      },
    });
    const listed = await api("GET", "/org/mcp-servers", ada.cookie);
    expect(await listed.json()).toMatchObject({ servers: [] });

    // One that cannot be reached is kept as given, saying why.
    mcpNetwork.up = false;
    const { body } = await add({ name: "Down", url: MCP_ORIGIN, auth: { kind: "none" } });
    expect(body).toMatchObject({ url: MCP_ORIGIN, status: "error" });
  });
});

describe("changing an MCP server", () => {
  it("keeps header values left out, replaces those typed and drops those removed", async () => {
    const { ada, add, api, db } = await orgWithServers();
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/headers/mcp`,
      auth: {
        kind: "headers",
        headers: [...bearer, { name: "X-Team", value: "blue-team-header" }],
      },
    });
    const sealed = () => db.select().from(schema.mcpCredential).all();
    const before = sealed()[0]!.sealed;

    const kept = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: {
        kind: "headers",
        headers: [
          { name: "Authorization", value: null },
          { name: "X-Team", value: "green-team-header" },
        ],
      },
    });
    expect(await kept.json()).toMatchObject({
      status: "ok",
      auth: {
        kind: "headers",
        headers: [
          { name: "authorization", hint: "…oken" },
          { name: "x-team", hint: "…ader" },
        ],
      },
    });
    expect(sealed()[0]!.sealed.equals(before)).toBe(false);

    const dropped = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: { kind: "headers", headers: [{ name: "X-Team", value: null }] },
    });
    expect(await dropped.json()).toMatchObject({
      status: "error",
      error: "The server did not accept the headers (HTTP 401).",
      auth: { kind: "headers", headers: [{ name: "x-team", hint: "…ader" }] },
    });
  });

  it("drops what went with the old way of authorizing, and keeps tool policies by name", async () => {
    const { ada, add, api, db, orgTools } = await orgWithServers();
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/headers/mcp`,
      auth: { kind: "headers", headers: bearer },
    });
    const addNote = `mcp:${body.id}/add_note`;
    const asks = await signOff(api, ada.cookie);
    await api("PATCH", "/org/tools", ada.cookie, { toolIds: [addNote], policy: asks });

    const open = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      url: `${MCP_ORIGIN}/mcp`,
      auth: { kind: "none" },
    });
    expect(await open.json()).toMatchObject({
      url: `${MCP_ORIGIN}/mcp`,
      status: "ok",
      auth: { kind: "none" },
      toolCount: 3,
    });
    expect(db.select().from(schema.mcpCredential).all()).toHaveLength(0);
    const tools = (await orgTools()).find((toolset) => toolset.id === `mcp:${body.id}`)?.tools;
    expect(tools?.find((tool) => tool.id === addNote)?.policy).toBe(asks);

    // Nothing stored is kept for another way of authorizing.
    const refused = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: { kind: "headers", headers: [{ name: "Authorization", value: null }] },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Give a value for authorization" });

    const oauth = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    expect(await oauth.json()).toMatchObject({
      status: "needs_auth",
      transport: null,
      auth: { kind: "oauth", authorized: false },
    });
  });

  it("drops OAuth tokens and a registered client for a new address, and asks to connect again", async () => {
    const workspace = await orgWithServers();
    const { ada, add, api } = workspace;
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    await authorizeInBrowser(workspace, body.id);
    const renamed = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      name: "Team notes",
      auth: { kind: "oauth", clientId: null, clientSecret: null },
    });
    expect(await renamed.json()).toMatchObject({
      name: "Team notes",
      status: "ok",
      auth: { kind: "oauth", authorized: true, registration: "dynamic" },
    });

    // The server moved to /mcp, with an authorization server that knows nothing of Mage.
    workspace.mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, oauthPath: "/mcp" });
    const moved = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, { url: MCP_ORIGIN });
    expect(await moved.json()).toMatchObject({
      url: `${MCP_ORIGIN}/mcp`,
      status: "needs_auth",
      error: null,
      toolCount: 3,
      auth: { kind: "oauth", authorized: false, clientId: null, registration: null, issuer: null },
    });
    const { started } = await authorizeInBrowser(workspace, body.id);
    expect(started.searchParams.get("resource")).toBe(`${MCP_ORIGIN}/mcp`);
    const res = await api("GET", `/mcp-servers/${body.id}`, ada.cookie);
    expect(await res.json()).toMatchObject({ status: "ok", auth: { authorized: true } });
  });

  it("keeps an entered client's secret and tokens while the client stays", async () => {
    const workspace = await orgWithServers();
    workspace.mcpNetwork.handle = mcpStandIn({
      origin: MCP_ORIGIN,
      registration: false,
      clients: [{ id: "mage-app", secret: "app-secret-0123456789" }],
    });
    const { ada, add, api } = workspace;
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: "mage-app", clientSecret: "app-secret-0123456789" },
    });
    await authorizeInBrowser(workspace, body.id);

    const kept = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: { kind: "oauth", clientId: "mage-app", clientSecret: null },
    });
    const text = await kept.text();
    expect(text).not.toContain("app-secret-0123456789");
    expect(JSON.parse(text)).toMatchObject({
      status: "ok",
      auth: { clientId: "mage-app", clientSecretHint: "…6789", authorized: true },
    });

    const other = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, {
      auth: { kind: "oauth", clientId: "other-app", clientSecret: null },
    });
    expect(await other.json()).toMatchObject({
      status: "needs_auth",
      auth: { clientId: "other-app", clientSecretHint: null, authorized: false },
    });
  });

  it("is only for those who manage it", async () => {
    const { add, signUp, join, yourSpace, ada, api } = await orgWithServers();
    const { body } = await add({ name: "Open", url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    const space = await yourSpace(ada.cookie);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
    const refused = await api("PATCH", `/mcp-servers/${body.id}`, grace.cookie, { name: "Mine" });
    expect(refused.status).toBe(403);
    const bad = await api("PATCH", `/mcp-servers/${body.id}`, ada.cookie, { url: "ftp://x" });
    expect(bad.status).toBe(400);
  });
});

describe("what the model calls a server's tools", () => {
  it("is a slug made from the server's name", () => {
    expect(mcpSlugOf("GitHub Issues")).toBe("github-issues");
    expect(mcpSlugOf("  Ünïcode & Co!  ")).toBe("unicode-co");
    expect(mcpSlugOf("***")).toBe("server");
    expect(mcpSlugOf("x".repeat(50))).toHaveLength(32);
    expect(uniqueSlug("notes", new Set(["notes", "notes-2"]))).toBe("notes-3");
    expect(uniqueSlug("x".repeat(32), new Set(["x".repeat(32)]))).toBe(`${"x".repeat(30)}-2`);
  });

  it("is unique among the servers a space has: the org's and its own", async () => {
    const { ada, add, api, createSpace } = await orgWithServers();
    const lab = await createSpace(ada.cookie, "Lab");
    const other = await createSpace(ada.cookie, "Other");
    const server = (name: string) => ({ name, url: `${MCP_ORIGIN}/mcp`, auth: { kind: "none" } });
    const slugOf = async (body: object, path?: string) => (await add(body, path)).body.slug;

    expect(await slugOf(server("Notes"))).toBe("notes");
    expect(await slugOf(server("Notes"))).toBe("notes-2");
    expect(await slugOf(server("Notes"), `/spaces/${lab.id}/mcp-servers`)).toBe("notes-3");
    // Another space may reuse a space's slug, but an org server may not take one any space has.
    expect(await slugOf(server("Notes"), `/spaces/${other.id}/mcp-servers`)).toBe("notes-3");
    expect(await slugOf(server("Notes"))).toBe("notes-4");
    const taken = await add({ ...server("Mine"), slug: "notes" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("Another server here is called notes");
    expect(await slugOf({ ...server("Mine"), slug: "mine_1" })).toBe("mine_1");
    const bad = await api("POST", "/org/mcp-servers", ada.cookie, { ...server("x"), slug: "Bad!" });
    expect(bad.status).toBe(400);
  });

  it("changes with the slug, while the tools keep their ids and policies", async () => {
    const workspace = await mcpThread();
    const { ada, api, server, id, post, calls, model, worker, start } = workspace;
    const policy = await signOff(api, ada.cookie);
    await api("PATCH", "/org/tools", ada.cookie, { toolIds: [id("echo")], policy });
    const res = await api("PATCH", `/mcp-servers/${server.id}`, ada.cookie, {
      name: "Scratchpad",
      slug: "pad",
    });
    expect(((await res.json()) as McpServerSummary).slug).toBe("pad");
    const tools = (await (await api("GET", "/org/tools", ada.cookie)).json()) as ToolsetSetting[];
    const echo = tools.flatMap((set) => set.tools).find((tool) => tool.id === id("echo"));
    expect(echo?.policy).toBe(policy);

    start();
    await post(ada, "Say it");
    const first = await calls("mcp.pad.add_note", { title: "T", body: "B" });
    const next = await model.next();
    next.reply("Done.");
    await worker.idle();
    expect(first.tools).toContain("mcp.pad.add_note");
    expect(first.request.instructions).toContain("Scratchpad (mcp.pad.*):\n- mcp.pad.echo:");
    expect(workspace.toolRows().map((row) => [row.toolId, row.state])).toEqual([
      [id("add_note"), "ran"],
    ]);
    expect(next.texts.filter((text) => text.startsWith("tool mcp.pad"))).toEqual([
      'tool mcp.pad.add_note: {"title":"T","body":"B"}',
    ]);
  });
});

// A thread whose org has the stand-in's server for people's own tokens, its credentials personal,
// connected for reading its tools with Ada's.
async function personalThread() {
  const workspace = await mcpThread(`${MCP_ORIGIN}/people/mcp`);
  const { ada, api, server } = workspace;
  const res = await api("PATCH", `/mcp-servers/${server.id}`, ada.cookie, {
    auth: { kind: "headers", headers: [{ name: "Authorization", value: "Bearer person-ada" }] },
    credentials: "personal",
  });
  expect(await res.json()).toMatchObject({ credentials: "personal", status: "ok", toolCount: 3 });
  function connect(who: { cookie: string }, token: string) {
    return api("PUT", `/mcp-servers/${server.id}/connection`, who.cookie, {
      headers: [{ name: "authorization", value: `Bearer ${token}` }],
    });
  }
  async function detail(who: { cookie: string }) {
    const res = await api("GET", `/threads/${workspace.thread.id}`, who.cookie);
    return (await res.json()) as ThreadDetail;
  }
  async function connections(who: { cookie: string }) {
    return (await (await api("GET", "/mcp-connections", who.cookie)).json()) as object[];
  }
  function decide(who: { cookie: string }, callId: string, scope: "once" | "for_now") {
    return api("POST", `/threads/${workspace.thread.id}/tools/${callId}/decision`, who.cookie, {
      allow: true,
      scope,
    });
  }
  return { ...workspace, connect, detail, connections, decide };
}

describe("personal credentials", () => {
  it("are only for servers authorized by headers or OAuth", async () => {
    const { add } = await orgWithServers();
    const { status, body } = await add({
      name: "Open",
      url: `${MCP_ORIGIN}/mcp`,
      auth: { kind: "none" },
      credentials: "personal",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Personal credentials need headers or OAuth");
  });

  it("run at once for one connected writer, as them alone", async () => {
    const workspace = await personalThread();
    const { grace, post, calls, model, worker, start, toolRows, connect } = workspace;
    expect((await connect(grace, "person-grace")).status).toBe(200);
    start();

    await post(grace, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    const next = await model.next();
    next.reply("Said.");
    await worker.idle();

    expect(next.texts.at(-1)).toBe(
      'result mcp.notes.echo: {"ok":true,"value":{"text":"grace: hi"}}',
    );
    expect(toolRows()[0]).toMatchObject({
      state: "ran",
      waits: false,
      ranAs: { name: "Grace Hopper" },
    });
  });

  it("ask a writer with no connection to approve, connecting first, and run as them", async () => {
    const workspace = await personalThread();
    const { grace, server, post, calls, model, worker, start, toolRows, connect, detail, decide } =
      workspace;
    start();

    await post(grace, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    await worker.idle();
    const [waiting] = toolRows();
    expect(waiting).toMatchObject({ state: "pending", waits: true });
    expect(rowIn(await detail(grace), waiting!.id)).toMatchObject({
      actions: ["allow", "allow_for_now", "deny"],
      connection: { serverId: server.id, kind: "headers", headers: ["authorization"] },
    });
    expect(await methodsOf(workspace.mcpNetwork.requests)).not.toContain("tools/call");

    const early = await decide(grace, waiting!.id, "once");
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe("Connect to Notes first");
    expect((await connect(grace, "nope")).status).toBe(400);
    expect((await connect(grace, "person-grace")).status).toBe(200);
    expect((await decide(grace, waiting!.id, "once")).status).toBe(200);
    const next = await model.next();
    next.reply("Said.");
    await worker.idle();

    expect(next.texts.at(-1)).toBe(
      'result mcp.notes.echo: {"ok":true,"value":{"text":"grace: hi"}}',
    );
    expect(toolRows()[0]).toMatchObject({ state: "ran", ranAs: { name: "Grace Hopper" } });
    expect(await workspace.connections(grace)).toMatchObject([
      { serverId: server.id, serverName: "Notes", spaceId: null, status: "ok" },
    ]);
  });

  it("wait in a group chat though anyone may use the tool, and run with the approver's login", async () => {
    const workspace = await personalThread();
    const { ada, grace, post, calls, model, worker, start, toolRows, connect, decide } = workspace;
    expect((await connect(grace, "person-grace")).status).toBe(200);
    expect((await connect(ada, "person-ada")).status).toBe(200);
    start();

    await post(grace, "Hello");
    (await model.next()).reply("Hi.");
    await worker.idle();
    await post(ada, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    await worker.idle();
    expect(toolRows()[0]).toMatchObject({ state: "pending", waits: true });

    expect((await decide(ada, toolRows()[0]!.id, "once")).status).toBe(200);
    const next = await model.next();
    next.reply("Said.");
    await worker.idle();
    expect(next.texts.at(-1)).toBe('result mcp.notes.echo: {"ok":true,"value":{"text":"ada: hi"}}');
    expect(toolRows()[0]).toMatchObject({
      state: "ran",
      decision: { by: { name: "Ada Lovelace" } },
      ranAs: { name: "Ada Lovelace" },
    });
  });

  it("show each reader only their own connection, and nobody's in the thread", async () => {
    const workspace = await personalThread();
    const { ada, grace, post, calls, worker, start, toolRows, connect, detail, events } = workspace;
    expect((await connect(ada, "person-ada")).status).toBe(200);
    start();

    await post(grace, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    await worker.idle();
    const callId = toolRows()[0]!.id;
    // Grace has no connection; Ada sees an ordinary approval with her own connection.
    expect(rowIn(await detail(ada), callId)).toMatchObject({
      risk: "normal",
      actions: ["allow", "allow_for_now", "deny"],
      connection: expect.objectContaining({ connected: true }),
    });
    expect(rowIn(await detail(grace), callId)).toMatchObject({
      actions: ["allow", "allow_for_now", "deny"],
      connection: { connected: false },
    });
    expect(events().map((event) => event.type)).not.toContain("tool.blocked");
  });

  it("run for now as its giver, on later calls, until someone else writes", async () => {
    const workspace = await personalThread();
    const { ada, grace, post, calls, model, worker, start, toolRows, connect, decide } = workspace;
    expect((await connect(grace, "person-grace")).status).toBe(200);
    expect((await connect(ada, "person-ada")).status).toBe(200);
    start();

    await post(ada, "Hello");
    (await model.next()).reply("Hi.");
    await worker.idle();
    await post(grace, "Say one");
    await calls("mcp.notes.echo", { text: "one" });
    await worker.idle();
    const first = toolRows()[0]!;
    expect((await decide(grace, first.id, "for_now")).status).toBe(200);
    (await model.next()).reply("Said.");
    await worker.idle();

    // Grace writing again keeps it; the call runs with her login, and says on whose approval.
    await post(grace, "Say two");
    await calls("mcp.notes.echo", { text: "two" });
    const two = await model.next();
    two.reply("Said.");
    await worker.idle();
    expect(two.texts.at(-1)).toBe(
      'result mcp.notes.echo: {"ok":true,"value":{"text":"grace: two"}}',
    );
    expect(toolRows()[1]).toMatchObject({
      state: "ran",
      waits: false,
      standingOn: first.id,
      decision: { scope: "for_now", by: { name: "Grace Hopper" } },
      ranAs: { name: "Grace Hopper" },
    });

    // Ada's words end it, though she may use the tool herself.
    await post(ada, "Say three");
    await calls("mcp.notes.echo", { text: "three" });
    await worker.idle();
    expect(toolRows()[2]).toMatchObject({ state: "pending", waits: true });
  });

  it("stop running for now once its giver's connection breaks", async () => {
    const workspace = await personalThread();
    const { ada, grace, api, server, post, calls, model, worker, start, toolRows } = workspace;
    expect((await workspace.connect(grace, "person-grace")).status).toBe(200);
    start();

    await post(ada, "Hello");
    (await model.next()).reply("Hi.");
    await worker.idle();
    await post(grace, "Say one");
    await calls("mcp.notes.echo", { text: "one" });
    await worker.idle();
    expect((await workspace.decide(grace, toolRows()[0]!.id, "for_now")).status).toBe(200);
    (await model.next()).reply("Said.");
    await worker.idle();
    expect(toolRows()[0]).toMatchObject({ state: "ran", ranAs: { name: "Grace Hopper" } });

    await api("DELETE", `/mcp-servers/${server.id}/connection`, grace.cookie);
    await post(grace, "Say two");
    await calls("mcp.notes.echo", { text: "two" });
    await worker.idle();
    expect(toolRows()[1]).toMatchObject({ state: "pending", waits: true });
  });

  it("never allow for now where every call asks", async () => {
    const workspace = await personalThread();
    const { ada, grace, api, id, post, calls, worker, start, toolRows } = workspace;
    const policy = await signOff(api, ada.cookie);
    await api("PATCH", "/org/tools", ada.cookie, { toolIds: [id("echo")], policy });
    expect((await workspace.connect(grace, "person-grace")).status).toBe(200);
    start();

    await post(grace, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    await worker.idle();
    const callId = toolRows()[0]!.id;
    expect(rowIn(await workspace.detail(grace), callId)).toMatchObject({ risk: "ask" });
    expect((await workspace.decide(grace, callId, "for_now")).status).toBe(400);
  });

  it("that the server refuses need connecting again, and a call never falls back", async () => {
    const workspace = await personalThread();
    const { ada, grace, post, calls, model, worker, start, toolRows, mcpNetwork } = workspace;
    expect((await workspace.connect(grace, "person-grace")).status).toBe(200);
    expect((await workspace.connect(ada, "person-ada")).status).toBe(200);
    await mcpNetwork.handle(
      new Request(`${MCP_ORIGIN}/control/revoke-person?name=grace`, { method: "POST" }),
    );
    start();

    await post(grace, "Say hi");
    await calls("mcp.notes.echo", { text: "hi" });
    const next = await model.next();
    next.reply("It failed.");
    await worker.idle();
    expect(toolRows()[0]).toMatchObject({ state: "failed", ranAs: { name: "Grace Hopper" } });
    expect(next.texts.at(-1)).toContain("It needs connecting again.");
    expect(await workspace.connections(grace)).toMatchObject([{ status: "needs_auth" }]);

    await post(grace, "Again");
    await calls("mcp.notes.echo", { text: "again" });
    await worker.idle();
    expect(toolRows()[1]).toMatchObject({ state: "pending", waits: true });
  });

  it("are forgotten for whoever leaves the org, on its servers and its spaces'", async () => {
    const workspace = await personalThread();
    const { ada, grace, api, hooks, db, space } = workspace;
    const res = await api("POST", `/spaces/${space.id}/mcp-servers`, ada.cookie, {
      name: "Lab",
      url: `${MCP_ORIGIN}/people/mcp`,
      auth: { kind: "headers", headers: [{ name: "Authorization", value: "Bearer person-ada" }] },
      credentials: "personal",
    });
    const lab = (await res.json()) as McpServerSummary;
    expect((await workspace.connect(grace, "person-grace")).status).toBe(200);
    expect((await workspace.connect(ada, "person-ada")).status).toBe(200);
    const inLab = await api("PUT", `/mcp-servers/${lab.id}/connection`, grace.cookie, {
      headers: [{ name: "authorization", value: "Bearer person-grace" }],
    });
    expect(inLab.status).toBe(200);

    await hooks.run("org.membersSettled", { orgId: ada.orgId, joined: [], left: [grace.userId] });
    const people = db
      .select()
      .from(schema.mcpCredential)
      .where(eq(schema.mcpCredential.holderKind, "user"))
      .all();
    expect(people.map((row) => row.holderId)).toEqual([ada.userId]);
  });

  it("read an older call paused for someone to connect as waiting for approval", () => {
    const grace = { kind: "user" as const, userId: "grace", name: "Grace Hopper" };
    const agent = { kind: "agent" as const };
    const at = "2026-10-31T00:00:00.000Z";
    const event = (seq: number, type: string, actor: ActorSummary, data: object) => ({
      id: `e${seq}`,
      threadId: "t",
      seq,
      type,
      actor,
      data,
      createdAt: at,
    });
    const requested = (seq: number, callId: string) =>
      event(seq, "tool.requested", agent, {
        runId: "r",
        callId,
        messageId: "m",
        toolId: "mcp:s/echo",
        input: {},
        risk: "normal",
        waits: false,
      });
    const { rows, run } = transcriptOf([
      event(1, "run.created", grace, { runId: "r", reason: null, continuesRunId: null }),
      requested(2, "a"),
      event(3, "tool.blocked", agent, { runId: "r", callId: "a", userId: "grace" }),
      requested(4, "b"),
      event(5, "tool.approved", grace, { runId: "r", callId: "b", scope: "once" }),
      event(6, "tool.blocked", agent, { runId: "r", callId: "b", userId: "grace" }),
      event(7, "tool.ran", agent, { runId: "r", callId: "b", ok: true, ms: 1, ranAs: "grace" }),
    ]);
    expect(rows.filter((row) => row.kind === "tool")).toMatchObject([
      { id: "a", state: "pending", waits: true, decision: null },
      { id: "b", state: "ran", decision: { by: { name: "Grace Hopper" } } },
    ]);
    expect(run?.waitingOn).toBe("a");
  });

  it("go when the person disconnects, or once the server's credentials are shared", async () => {
    const workspace = await personalThread();
    const { ada, grace, api, server, connect } = workspace;
    expect((await connect(grace, "person-grace")).status).toBe(200);
    expect((await connect(ada, "person-ada")).status).toBe(200);
    const gone = await api("DELETE", `/mcp-servers/${server.id}/connection`, grace.cookie);
    expect(gone.status).toBe(200);
    expect(await workspace.connections(grace)).toMatchObject([
      { serverId: server.id, status: null, connectedAt: null },
    ]);
    expect(await workspace.connections(ada)).toMatchObject([{ status: "ok" }]);

    await api("PATCH", `/mcp-servers/${server.id}`, ada.cookie, { credentials: "shared" });
    expect(await workspace.connections(ada)).toEqual([]);
    const kept = workspace.db.select().from(schema.mcpCredential).all();
    expect(kept.map((row) => row.holderKind)).toEqual(["shared"]);
    const notPersonal = await connect(grace, "person-grace");
    expect(notPersonal.status).toBe(409);
  });

  it("sign each person in with the server as themselves, and back to where they were", async () => {
    const workspace = await orgWithServers();
    const { add, ada, api } = workspace;
    const grace = workspace.join(
      await workspace.signUp("Grace Hopper", "grace@example.com"),
      (await workspace.yourSpace(ada.cookie)).id,
      "messager",
    );
    const { body } = await add({
      name: "Notes",
      url: `${MCP_ORIGIN}/oauth/mcp`,
      auth: { kind: "oauth", clientId: null, clientSecret: null },
      credentials: "personal",
    });
    await authorizeInBrowser(workspace, body.id);

    const res = await api("POST", `/mcp-servers/${body.id}/connection/authorize`, grace.cookie, {
      returnTo: "/t/somewhere",
    });
    const started = (await res.json()) as { status: string; url: string };
    expect(started.status).toBe("redirect");
    const page = await workspace.mcpNetwork.handle(new Request(started.url));
    const back = new URL(page.headers.get("location")!);
    const callback = await workspace.app.request(`${back.pathname}${back.search}`, {
      headers: { Cookie: grace.cookie },
    });
    expect(callback.headers.get("location")).toBe("/t/somewhere");
    const mine = await (await api("GET", "/mcp-connections", grace.cookie)).json();
    expect(mine).toMatchObject([{ serverId: body.id, status: "ok" }]);
    // Ada's sign-in for reading tools is not one of her own connections.
    expect(await (await api("GET", "/mcp-connections", ada.cookie)).json()).toMatchObject([
      { serverId: body.id, kind: "oauth", status: null },
    ]);
  });
});

describe("tool names for the model", () => {
  it("fit providers' limit and stay unique on the wire, mapping back to their ids", () => {
    const long = `mcp.server.${"very_long_tool_name_".repeat(5)}`;
    const tools = [
      { id: "a", name: "thread.info" },
      { id: "b", name: "thread__info" },
      { id: "c", name: long },
      { id: "d", name: `${long}x` },
      { id: "e", name: "mcp.notes.echo" },
    ];
    const names = modelToolNames(tools);
    const wire = [...names.values()].map(wireToolName);
    expect(new Set(wire).size).toBe(tools.length);
    expect(wire.every((name) => name.length <= WIRE_NAME_MAX)).toBe(true);
    expect(names.get("a")).toBe("thread.info");
    expect(names.get("e")).toBe("mcp.notes.echo");
    expect(names.get("b")).toMatch(/^thread__info_[0-9a-f]{6}$/);
    expect(wireToolName("mcp.github.search_issues")).toBe("mcp__github__search_issues");
    expect(names.get("c")).toMatch(/_[0-9a-f]{6}$/);
    // The same tools are named the same each run.
    expect(modelToolNames(tools)).toEqual(names);
  });
});

describe("MCP resources", () => {
  it("keep text as text and bytes as their type and size, cut to the cap", () => {
    const blob = (text: string) => Buffer.from(text).toString("base64");
    expect(
      contentsOf([
        { uri: "a", mimeType: "text/plain", text: "hello" },
        { uri: "b", mimeType: "application/json", blob: blob('{"ok":true}') },
        { uri: "c", mimeType: "image/png", blob: blob("png bytes") },
      ]),
    ).toEqual({
      contents: [
        { uri: "a", mimeType: "text/plain", text: "hello" },
        { uri: "b", mimeType: "application/json", text: '{"ok":true}' },
        { uri: "c", mimeType: "image/png", size: 9, note: "Binary content, not shown." },
      ],
    });
    const long = contentsOf([
      { uri: "a", text: "x".repeat(RESOURCE_TEXT_MAX - 1) },
      { uri: "b", text: "yyy" },
    ]);
    expect(long.cut).toBe(true);
    expect(long.contents[1]).toEqual({ uri: "b", text: "y" });
    expect(textLike("application/ld+json; charset=utf-8")).toBe(true);
    expect(textLike("application/octet-stream")).toBe(false);
  });

  it("are listed and read through the server, as built-in tools under mcp._", async () => {
    const { ada, post, calls, model, worker, start, toolRows, db } = await mcpThread();
    expect(
      db.select({ resources: schema.mcpServer.resources }).from(schema.mcpServer).get(),
    ).toEqual({ resources: true });
    start();

    await post(ada, "What resources are there?");
    const first = await calls("mcp._.list_resources", {});
    const second = await model.next();
    expect(first.tools).toEqual(
      expect.arrayContaining(["mcp._.list_resources", "mcp._.read_resource"]),
    );
    expect(second.texts.at(-1)).toContain('"server":"notes","uri":"notes://guide"');
    expect(second.texts.at(-1)).toContain('"uri":"notes://logo.png"');
    second.startStep();
    second.toolCall("read-1", "mcp._.read_resource", { server: "notes", uri: "notes://guide" });
    second.toolCall("read-2", "mcp._.read_resource", { server: "notes", uri: "notes://logo.png" });
    second.toolCall("read-3", "mcp._.read_resource", { server: "nope", uri: "notes://guide" });
    second.endStep();
    second.end();
    const third = await model.next();
    third.reply("Read.");
    await worker.idle();

    const results = third.texts.slice(-3);
    expect(JSON.parse(results[0]!.slice("result mcp._.read_resource: ".length))).toEqual({
      ok: true,
      value: {
        server: "notes",
        uri: "notes://guide",
        contents: [{ uri: "notes://guide", mimeType: "text/markdown", text: NOTES_GUIDE }],
      },
    });
    expect(results[1]).toContain('"size":25,"note":"Binary content, not shown."');
    expect(results[2]).toContain("No server here named nope has resources. Those that do: notes.");
    expect(toolRows().map((row) => row.state)).toEqual(["ran", "ran", "ran", "failed"]);
  });

  it("are offered only while a server that declares them has a tool on", async () => {
    const { ada, api, post, model, worker, start, id, mcpNetwork, server } = await mcpThread();
    start();
    const off = await api("PATCH", "/org/tools", ada.cookie, {
      toolIds: [id("echo"), id("add_note"), id("delete_note")],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    await post(ada, "Hello");
    const none = await model.next();
    none.reply("Hi.");
    await worker.idle();
    expect(none.tools).not.toContain("mcp._.list_resources");

    await api("PATCH", "/org/tools", ada.cookie, { toolIds: [id("echo")], policy: null });
    mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, resources: false });
    expect((await api("POST", `/mcp-servers/${server.id}/refresh`, ada.cookie)).status).toBe(200);
    await post(ada, "Again");
    const undeclared = await model.next();
    undeclared.reply("Hi.");
    await worker.idle();
    expect(undeclared.request.instructions).toContain("- mcp.notes.echo:");
    expect(undeclared.tools).not.toContain("mcp._.list_resources");
  });

  it("of a personal server are read with the login of the sole connected writer", async () => {
    const workspace = await personalThread();
    const { grace, post, calls, model, worker, start, toolRows, connect } = workspace;
    expect((await connect(grace, "person-grace")).status).toBe(200);
    start();

    await post(grace, "Who am I?");
    await calls("mcp._.read_resource", { server: "notes", uri: "notes://whoami" });
    const next = await model.next();
    next.reply("Read.");
    await worker.idle();

    expect(next.texts.at(-1)).toContain('"text":"grace"');
    expect(toolRows()[0]).toMatchObject({ state: "ran", ranAs: { name: "Grace Hopper" } });
  });

  it("of a personal server wait for an approver with a connection, and run as them", async () => {
    const workspace = await personalThread();
    const { grace, server, post, calls, model, worker, start, toolRows, connect, detail, decide } =
      workspace;
    start();

    await post(grace, "Who am I?");
    await calls("mcp._.read_resource", { server: "notes", uri: "notes://whoami" });
    await worker.idle();
    const [waiting] = toolRows();
    expect(waiting).toMatchObject({ state: "pending", waits: true });
    expect(rowIn(await detail(grace), waiting!.id)).toMatchObject({
      connection: { serverId: server.id, connected: false },
    });
    expect((await decide(grace, waiting!.id, "once")).status).toBe(409);
    expect((await connect(grace, "person-grace")).status).toBe(200);
    expect((await decide(grace, waiting!.id, "once")).status).toBe(200);
    const next = await model.next();
    next.reply("Read.");
    await worker.idle();

    expect(next.texts.at(-1)).toContain('"text":"grace"');
    expect(toolRows()[0]).toMatchObject({ state: "ran", ranAs: { name: "Grace Hopper" } });
  });

  it("listed from every server name a personal one rather than list it with someone's login", async () => {
    const workspace = await personalThread();
    const { grace, post, calls, model, worker, start, toolRows } = workspace;
    start();

    await post(grace, "What is there?");
    await calls("mcp._.list_resources", {});
    const next = await model.next();
    next.reply("Listed.");
    await worker.idle();

    expect(toolRows()[0]).toMatchObject({ state: "ran", waits: false });
    expect(next.texts.at(-1)).toContain('"resources":[]');
    expect(next.texts.at(-1)).toContain("name one to list its resources: notes.");
  });
});

describe("searching for MCP tools", () => {
  // Answers the model's call with the given tool calls, one step.
  function step(call: Call, ...calls: [string, unknown][]) {
    call.startStep();
    for (const [index, [toolId, input]] of calls.entries()) {
      call.toolCall(`call-${index}-${Math.random()}`, toolId, input);
    }
    call.endStep();
    call.end();
  }

  it("leaves the tools out, names them in the prompt, and turns on those a query finds", async () => {
    const { ada, post, model, worker, start, named, toolRows } = await mcpThread();
    start();

    await post(ada, "Echo hello");
    const first = await model.next();
    expect(first.tools).toContain("mcp._.search_tools");
    expect(first.tools).toContain("mcp._.list_resources");
    expect(first.tools).not.toContain(named("echo"));
    expect(first.request.instructions).toContain(
      `Notes (mcp.notes.*):\n- ${named("echo")}: Say the text back.`,
    );
    // The server's own instructions stay, before the list.
    expect(first.request.instructions.indexOf(NOTES_INSTRUCTIONS)).toBeLessThan(
      first.request.instructions.indexOf("Notes (mcp.notes.*)"),
    );
    step(
      first,
      [named("echo"), { text: "too soon" }],
      ["mcp._.search_tools", { query: "echo text" }],
    );
    const second = await model.next();
    expect(second.texts.slice(-2)[0]).toContain(
      `${named("echo")} is not on yet. Search for it or select it with mcp._.search_tools first.`,
    );
    expect(second.texts.at(-1)).toContain(`"turnedOn":["${named("echo")}"]`);
    expect(second.texts.at(-1)).toContain('"parameters":"text: string"');
    expect(second.tools).toContain(named("echo"));
    expect(second.tools).not.toContain(named("add_note"));
    expect(second.request.instructions).not.toContain(`- ${named("echo")}:`);
    step(second, [named("echo"), { text: "hello" }]);
    const third = await model.next();
    third.reply("Said.");
    await worker.idle();

    expect(third.texts.at(-1)).toBe(
      `result ${named("echo")}: {"ok":true,"value":{"text":"hello"}}`,
    );
    expect(toolRows(true).map((row) => [row.toolId, row.state])).toEqual([
      [expect.stringContaining("/echo"), "failed"],
      ["mcp._.search_tools", "ran"],
      [expect.stringContaining("/echo"), "ran"],
    ]);
  });

  it("selects tools by name, says what it meant by an unknown one, and lists a server's", async () => {
    const { ada, post, model, worker, start, named } = await mcpThread();
    start();

    await post(ada, "Look around");
    step(
      await model.next(),
      ["mcp._.search_tools", { select: ["add_note", "mcp.notes.delete_nte"] }],
      ["mcp._.search_tools", { server: "notes" }],
    );
    const next = await model.next();
    next.reply("Done.");
    await worker.idle();

    const [selected, listed] = next.texts.slice(-2);
    expect(selected).toContain(`"turnedOn":["${named("add_note")}"]`);
    expect(selected).toContain(
      `"unknown":[{"name":"mcp.notes.delete_nte","didYouMean":["${named("delete_note")}"]}]`,
    );
    expect(listed).toContain('"server":{"name":"Notes","tools":[');
    expect(listed).toContain(`"turnedOn":[]`);
    expect(next.tools).toContain(named("add_note"));
    expect(next.tools).not.toContain(named("echo"));
  });

  it("keeps the tools turned on when the run resumes after a decision", async () => {
    const { ada, api, thread, post, model, worker, start, named, toolRows, db } = await mcpThread();
    start();

    await post(ada, "Delete the missing note");
    step(await model.next(), ["mcp._.search_tools", { select: [named("delete_note")] }]);
    step(await model.next(), [named("delete_note"), { id: "missing" }]);
    await worker.idle();
    const waiting = toolRows().at(-1)!;
    expect(waiting).toMatchObject({ state: "pending", waits: true });
    const stored = db.select({ toolsOn: schema.run.toolsOn }).from(schema.run).get();
    expect(stored?.toolsOn).toEqual([waiting.toolId]);

    const decided = await api(
      "POST",
      `/threads/${thread.id}/tools/${waiting.id}/decision`,
      ada.cookie,
      { allow: true, scope: "once" },
    );
    expect(decided.status).toBe(200);
    const resumed = await model.next();
    expect(resumed.tools).toContain(named("delete_note"));
    expect(resumed.texts.at(-1)).toContain("No note has id missing.");
    resumed.reply("Gone already.");
    await worker.idle();

    // The next run starts with them left out again.
    await post(ada, "Again");
    const next = await model.next();
    expect(next.tools).not.toContain(named("delete_note"));
    next.reply("Hi.");
    await worker.idle();
  });

  it("cannot be turned off or put under a policy, and is offered and listed only with MCP servers", async () => {
    const { ada, api, space, post, model, worker, start, server } = await mcpThread();
    expect((await api("PUT", "/org/toolsets/mcp._", ada.cookie, { enabled: false })).status).toBe(
      404,
    );
    expect(
      (await api("PUT", `/spaces/${space.id}/toolsets/mcp._`, ada.cookie, { enabled: false }))
        .status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", "/org/tools", ada.cookie, {
          toolIds: ["mcp._.search_tools"],
          policy: "off",
        })
      ).status,
    ).toBe(404);
    type Listed = { id: string; fixed?: boolean; enabled?: boolean; tools: { fixed?: boolean }[] };
    const listed = async (path: string) =>
      ((await (await api("GET", path, ada.cookie)).json()) as Listed[]).find(
        (toolset) => toolset.id === "mcp._",
      );
    // Settings show it always on, its tools too.
    for (const path of ["/org/tools", `/spaces/${space.id}/tools`]) {
      const own = await listed(path);
      expect(own).toMatchObject({ fixed: true, enabled: true });
      expect(own!.tools.length).toBeGreaterThan(0);
      expect(own!.tools.every((tool) => tool.fixed)).toBe(true);
    }

    start();
    await post(ada, "Hello");
    const on = await model.next();
    on.reply("Hi.");
    await worker.idle();
    expect(on.tools).toContain("mcp._.search_tools");

    await api("DELETE", `/mcp-servers/${server.id}`, ada.cookie);
    await post(ada, "Again");
    const none = await model.next();
    none.reply("Hi.");
    await worker.idle();
    expect(none.tools).not.toContain("mcp._.search_tools");
    expect(none.request.instructions).not.toContain("mcp._.search_tools");
    expect(await listed("/org/tools")).toBeUndefined();
    expect(await listed(`/spaces/${space.id}/tools`)).toBeUndefined();
  });
});

describe("what a tool call is called", () => {
  it("is its tool's title and server, recorded when asked for and kept once the server is removed", async () => {
    const workspace = await mcpThread();
    const { ada, api, thread, post, calls, model, worker, start, id, events, server } = workspace;
    start();

    await post(ada, "Write a note");
    await calls(id("add_note"), { title: "Engines" });
    const next = await model.next();
    next.reply("Written.");
    await worker.idle();

    const requested = events().find(
      (event) =>
        event.type === "tool.requested" &&
        (event.data as { toolId: string }).toolId === id("add_note"),
    );
    expect(requested?.data).toMatchObject({ title: "Add note", toolset: "Notes" });
    const callId = (requested!.data as { callId: string }).callId;
    const shown = async () => {
      const res = await api("GET", `/threads/${thread.id}`, ada.cookie);
      return rowIn((await res.json()) as ThreadDetail, callId);
    };
    expect(await shown()).toMatchObject({ title: "Add note", toolset: "Notes" });

    // The server lists the tool under another title now.
    const stored = workspace.mcpServerStore.find(server.id)!;
    workspace.mcpServerStore.update(server.id, {
      tools: stored.tools.map((tool) =>
        tool.name === "add_note" ? { ...tool, title: "Write note" } : tool,
      ),
    });
    expect(await shown()).toMatchObject({ title: "Write note", toolset: "Notes" });

    // It no longer lists the tool: the names the call was asked for under.
    workspace.mcpServerStore.update(server.id, {
      tools: stored.tools.filter((tool) => tool.name !== "add_note"),
    });
    expect(await shown()).toMatchObject({ title: "Add note", toolset: "Notes" });

    workspace.mcpServerStore.update(server.id, { tools: stored.tools });
    expect((await api("DELETE", `/mcp-servers/${server.id}`, ada.cookie)).status).toBe(200);
    expect(await shown()).toMatchObject({ title: "Add note", toolset: "Notes" });
  });

  it("for a call recorded without names is what the model knows it by, else its own name", async () => {
    const { ada, api, server, tools, space, id } = await mcpThread();
    const call = (toolId: string, input: unknown = {}, state: "ran" | "pending" = "ran") =>
      tools.namesIn({ id: space.id, orgId: ada.orgId })({ toolId, input, state });

    expect(call(id("delete_note"))).toEqual({ title: "Delete note", toolset: "Notes" });
    expect(call(id("gone"))).toEqual({ title: "mcp.notes.gone", toolset: null });
    expect((await api("DELETE", `/mcp-servers/${server.id}`, ada.cookie)).status).toBe(200);
    expect(call(id("delete_note"))).toEqual({ title: "delete_note", toolset: null });

    // Mage's own, under their former ids too, and loading a skill names the skill.
    expect(call("mcp._.search_tools")).toMatchObject({ title: "Search tools" });
    expect(call("tools.search")).toEqual(call("mcp._.search_tools"));
    expect(call("skills.load", { name: "review" })).toMatchObject({ title: "Loaded review" });
    expect(call("skills.load", { name: "review" }, "pending")).toMatchObject({
      title: "Load review",
    });
  });
});

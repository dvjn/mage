import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";
import {
  mergeHeaders,
  outputOf,
  riskOfAnnotations,
  secretHint,
  uniqueSlug,
} from "@/services/mcp-servers.ts";
import { modelToolNames } from "@/services/tools.ts";
import { mcpHeadersInputSchema, type McpServerSummary, mcpSlugOf } from "@/shared/mcp.ts";
import type { ThreadDetail } from "@/shared/threads.ts";
import {
  EDITORS,
  TOOL_OFF,
  type ToolsetSetting,
  WIRE_NAME_MAX,
  wireToolName,
} from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { MCP_API_KEY, MCP_BEARER_TOKEN, MODERN_REVISION, mcpStandIn } from "../e2e/mcp-server.ts";
import { agentThread } from "./agent-thread.ts";
import { MCP_ORIGIN, setup } from "./workspace.ts";

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
    expect(await methodsOf(mcpNetwork.requests)).toEqual(["server/discover", "tools/list"]);
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
  async function calls(toolId: string, input: unknown) {
    const call = await model.next();
    call.startStep();
    call.toolCall(`call-${model.calls.length}`, toolId, input);
    call.endStep();
    call.end();
    return call;
  }
  function toolRows() {
    return transcriptOf(events()).rows.filter((row) => row.kind === "tool");
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

    expect(first.tools).toEqual(expect.arrayContaining([named("echo"), named("add_note")]));
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
    expect(first.tools).not.toContain(named("echo"));
    expect(first.tools).toContain(named("add_note"));

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
    expect(first.tools).toEqual(expect.arrayContaining(["mcp.pad.echo", "mcp.pad.add_note"]));
    expect(workspace.toolRows().map((row) => [row.toolId, row.state])).toEqual([
      [id("add_note"), "ran"],
    ]);
    expect(next.texts.filter((text) => text.startsWith("tool"))).toEqual([
      'tool mcp.pad.add_note: {"title":"T","body":"B"}',
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

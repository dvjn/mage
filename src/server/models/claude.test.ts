import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import { createApp } from "@/server/app.ts";
import { openDatabase } from "@/server/db/db.ts";
import type { Guests } from "@/server/guests/service.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import { createClaudeOAuth } from "@/server/models/hosts/anthropic-claude.ts";
import { createCodexOAuth } from "@/server/models/hosts/openai-codex.ts";
import { createAuth, createIdentity } from "@/server/orgs/auth.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import * as schema from "@/server/schema.ts";
import type { Skills } from "@/server/skills/service.ts";
import type { Artifacts } from "@/server/artifacts/service.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import type { Threads } from "@/server/threads/service.ts";

import { createConnectionStore } from "./connection-store.ts";
import { createCredentialStore } from "./credential-store.ts";
import { createConnections } from "./connections.ts";
import type { Models } from "./service.ts";

const baseUrl = "http://localhost:4783";
const tokenUrl = "https://platform.claude.com/v1/oauth/token";
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const redirectUri = "https://platform.claude.com/oauth/code/callback";

type Reply = { status: number; body?: unknown };

function setup() {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const credentials = createCredentialStore(
    db,
    createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
  );
  const clock = { now: new Date("2026-10-21T10:00:00Z") };
  const requests: { url: string; body: Record<string, string> }[] = [];
  const anthropic = { exchange: { status: 200 } as Reply, refresh: { status: 200 } as Reply };
  let serial = 0;

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, string>;
    requests.push({ url: request.url, body });
    const answer = body.grant_type === "refresh_token" ? anthropic.refresh : anthropic.exchange;
    if (request.url !== tokenUrl) return new Response(null, { status: 404 });
    if (answer.status !== 200 || answer.body) return Response.json(answer.body ?? {}, answer);
    serial += 1;
    return Response.json({
      access_token: `sk-ant-oat-${serial}`,
      refresh_token: `secret-refresh-${serial}`,
      expires_in: 3600,
      account: { uuid: "acct-123", email_address: "ada@claude.example" },
    });
  };

  const connections = createConnections({
    connections: createConnectionStore(db),
    credentials,
    providers: {
      codex: { label: "ChatGPT", oauth: createCodexOAuth(fakeFetch as typeof fetch) },
      claude: { label: "Claude", oauth: createClaudeOAuth(fakeFetch as typeof fetch) },
    },
    logger,
    now: () => clock.now,
  });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
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
    logger,
    signInOptions: { oidc: null },
    pingDatabase: () => Promise.resolve(true),
  });

  async function signUp(name: string, email: string) {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ name, email, password: "correct horse battery" }),
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    const cookie = res.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { userId: user.id, cookie };
  }

  function api(method: string, path: string, cookie: string, body?: object) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body && JSON.stringify(body),
    });
  }

  async function start(cookie: string) {
    const res = await api("POST", "/connections/claude/authorization", cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { attemptId: string; authorizeUrl: string };
  }

  function finish(cookie: string, attemptId: string, code: string) {
    return api("POST", `/connections/claude/attempts/${attemptId}/code`, cookie, { code });
  }

  // A Claude account connected with the code its authorization shows.
  async function connect(cookie: string) {
    const { attemptId } = await start(cookie);
    const res = await finish(cookie, attemptId, `the-code#${attemptId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  function orgOf(userId: string) {
    return db.select().from(schema.member).where(eq(schema.member.userId, userId)).get()
      ?.organizationId as string;
  }

  return {
    db,
    clock,
    requests,
    anthropic,
    credentials,
    connections,
    signUp,
    api,
    start,
    finish,
    connect,
    orgOf,
  };
}

async function rejected(res: Response, status: number, message: RegExp) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: string }).error).toMatch(message);
}

describe("Claude sign-in", () => {
  it("opens Claude Code's authorization, its state the attempt and its challenge the verifier's", async () => {
    const { requests, signUp, start } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const { attemptId, authorizeUrl } = await start(cookie);

    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope:
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
      state: attemptId,
    });
    expect(requests).toEqual([]);
  });

  it("exchanges the pasted code with the verifier and keeps the tokens sealed", async () => {
    const { db, requests, credentials, signUp, start, finish } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId, authorizeUrl } = await start(cookie);

    const res = await finish(cookie, attemptId, ` the-code#${attemptId} `);

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { id: string };
    expect(connection).toEqual({
      id: expect.any(String),
      host: "claude",
      authKind: "oauth",
      account: "ada@claude.example",
      label: null,
      settings: {},
      hints: {},
      proxy: null,
      createdAt: expect.any(String),
    });
    expect(requests).toHaveLength(1);
    const { code_verifier: verifier, ...sent } = requests[0]!.body;
    expect(requests[0]?.url).toBe(tokenUrl);
    expect(sent).toEqual({
      client_id: clientId,
      grant_type: "authorization_code",
      code: "the-code",
      state: attemptId,
      redirect_uri: redirectUri,
    });
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(
      new URL(authorizeUrl).searchParams.get("code_challenge"),
    );
    expect(db.select().from(schema.connection).all()).toEqual([
      expect.objectContaining({ id: connection.id, createdBy: userId }),
    ]);
    expect(db.select().from(schema.credential).get()?.sealed.toString("latin1")).not.toContain(
      "secret-refresh",
    );
    expect(credentials.get(connection.id)).toEqual({
      access: "sk-ant-oat-1",
      refresh: "secret-refresh-1",
      expires: new Date("2026-10-21T11:00:00Z").getTime(),
      accountId: "acct-123",
      email: "ada@claude.example",
    });
  });

  it("refuses a code from another sign-in, and one tried already", async () => {
    const { requests, signUp, start, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await start(cookie);

    await rejected(await finish(cookie, attemptId, "the-code#other"), 400, /different sign-in/);
    await rejected(await finish(cookie, attemptId, "   "), 400, /Paste the code/);
    expect(requests).toEqual([]);

    expect((await finish(cookie, attemptId, "the-code")).status).toBe(200);
    await rejected(await finish(cookie, attemptId, "the-code"), 404, /Start again/);
  });

  it("refuses a sign-in that expired or another user started", async () => {
    const { clock, signUp, start, finish } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const { attemptId } = await start(ada.cookie);

    await rejected(await finish(grace.cookie, attemptId, "the-code"), 404, /not found/);
    clock.now = new Date("2026-10-21T10:16:00Z");
    await rejected(await finish(ada.cookie, attemptId, "the-code"), 400, /expired/);
  });

  it("reports an exchange Anthropic refuses, and saves nothing", async () => {
    const { db, anthropic, signUp, start, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    for (const answer of [
      { status: 400, body: { error: "invalid_grant" } },
      { status: 200, body: { access_token: "only-this" } },
    ]) {
      anthropic.exchange = answer;
      const { attemptId } = await start(cookie);
      await rejected(await finish(cookie, attemptId, "the-code"), 502, /did not accept/);
    }
    expect(db.select().from(schema.connection).all()).toEqual([]);
  });

  it("allows one Claude sign-in per org, and none in a team org", async () => {
    const { db, signUp, connect, api } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    await connect(cookie);

    await rejected(await api("POST", "/connections/claude/authorization", cookie), 409, /already/);

    db.insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "team", createdAt: new Date() })
      .run();
    db.insert(schema.member)
      .values({ id: "m", organizationId: "acme", userId, role: "owner", createdAt: new Date() })
      .run();
    db.update(schema.session).set({ activeOrganizationId: "acme" }).run();
    expect((await api("POST", "/connections/claude/authorization", cookie)).status).toBe(403);
  });

  it("renews a token close to expiry with the refresh token", async () => {
    const { connections, credentials, clock, requests, signUp, connect, orgOf } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { id } = await connect(cookie);
    requests.length = 0;
    clock.now = new Date("2026-10-21T10:56:00Z");

    const token = await connections.withFreshToken(orgOf(userId), id, async (t) => t);

    expect(token).toEqual({ access: "sk-ant-oat-2", accountId: "acct-123", proxy: null });
    expect(requests).toEqual([
      {
        url: tokenUrl,
        body: {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: "secret-refresh-1",
        },
      },
    ]);
    expect(credentials.get(id)).toMatchObject({
      refresh: "secret-refresh-2",
      expires: new Date("2026-10-21T11:56:00Z").getTime(),
    });
  });
});

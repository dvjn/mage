import { eq } from "drizzle-orm";
import type { Tasks } from "@/server/tasks/tasks.ts";
import type { Schedules } from "@/server/schedules/schedules.ts";
import type { Webhooks } from "@/server/webhooks/webhooks.ts";
import { UnsecuredJWT } from "jose";
import { describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/tools/policies.ts";
import type { ToolDecisions } from "@/server/tools/registry.ts";
import { createApp } from "@/server/app.ts";
import { expireLeases, openStoreDatabase } from "@/server/testing/database.ts";
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
import type { Threads } from "@/server/threads/threads.ts";

import { createConnectionStore } from "./connection-store.ts";
import { createOAuthAttempts } from "@/server/oauth/attempts.ts";
import { createCredentialStore } from "./credential-store.ts";
import { createConnections } from "./connections.ts";
import type { Models } from "./service.ts";

const baseUrl = "http://localhost:4783";
const tokenUrl = "https://auth.openai.com/oauth/token";
const userCodeUrl = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const deviceTokenUrl = "https://auth.openai.com/api/accounts/deviceauth/token";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
// Never called by these tests.
const unusedModels = {} as Models;
const unusedSpaces = {} as Spaces;
const unusedThreads = {} as Threads;
const unusedGuests = {} as Guests;

function accessToken(serial: number, accountId: string | null = "acct-123") {
  return new UnsecuredJWT({
    serial,
    "https://api.openai.com/auth": accountId
      ? { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" }
      : {},
    "https://api.openai.com/profile": { email: "ada@chatgpt.example" },
  }).encode();
}

type Reply = { status: number; body?: unknown };

function setup() {
  const db = openStoreDatabase();
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const cipher = createCipher({ version: 1, key: Buffer.alloc(32, 7) });
  const credentials = createCredentialStore(db, cipher);
  const clock = { now: new Date("2026-10-21T10:00:00Z") };
  const requests: { url: string; body: Record<string, string> }[] = [];
  const openai = {
    userCode: { status: 200 } as Reply,
    // Answers to device polls in order; pending once they run out.
    polls: [] as Reply[],
    exchange: { status: 200 } as Reply,
    accountId: "acct-123" as string | null,
    refresh: { status: 200 } as Reply,
    // Holds refresh answers until released.
    refreshGate: null as Promise<void> | null,
    serial: 0,
  };
  const sleeps: number[] = [];
  // When set, the test asks nothing of the provider: the sign-in stays pending.
  const waits = { hold: false };

  async function answer(url: string, body: Record<string, string>): Promise<Reply> {
    if (url === userCodeUrl) {
      return openai.userCode.status === 200
        ? { status: 200, body: { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "5" } }
        : openai.userCode;
    }
    if (url === deviceTokenUrl) return openai.polls.shift() ?? { status: 403 };
    if (url !== tokenUrl) return { status: 404 };
    if (body.grant_type === "refresh_token") {
      if (openai.refreshGate) await openai.refreshGate;
      if (openai.refresh.status !== 200) return openai.refresh;
    } else if (openai.exchange.status !== 200 || openai.exchange.body) {
      return openai.exchange;
    }
    openai.serial += 1;
    return {
      status: 200,
      body: {
        id_token: new UnsecuredJWT({ email: "ada@chatgpt.example" }).encode(),
        access_token: accessToken(openai.serial, openai.accountId),
        refresh_token: `secret-refresh-${openai.serial}`,
        expires_in: 3600,
      },
    };
  }

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body = request.headers.get("content-type")?.includes("json")
      ? (JSON.parse(text) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(text));
    requests.push({ url: request.url, body });
    const reply = await answer(request.url, body);
    return reply.body === undefined
      ? new Response(null, { status: reply.status })
      : Response.json(reply.body, { status: reply.status });
  };

  const codex = createCodexOAuth(fakeFetch as typeof fetch);
  const connections = createConnections({
    connections: createConnectionStore(db),
    credentials,
    providers: {
      codex: { label: "Codex", oauth: codex },
      claude: { label: "Claude", oauth: createClaudeOAuth(fakeFetch as typeof fetch) },
    },
    logger,
    now: () => clock.now,
    attempts: createOAuthAttempts({ db, cipher }),
    instanceId: "test",
    transact: async (work) => work(),
  });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    models: unusedModels,
    spaces: unusedSpaces,
    threads: unusedThreads,
    guests: unusedGuests,
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
    tasks: {} as Tasks,
    schedules: {} as Schedules,
    webhooks: {} as Webhooks,
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

  async function startDevice(cookie: string) {
    const res = await api("POST", "/connections/codex/device", cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { attemptId: string; verificationUrl: string; userCode: string };
  }

  function attempt(cookie: string, id: string) {
    return api("GET", `/connections/codex/attempts/${id}`, cookie);
  }

  // A ChatGPT account connected with a code approved at once.
  async function connect(cookie: string) {
    openai.polls = [
      { status: 200, body: { authorization_code: "device-code", code_verifier: "their-verifier" } },
    ];
    const { attemptId } = await startDevice(cookie);
    const result = await settled(cookie, attemptId);
    expect(result.status).toBe("connected");
    return result.connection as { id: string };
  }

  // The attempt once nothing waits on it any more: the provider asked as the pass asks it, the
  // clock moved on to each next ask, and each wait kept.
  async function settled(cookie: string, id: string) {
    for (let i = 0; i < 1000; i += 1) {
      await connections.askDevices();
      const body = (await (await attempt(cookie, id)).json()) as {
        status: string;
        connection?: { id: string };
      };
      if (body.status !== "pending") return body;
      const [row] = await db
        .select({ next: schema.oauthAttempt.nextPollAt })
        .from(schema.oauthAttempt)
        .where(eq(schema.oauthAttempt.state, id));
      const wait = (row?.next?.getTime() ?? 0) - clock.now.getTime();
      if (wait > 0) {
        sleeps.push(wait);
        clock.now = new Date(clock.now.getTime() + wait);
      }
    }
    throw new Error("sign-in still pending");
  }

  async function orgOf(userId: string) {
    return (
      await db.select().from(schema.member).where(eq(schema.member.userId, userId)).limit(1)
    )[0]?.organizationId as string;
  }

  return {
    db,
    clock,
    requests,
    openai,
    sleeps,
    waits,
    credentials,
    connections,
    // The same connections as another instance on the database sees them.
    elsewhere: createConnections({
      connections: createConnectionStore(db),
      credentials,
      providers: {
        codex: { label: "Codex", oauth: codex },
        claude: { label: "Claude", oauth: createClaudeOAuth(fakeFetch as typeof fetch) },
      },
      logger,
      now: () => clock.now,
      attempts: createOAuthAttempts({ db, cipher }),
      instanceId: "elsewhere",
      transact: async (work) => work(),
    }),
    signUp,
    api,
    connect,
    startDevice,
    attempt,
    settled,
    orgOf,
  };
}

async function rejected(res: Response, status: number, message: RegExp) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: string }).error).toMatch(message);
}

describe("device code sign-in", () => {
  it("polls until approved, slowing down when asked, then exchanges the code", async () => {
    const { db, requests, openai, sleeps, credentials, signUp, startDevice, settled } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    openai.polls = [
      { status: 403 },
      { status: 400, body: { error: { code: "deviceauth_authorization_pending" } } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { authorization_code: "device-code", code_verifier: "their-verifier" } },
    ];

    const started = await startDevice(cookie);

    expect(started).toEqual({
      attemptId: expect.any(String),
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    const result = await settled(cookie, started.attemptId);
    expect(result).toEqual({
      status: "connected",
      connection: {
        id: expect.any(String),
        host: "codex",
        authKind: "oauth",
        account: "ada@chatgpt.example",
        label: null,
        settings: {},
        hints: {},
        proxy: null,
        createdAt: expect.any(String),
      },
    });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(requests[0]).toEqual({ url: userCodeUrl, body: { client_id: clientId } });
    expect(requests.slice(1, 5).map((r) => r.body)).toEqual(
      Array(4).fill({ device_auth_id: "dev-1", user_code: "ABCD-EFGH" }),
    );
    expect(requests[5]).toEqual({
      url: tokenUrl,
      body: {
        client_id: clientId,
        grant_type: "authorization_code",
        code: "device-code",
        code_verifier: "their-verifier",
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      },
    });
    expect(await db.select().from(schema.connection)).toEqual([
      expect.objectContaining({ id: result.connection?.id, createdBy: userId }),
    ]);
    expect(
      (await db.select().from(schema.credential).limit(1))[0]?.sealed.toString("latin1"),
    ).not.toContain("secret-refresh");
    expect(await credentials.get(result.connection?.id ?? "")).toEqual({
      access: accessToken(1),
      refresh: "secret-refresh-1",
      expires: new Date("2026-10-21T11:00:20Z").getTime(),
      accountId: "acct-123",
      email: "ada@chatgpt.example",
      plan: "plus",
    });
  });

  it("reports an exchange OpenAI refuses or answers without an account", async () => {
    const { db, openai, signUp, startDevice, settled } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const approved = {
      status: 200,
      body: { authorization_code: "device-code", code_verifier: "their-verifier" },
    };

    for (const answer of [
      () => (openai.exchange = { status: 400, body: { error: "invalid_grant" } }),
      () => (openai.exchange = { status: 200, body: { access_token: "only-this" } }),
      () => {
        openai.exchange = { status: 200 };
        openai.accountId = null;
      },
    ]) {
      answer();
      openai.polls = [approved];
      const { attemptId } = await startDevice(cookie);
      expect(await settled(cookie, attemptId)).toEqual({
        status: "failed",
        error: expect.stringMatching(/did not accept/),
      });
    }
    expect(await db.select().from(schema.connection)).toEqual([]);
    expect(await db.select().from(schema.credential)).toEqual([]);
  });

  it("gives up when the code expires", async () => {
    const { db, sleeps, signUp, startDevice, settled } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const { attemptId } = await startDevice(cookie);

    expect(await settled(cookie, attemptId)).toEqual({
      status: "failed",
      error: expect.stringMatching(/expired/),
    });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(15 * 60 * 1000);
    expect(await db.select().from(schema.connection)).toEqual([]);
  });

  it("stops polling when cancelled", async () => {
    const { requests, waits, signUp, startDevice, attempt, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    waits.hold = true;
    const { attemptId } = await startDevice(cookie);
    expect(await (await attempt(cookie, attemptId)).json()).toEqual({ status: "pending" });

    const res = await api("POST", `/connections/codex/attempts/${attemptId}/cancel`, cookie);

    expect(res.status).toBe(200);
    expect(await (await attempt(cookie, attemptId)).json()).toEqual({
      status: "failed",
      error: expect.stringMatching(/cancelled/),
    });
    const polls = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(polls);
  });

  it("cancels the user's earlier device sign-in when they start another", async () => {
    const { waits, signUp, startDevice, attempt } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    waits.hold = true;
    const first = await startDevice(cookie);

    const second = await startDevice(cookie);

    expect(await (await attempt(cookie, first.attemptId)).json()).toMatchObject({
      status: "failed",
    });
    expect(await (await attempt(cookie, second.attemptId)).json()).toEqual({ status: "pending" });
  });

  it("fails when OpenAI ends the sign-in", async () => {
    const { openai, signUp, startDevice, settled } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    openai.polls = [{ status: 400, body: { error: "access_denied" } }];

    const { attemptId } = await startDevice(cookie);

    expect(await settled(cookie, attemptId)).toEqual({
      status: "failed",
      error: expect.stringMatching(/did not accept/),
    });
  });

  it("reports when OpenAI gives no code", async () => {
    const { openai, signUp, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    openai.userCode = { status: 404 };

    await rejected(await api("POST", "/connections/codex/device", cookie), 502, /Try again\.$/);
  });

  it("shows a sign-in only to the user who started it", async () => {
    const { waits, signUp, startDevice, attempt, api } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    waits.hold = true;
    const { attemptId } = await startDevice(ada.cookie);

    expect((await attempt(grace.cookie, attemptId)).status).toBe(404);
    const cancel = `/connections/codex/attempts/${attemptId}/cancel`;
    expect((await api("POST", cancel, grace.cookie)).status).toBe(404);
    expect(await (await attempt(ada.cookie, attemptId)).json()).toEqual({ status: "pending" });
  });
});

describe("device code sign-in on many instances", () => {
  const polls = (requests: { url: string }[]) =>
    requests.filter((request) => request.url === deviceTokenUrl).length;

  it("is approved with nobody reading where it stands, asked once by two instances at once", async () => {
    const { db, requests, openai, connections, elsewhere, signUp, startDevice } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    openai.polls = [
      { status: 200, body: { authorization_code: "device-code", code_verifier: "their-verifier" } },
    ];
    await startDevice(cookie);
    await Promise.all([connections.askDevices(), elsewhere.askDevices()]);
    expect(polls(requests)).toBe(1);
    expect(await db.select().from(schema.connection)).toHaveLength(1);
  });

  it("is asked by another instance once the one asking stops mid-ask and its hold runs out", async () => {
    const { db, requests, connections, elsewhere, signUp, startDevice, clock } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await startDevice(cookie);
    // Held by an instance that went away before it asked.
    const attempts = createOAuthAttempts({
      db,
      cipher: createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
    });
    expect(await attempts.hold(attemptId, clock.now, "gone", 60_000)).not.toBeNull();
    await elsewhere.askDevices();
    expect(polls(requests)).toBe(0);
    await db
      .update(schema.oauthAttempt)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.oauthAttempt.state, attemptId));
    await connections.askDevices();
    expect(polls(requests)).toBe(1);
  });

  it("is asked nothing more once cancelled", async () => {
    const { requests, connections, signUp, startDevice, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await startDevice(cookie);
    await api("POST", `/connections/codex/attempts/${attemptId}/cancel`, cookie);
    await connections.askDevices();
    expect(polls(requests)).toBe(0);
  });
});

describe("fresh tokens", () => {
  async function connected() {
    const context = setup();
    const { userId, cookie } = await context.signUp("Ada Lovelace", "ada@example.com");
    const { id } = await context.connect(cookie);
    context.requests.length = 0;
    return { ...context, id, orgId: await context.orgOf(userId) };
  }

  it("uses a token that is not about to expire as it is", async () => {
    const { connections, requests, id, orgId } = await connected();

    const token = await connections.withFreshToken(orgId, id, async (t) => t);

    expect(token).toEqual({ access: accessToken(1), accountId: "acct-123", proxy: null });
    expect(requests).toEqual([]);
  });

  it("renews a token close to expiry and keeps the rotated refresh token", async () => {
    const { connections, credentials, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T10:56:00Z");

    const token = await connections.withFreshToken(orgId, id, async (t) => t);

    expect(token).toEqual({ access: accessToken(2), accountId: "acct-123", proxy: null });
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
    expect(await credentials.get(id)).toMatchObject({
      access: accessToken(2),
      refresh: "secret-refresh-2",
      expires: new Date("2026-10-21T11:56:00Z").getTime(),
    });
  });

  it("renews once for callers that arrive together", async () => {
    const { connections, openai, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    let release = () => {};
    openai.refreshGate = new Promise((resolve) => {
      release = resolve;
    });

    const both = Promise.all([
      connections.withFreshToken(orgId, id, async (t) => t.access),
      connections.withFreshToken(orgId, id, async (t) => t.access),
    ]);
    release();

    expect(await both).toEqual([accessToken(2), accessToken(2)]);
    expect(requests).toHaveLength(1);
    await connections.withFreshToken(orgId, id, async (t) => t);
    expect(requests).toHaveLength(1);
  });

  it("is renewed by one instance when two renew at once, and both use the new token", async () => {
    const { connections, elsewhere, openai, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    let release = () => {};
    openai.refreshGate = new Promise((resolve) => {
      release = resolve;
    });

    const both = Promise.all([
      connections.withFreshToken(orgId, id, async (t) => t.access),
      elsewhere.withFreshToken(orgId, id, async (t) => t.access),
    ]);
    release();

    expect(await both).toEqual([accessToken(2), accessToken(2)]);
    expect(requests).toHaveLength(1);
  });

  it("is renewed by another instance once the one renewing stops and its lease runs out", async () => {
    const { db, connections, credentials, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    // Held by an instance that went away before it asked.
    expect(await credentials.lease(id, "gone", 60_000)).not.toBeNull();

    const renewed = connections.withFreshToken(orgId, id, async (t) => t.access);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toEqual([]);
    await expireLeases(db, "credential");

    expect(await renewed).toBe(accessToken(2));
    expect(requests).toHaveLength(1);
  });

  it("keeps a renewal whose lease ran out while it asked, when nobody renewed since", async () => {
    const { db, connections, credentials, openai, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    let release = () => {};
    openai.refreshGate = new Promise((resolve) => {
      release = resolve;
    });
    const renewed = connections.withFreshToken(orgId, id, async (t) => t.access);
    while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    // Its lease ran out and another instance took it, then let it go without renewing.
    await expireLeases(db, "credential");
    const other = await credentials.lease(id, "other", 60_000);
    await credentials.release(id, other!);
    release();

    expect(await renewed).toBe(accessToken(2));
    expect(await credentials.get(id)).toMatchObject({ refresh: "secret-refresh-2" });
  });

  it("is not renewed again after a refusal once another token is stored", async () => {
    const { connections, requests, id, orgId } = await connected();

    const token = await connections.withFreshToken(orgId, id, async (t) => t.access, {
      force: true,
      refused: "a token renewed since",
    });

    expect(token).toBe(accessToken(1));
    expect(requests).toEqual([]);
  });

  it("reports a renewal OpenAI refuses and keeps the old credential", async () => {
    const { connections, credentials, openai, clock, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    openai.refresh = { status: 401 };
    const before = await credentials.get(id);

    await expect(connections.withFreshToken(orgId, id, async (t) => t)).rejects.toThrow(
      /could not be renewed/,
    );
    expect(await credentials.get(id)).toEqual(before);
  });

  it("finds only the org's own connections", async () => {
    const { connections, id } = await connected();

    await expect(connections.withFreshToken("other-org", id, async (t) => t)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("/api/v1/connections", () => {
  it("is unauthorized when signed out", async () => {
    const { api } = setup();
    expect((await api("GET", "/connections", "")).status).toBe(401);
    expect((await api("POST", "/connections/codex/device", "")).status).toBe(401);
  });

  it("lists connections without their credentials", async () => {
    const { signUp, connect, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { id } = await connect(cookie);

    const res = await api("GET", "/connections", cookie);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/secret|token|acct|plus/);
    expect(JSON.parse(text)).toEqual([
      {
        id,
        host: "codex",
        authKind: "oauth",
        account: "ada@chatgpt.example",
        label: null,
        settings: {},
        hints: {},
        proxy: null,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("allows one Codex connection per org", async () => {
    const { signUp, connect, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    await connect(cookie);

    await rejected(await api("POST", "/connections/codex/device", cookie), 409, /already/);
  });

  it("deletes a connection and its credential without calling OpenAI", async () => {
    const { db, requests, signUp, connect, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { id } = await connect(cookie);
    requests.length = 0;

    const res = await api("DELETE", `/connections/${id}`, cookie);

    expect(res.status).toBe(200);
    expect(requests).toEqual([]);
    expect(await (await api("GET", "/connections", cookie)).json()).toEqual([]);
    expect(await db.select().from(schema.credential)).toEqual([]);
  });

  it("answers 404 for a connection that is not there", async () => {
    const { signUp, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    expect((await api("DELETE", "/connections/missing", cookie)).status).toBe(404);
  });

  it("refuses subscription sign-ins in a team org", async () => {
    const { db, signUp, api } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    await db
      .insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "team", createdAt: new Date() });
    await db
      .insert(schema.member)
      .values({ id: "m", organizationId: "acme", userId, role: "owner", createdAt: new Date() });
    await db.update(schema.session).set({ activeOrganizationId: "acme" });

    expect((await api("GET", "/connections", cookie)).status).toBe(200);
    expect((await api("POST", "/connections/codex/device", cookie)).status).toBe(403);
  });

  it("shows a member who is not an owner the connections, and refuses their changes", async () => {
    const { db, signUp, api } = setup();
    await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const ada = (
      await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.name, "Ada Lovelace"))
        .limit(1)
    )[0];
    await db.insert(schema.member).values({
      id: "m",
      organizationId: ada?.id ?? "",
      userId: grace.userId,
      role: "member",
      createdAt: new Date(),
    });
    await db
      .update(schema.session)
      .set({ activeOrganizationId: ada?.id ?? "" })
      .where(eq(schema.session.userId, grace.userId));

    expect((await api("GET", "/connections", grace.cookie)).status).toBe(200);
    expect((await api("DELETE", "/connections/missing", grace.cookie)).status).toBe(403);
    expect((await api("POST", "/connections/codex/device", grace.cookie)).status).toBe(403);
  });
});

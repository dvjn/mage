import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { UnsecuredJWT } from "jose";
import { describe, expect, it } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createCodexOAuth } from "@/adapters/openai-codex.ts";
import * as schema from "@/adapters/schema.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { createApp } from "@/http/app.ts";
import { createConnections } from "@/services/connections.ts";

const baseUrl = "http://localhost:4783";
const callbackBase = "http://localhost:1455/auth/callback";
const tokenUrl = "https://auth.openai.com/oauth/token";
const userCodeUrl = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const deviceTokenUrl = "https://auth.openai.com/api/accounts/deviceauth/token";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";

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
  // When set, sleeps last until the sign-in is cancelled.
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
    attempts: createSignInAttemptStore(db),
    providers: { codex: { provider: "openai", label: "Codex", browser: codex, device: codex } },
    logger,
    now: () => clock.now,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (waits.hold) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      clock.now = new Date(clock.now.getTime() + ms);
      return Promise.resolve();
    },
  });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    logger,
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

  async function startBrowser(cookie: string) {
    const res = await api("POST", "/connections/codex/browser", cookie);
    expect(res.status).toBe(200);
    const { attemptId, authorizeUrl } = (await res.json()) as {
      attemptId: string;
      authorizeUrl: string;
    };
    return { attemptId, authorizeUrl, params: new URL(authorizeUrl).searchParams };
  }

  // The address the browser lands on after the user approves.
  async function approve(cookie: string, extra: Record<string, string> = {}) {
    const { attemptId } = await startBrowser(cookie);
    const query = new URLSearchParams({ code: `code-${attemptId}`, state: attemptId, ...extra });
    return { attemptId, callbackUrl: `${callbackBase}?${query.toString()}` };
  }

  function finish(cookie: string, body: { attemptId?: string; callbackUrl: string }) {
    return api("POST", "/connections/codex/browser/finish", cookie, body);
  }

  async function connect(cookie: string) {
    const res = await finish(cookie, await approve(cookie));
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function startDevice(cookie: string) {
    const res = await api("POST", "/connections/codex/device", cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { attemptId: string; verificationUrl: string; userCode: string };
  }

  function attempt(cookie: string, id: string) {
    return api("GET", `/connections/codex/attempts/${id}`, cookie);
  }

  // The attempt once the server has stopped waiting on it.
  async function settled(cookie: string, id: string) {
    for (let i = 0; i < 100; i += 1) {
      const body = (await (await attempt(cookie, id)).json()) as {
        status: string;
        connection?: { id: string };
      };
      if (body.status !== "pending") return body;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("sign-in still pending");
  }

  function orgOf(userId: string) {
    return db.select().from(schema.member).where(eq(schema.member.userId, userId)).get()
      ?.organizationId as string;
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
    signUp,
    api,
    startBrowser,
    approve,
    finish,
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

describe("browser sign-in", () => {
  it("returns an authorize URL with the Codex client's parameters", async () => {
    const { db, signUp, startBrowser } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const { attemptId, authorizeUrl, params } = await startBrowser(cookie);

    expect(authorizeUrl).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    expect(authorizeUrl).not.toContain("+");
    const saved = db.select().from(schema.signInAttempt).get();
    expect(Object.fromEntries(params)).toEqual({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callbackBase,
      scope: "openid profile email offline_access",
      code_challenge: createHash("sha256")
        .update(saved?.codeVerifier ?? "")
        .digest("base64url"),
      code_challenge_method: "S256",
      state: attemptId,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "mage",
    });
    expect(saved).toMatchObject({ kind: "codex", state: attemptId });
  });

  it("exchanges the code and stores the connection with its credential sealed", async () => {
    const { db, requests, credentials, signUp, approve, finish } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId, callbackUrl } = await approve(cookie);
    const verifier = db.select().from(schema.signInAttempt).get()?.codeVerifier;

    const res = await finish(cookie, { attemptId, callbackUrl });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/secret|token|acct/);
    const summary = JSON.parse(text) as { id: string };
    expect(summary).toEqual({
      id: expect.any(String),
      provider: "openai",
      authKind: "codex",
      account: "ada@chatgpt.example",
      createdAt: expect.any(String),
    });
    expect(requests).toEqual([
      {
        url: tokenUrl,
        body: {
          client_id: clientId,
          grant_type: "authorization_code",
          code: `code-${attemptId}`,
          code_verifier: verifier,
          redirect_uri: callbackBase,
        },
      },
    ]);
    expect(db.select().from(schema.connection).all()).toEqual([
      expect.objectContaining({ id: summary.id, createdBy: userId }),
    ]);
    expect(db.select().from(schema.credential).get()?.sealed.toString("latin1")).not.toContain(
      "secret-refresh",
    );
    expect(credentials.get(summary.id)).toEqual({
      access: accessToken(1),
      refresh: "secret-refresh-1",
      expires: new Date("2026-10-21T11:00:00Z").getTime(),
      accountId: "acct-123",
      email: "ada@chatgpt.example",
      plan: "plus",
    });
  });

  it("accepts the bare code with the attempt id, the query or code#state", async () => {
    const { signUp, startBrowser, finish, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    for (const pasted of [
      (id: string) => ({ attemptId: id, callbackUrl: " the-code " }),
      (id: string) => ({ callbackUrl: `code=the-code&state=${id}` }),
      (id: string) => ({ callbackUrl: `the-code#${id}` }),
    ]) {
      const { attemptId } = await startBrowser(cookie);
      const res = await finish(cookie, pasted(attemptId));
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      await api("DELETE", `/connections/${id}`, cookie);
    }
  });

  it("rejects a callback from a different sign-in and keeps the attempt", async () => {
    const { requests, signUp, startBrowser, approve, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const first = await startBrowser(cookie);
    const second = await approve(cookie);

    await rejected(
      await finish(cookie, { attemptId: first.attemptId, callbackUrl: second.callbackUrl }),
      400,
      /different sign-in/,
    );
    expect(requests).toEqual([]);
    expect((await finish(cookie, second)).status).toBe(200);
  });

  it("rejects a pasted code without a sign-in to match", async () => {
    const { requests, signUp, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    await rejected(await finish(cookie, { callbackUrl: "the-code" }), 400, /full address/);
    await rejected(
      await finish(cookie, { attemptId: "made-up", callbackUrl: "the-code" }),
      400,
      /unknown/,
    );
    expect(requests).toEqual([]);
  });

  it("rejects a sign-in that was already used", async () => {
    const { requests, signUp, approve, finish, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const approved = await approve(cookie);
    const { id } = (await (await finish(cookie, approved)).json()) as { id: string };
    await api("DELETE", `/connections/${id}`, cookie);

    await rejected(await finish(cookie, approved), 400, /unknown or was already used/);
    expect(requests).toHaveLength(1);
  });

  it("rejects a sign-in another user started", async () => {
    const { signUp, approve, finish } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const approved = await approve(ada.cookie);

    await rejected(await finish(grace.cookie, approved), 400, /unknown/);
    expect((await finish(ada.cookie, approved)).status).toBe(200);
  });

  it("rejects an expired sign-in", async () => {
    const { clock, requests, signUp, approve, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const approved = await approve(cookie);

    clock.now = new Date(clock.now.getTime() + 10 * 60 * 1000);

    await rejected(await finish(cookie, approved), 400, /expired/);
    expect(requests).toEqual([]);
  });

  it("stops when the user declined", async () => {
    const { requests, signUp, approve, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    await rejected(
      await finish(cookie, await approve(cookie, { error: "access_denied", code: "" })),
      400,
      /declined/,
    );
    expect(requests).toEqual([]);
  });

  it("reports an exchange OpenAI refuses or answers without an account", async () => {
    const { db, openai, signUp, approve, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    openai.exchange = { status: 400, body: { error: "invalid_grant" } };
    await rejected(await finish(cookie, await approve(cookie)), 502, /did not accept/);
    openai.exchange = { status: 200, body: { access_token: "only-this" } };
    await rejected(await finish(cookie, await approve(cookie)), 502, /did not accept/);
    openai.exchange = { status: 200 };
    openai.accountId = null;
    await rejected(await finish(cookie, await approve(cookie)), 502, /did not accept/);

    expect(db.select().from(schema.connection).all()).toEqual([]);
    expect(db.select().from(schema.credential).all()).toEqual([]);
  });

  it("drops a cancelled browser sign-in", async () => {
    const { signUp, approve, finish, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const approved = await approve(cookie);

    const res = await api(
      "POST",
      `/connections/codex/attempts/${approved.attemptId}/cancel`,
      cookie,
    );

    expect(res.status).toBe(200);
    await rejected(await finish(cookie, approved), 400, /unknown/);
  });
});

describe("device code sign-in", () => {
  it("polls until approved, slowing down when asked, then exchanges the code", async () => {
    const { requests, openai, sleeps, credentials, signUp, startDevice, settled } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
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
        provider: "openai",
        authKind: "codex",
        account: "ada@chatgpt.example",
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
    expect(credentials.get(result.connection?.id ?? "")).toMatchObject({
      refresh: "secret-refresh-1",
      accountId: "acct-123",
    });
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
    expect(db.select().from(schema.connection).all()).toEqual([]);
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

    await rejected(await api("POST", "/connections/codex/device", cookie), 502, /use the browser/);
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

describe("fresh tokens", () => {
  async function connected() {
    const context = setup();
    const { userId, cookie } = await context.signUp("Ada Lovelace", "ada@example.com");
    const { id } = await context.connect(cookie);
    context.requests.length = 0;
    return { ...context, id, orgId: context.orgOf(userId) };
  }

  it("uses a token that is not about to expire as it is", async () => {
    const { connections, requests, id, orgId } = await connected();

    const token = await connections.withFreshToken(orgId, id, async (t) => t);

    expect(token).toEqual({ access: accessToken(1), accountId: "acct-123" });
    expect(requests).toEqual([]);
  });

  it("renews a token close to expiry and keeps the rotated refresh token", async () => {
    const { connections, credentials, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T10:56:00Z");

    const token = await connections.withFreshToken(orgId, id, async (t) => t);

    expect(token).toEqual({ access: accessToken(2), accountId: "acct-123" });
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

  it("reports a renewal OpenAI refuses and keeps the old credential", async () => {
    const { connections, credentials, openai, clock, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T12:00:00Z");
    openai.refresh = { status: 401 };
    const before = credentials.get(id);

    await expect(connections.withFreshToken(orgId, id, async (t) => t)).rejects.toThrow(
      /could not be renewed/,
    );
    expect(credentials.get(id)).toEqual(before);
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
    expect((await api("POST", "/connections/codex/browser", "")).status).toBe(401);
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
        provider: "openai",
        authKind: "codex",
        account: "ada@chatgpt.example",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("allows one Codex connection per org", async () => {
    const { signUp, connect, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    await connect(cookie);

    await rejected(await api("POST", "/connections/codex/browser", cookie), 409, /already/);
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
    expect(db.select().from(schema.credential).all()).toEqual([]);
  });

  it("answers 404 for a connection that is not there", async () => {
    const { signUp, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    expect((await api("DELETE", "/connections/missing", cookie)).status).toBe(404);
  });

  it("rejects a team org", async () => {
    const { db, signUp, api } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    db.insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "team", createdAt: new Date() })
      .run();
    db.insert(schema.member)
      .values({ id: "m", organizationId: "acme", userId, role: "owner", createdAt: new Date() })
      .run();
    db.update(schema.session).set({ activeOrganizationId: "acme" }).run();

    expect((await api("GET", "/connections", cookie)).status).toBe(403);
    expect((await api("POST", "/connections/codex/device", cookie)).status).toBe(403);
    expect((await api("POST", "/connections/codex/browser", cookie)).status).toBe(403);
  });

  it("rejects a member who is not the owner", async () => {
    const { db, signUp, api } = setup();
    await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const ada = db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.name, "Ada Lovelace"))
      .get();
    db.insert(schema.member)
      .values({
        id: "m",
        organizationId: ada?.id ?? "",
        userId: grace.userId,
        role: "member",
        createdAt: new Date(),
      })
      .run();
    db.update(schema.session)
      .set({ activeOrganizationId: ada?.id ?? "" })
      .where(eq(schema.session.userId, grace.userId))
      .run();

    expect((await api("GET", "/connections", grace.cookie)).status).toBe(403);
    expect((await api("POST", "/connections/codex/device", grace.cookie)).status).toBe(403);
    expect((await api("POST", "/connections/codex/browser", grace.cookie)).status).toBe(403);
  });
});

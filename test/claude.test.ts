import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createClaudeOAuth } from "@/adapters/anthropic-claude.ts";
import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import * as schema from "@/adapters/schema.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { createApp } from "@/http/app.ts";
import type { BrowserOAuth, DeviceOAuth } from "@/ports/oauth.ts";
import { createConnections } from "@/services/connections.ts";

const baseUrl = "http://localhost:4783";
const tokenUrl = "https://platform.claude.com/v1/oauth/token";
const redirectUri = "https://platform.claude.com/oauth/code/callback";
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Never called by these tests.
const unusedCodex = {} as BrowserOAuth & DeviceOAuth;

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
  const anthropic = {
    reply: null as Reply | null,
    // Whether token answers name the account.
    withAccount: true,
    refreshGate: null as Promise<void> | null,
    serial: 0,
  };

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, string>;
    requests.push({ url: request.url, body });
    if (request.url !== tokenUrl) return new Response(null, { status: 404 });
    if (body.grant_type === "refresh_token" && anthropic.refreshGate) await anthropic.refreshGate;
    if (anthropic.reply) return Response.json(anthropic.reply.body, anthropic.reply);
    anthropic.serial += 1;
    return Response.json({
      access_token: `secret-access-${anthropic.serial}`,
      refresh_token: `secret-refresh-${anthropic.serial}`,
      expires_in: 28800,
      ...(anthropic.withAccount && {
        account: { uuid: "acct-uuid", email_address: "ada@claude.example" },
      }),
    });
  };

  const connections = createConnections({
    connections: createConnectionStore(db),
    credentials,
    attempts: createSignInAttemptStore(db),
    providers: {
      codex: { provider: "openai", label: "Codex", browser: unusedCodex, device: unusedCodex },
      claude: {
        provider: "anthropic",
        label: "Claude",
        browser: createClaudeOAuth(fakeFetch as typeof fetch),
      },
    },
    logger,
    now: () => clock.now,
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

  async function start(cookie: string) {
    const res = await api("POST", "/connections/claude/browser", cookie);
    expect(res.status).toBe(200);
    const { attemptId, authorizeUrl } = (await res.json()) as {
      attemptId: string;
      authorizeUrl: string;
    };
    return { attemptId, authorizeUrl, params: new URL(authorizeUrl).searchParams };
  }

  function finish(cookie: string, body: { attemptId?: string; callbackUrl: string }) {
    return api("POST", "/connections/claude/browser/finish", cookie, body);
  }

  // Signs in, pasting the code#state Claude shows.
  async function connect(cookie: string) {
    const { attemptId } = await start(cookie);
    const res = await finish(cookie, { attemptId, callbackUrl: `the-code#${attemptId}` });
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
  it("returns an authorize URL with Claude Code's client parameters", async () => {
    const { db, signUp, start } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const { attemptId, authorizeUrl, params } = await start(cookie);

    expect(authorizeUrl).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    expect(authorizeUrl).not.toContain("+");
    const saved = db.select().from(schema.signInAttempt).get();
    expect(Object.fromEntries(params)).toEqual({
      code: "true",
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope:
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: createHash("sha256")
        .update(saved?.codeVerifier ?? "")
        .digest("base64url"),
      code_challenge_method: "S256",
      state: attemptId,
    });
    expect(saved).toMatchObject({ kind: "claude", state: attemptId });
    expect(attemptId).not.toBe(saved?.codeVerifier);
  });

  it("exchanges the pasted code and stores the connection with its credential sealed", async () => {
    const { db, requests, credentials, signUp, start, finish } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await start(cookie);
    const verifier = db.select().from(schema.signInAttempt).get()?.codeVerifier;

    const res = await finish(cookie, { attemptId, callbackUrl: ` the-code#${attemptId} ` });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/secret|acct/);
    const summary = JSON.parse(text) as { id: string };
    expect(summary).toEqual({
      id: expect.any(String),
      provider: "anthropic",
      authKind: "claude",
      account: "ada@claude.example",
      createdAt: expect.any(String),
    });
    expect(requests).toEqual([
      {
        url: tokenUrl,
        body: {
          client_id: clientId,
          grant_type: "authorization_code",
          code: "the-code",
          state: attemptId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
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
      access: "secret-access-1",
      refresh: "secret-refresh-1",
      expires: new Date("2026-10-21T18:00:00Z").getTime(),
      accountId: "acct-uuid",
      email: "ada@claude.example",
    });
  });

  it("accepts the bare code with the attempt id", async () => {
    const { requests, signUp, start, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await start(cookie);

    expect((await finish(cookie, { attemptId, callbackUrl: "the-code" })).status).toBe(200);
    expect(requests[0]?.body).toMatchObject({ code: "the-code", state: attemptId });
  });

  it("rejects a code from a different sign-in", async () => {
    const { requests, signUp, start, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const first = await start(cookie);
    const second = await start(cookie);

    await rejected(
      await finish(cookie, {
        attemptId: first.attemptId,
        callbackUrl: `the-code#${second.attemptId}`,
      }),
      400,
      /different sign-in/,
    );
    expect(requests).toEqual([]);
  });

  it("does not take a Codex sign-in's state", async () => {
    const { requests, signUp, start, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await start(cookie);

    await rejected(
      await api("POST", "/connections/codex/browser/finish", cookie, {
        callbackUrl: `the-code#${attemptId}`,
      }),
      400,
      /unknown/,
    );
    expect(requests).toEqual([]);
  });

  it("reports an exchange Claude refuses", async () => {
    const { db, anthropic, signUp, start, finish } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const { attemptId } = await start(cookie);
    anthropic.reply = { status: 400, body: { error: "invalid_grant" } };

    await rejected(
      await finish(cookie, { attemptId, callbackUrl: `the-code#${attemptId}` }),
      502,
      /Claude did not accept/,
    );
    expect(db.select().from(schema.connection).all()).toEqual([]);
  });

  it("allows one Claude connection per org, next to Codex", async () => {
    const { db, signUp, connect, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    await connect(cookie);
    db.insert(schema.connection)
      .values({
        id: "codex",
        organizationId: db.select().from(schema.connection).get()?.organizationId ?? "",
        provider: "openai",
        authKind: "codex",
        account: "ada@chatgpt.example",
      })
      .run();

    await rejected(await api("POST", "/connections/claude/browser", cookie), 409, /already/);
    expect(await (await api("GET", "/connections", cookie)).json()).toHaveLength(2);
  });

  it("has no device code sign-in", async () => {
    const { signUp, api } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    expect((await api("POST", "/connections/claude/device", cookie)).status).toBe(404);
  });

  it("is for the owner of a personal org", async () => {
    const { db, signUp, api } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    db.insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "team", createdAt: new Date() })
      .run();
    db.insert(schema.member)
      .values({ id: "m", organizationId: "acme", userId, role: "owner", createdAt: new Date() })
      .run();
    db.update(schema.session).set({ activeOrganizationId: "acme" }).run();

    expect((await api("POST", "/connections/claude/browser", cookie)).status).toBe(403);
    expect((await api("POST", "/connections/claude/browser", "")).status).toBe(401);
  });
});

describe("fresh Claude tokens", () => {
  async function connected() {
    const context = setup();
    const { userId, cookie } = await context.signUp("Ada Lovelace", "ada@example.com");
    const { id } = await context.connect(cookie);
    context.requests.length = 0;
    return { ...context, id, orgId: context.orgOf(userId) };
  }

  it("uses a token that is not about to expire as it is", async () => {
    const { connections, requests, id, orgId } = await connected();

    expect(await connections.withFreshToken(orgId, id, async (t) => t)).toEqual({
      access: "secret-access-1",
      accountId: "acct-uuid",
    });
    expect(requests).toEqual([]);
  });

  it("renews an expired token, keeps the rotated refresh token and the account", async () => {
    const { connections, credentials, anthropic, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T18:00:00Z");
    anthropic.withAccount = false;

    const token = await connections.withFreshToken(orgId, id, async (t) => t.access);

    expect(token).toBe("secret-access-2");
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
    expect(credentials.get(id)).toEqual({
      access: "secret-access-2",
      refresh: "secret-refresh-2",
      expires: new Date("2026-10-22T02:00:00Z").getTime(),
      accountId: "acct-uuid",
      email: "ada@claude.example",
    });
  });

  it("renews once for callers that arrive together", async () => {
    const { connections, anthropic, clock, requests, id, orgId } = await connected();
    clock.now = new Date("2026-10-21T18:00:00Z");
    let release = () => {};
    anthropic.refreshGate = new Promise((resolve) => {
      release = resolve;
    });

    const both = Promise.all([
      connections.withFreshToken(orgId, id, async (t) => t.access),
      connections.withFreshToken(orgId, id, async (t) => t.access),
    ]);
    release();

    expect(await both).toEqual(["secret-access-2", "secret-access-2"]);
    expect(requests).toHaveLength(1);
  });
});

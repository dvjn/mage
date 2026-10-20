import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createClaudeCatalog } from "@/adapters/anthropic-claude.ts";
import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createCodexCatalog } from "@/adapters/openai-codex.ts";
import { createOrgSettingStore } from "@/adapters/org-settings.ts";
import * as schema from "@/adapters/schema.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { createApp } from "@/http/app.ts";
import type { BrowserOAuth } from "@/ports/oauth.ts";
import { createConnections } from "@/services/connections.ts";
import { createModels } from "@/services/models.ts";

const baseUrl = "http://localhost:4783";
const codexUrl = "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0";
const claudeUrl = "https://api.anthropic.com/v1/models";

const codexModels = {
  models: [
    {
      slug: "gpt-mini",
      display_name: "GPT Mini",
      visibility: "list",
      priority: 5,
      context_window: 128000,
      supported_reasoning_levels: [],
    },
    {
      slug: "gpt-big",
      display_name: "GPT Big",
      visibility: "list",
      priority: 1,
      context_window: 272000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      shell_type: "shell_command",
    },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
  ],
};

const claudeModels = {
  data: [
    {
      type: "model",
      id: "claude-big",
      display_name: "Claude Big",
      created_at: "2026-09-01T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: { thinking: { supported: true }, batch: { supported: true } },
    },
    {
      type: "model",
      id: "claude-old",
      display_name: "Claude Old",
      created_at: "2025-01-01T00:00:00Z",
      max_input_tokens: null,
      capabilities: null,
    },
  ],
  has_more: false,
  first_id: "claude-big",
  last_id: "claude-old",
};

type Reply = { status: number; body?: unknown };

function setup() {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const connectionStore = createConnectionStore(db);
  const credentials = createCredentialStore(
    db,
    createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
  );
  const clock = { now: new Date("2026-10-21T10:00:00Z") };
  const requests: { url: string; headers: Headers }[] = [];
  // Replaces the provider's answer when set.
  const replies: { codex: Reply | null; claude: Reply | null } = { codex: null, claude: null };
  const refreshes: string[] = [];

  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    const provider = request.url.startsWith(claudeUrl) ? "claude" : "codex";
    const reply = replies[provider];
    if (reply) return Promise.resolve(Response.json(reply.body ?? {}, reply));
    if (request.url === codexUrl) return Promise.resolve(Response.json(codexModels));
    if (request.url === `${claudeUrl}?limit=1000`) {
      return Promise.resolve(Response.json(claudeModels));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  function refresher(prefix: string): BrowserOAuth {
    return {
      authorize: () => {
        throw new Error("not used");
      },
      exchange: () => Promise.reject(new Error("not used")),
      refresh: (refreshToken) => {
        refreshes.push(refreshToken);
        return Promise.resolve({
          access: `${prefix}-renewed`,
          refresh: `${prefix}-refresh-2`,
          expiresIn: 3600,
          accountId: null,
          email: null,
          plan: null,
        });
      },
    };
  }

  const connections = createConnections({
    connections: connectionStore,
    credentials,
    attempts: createSignInAttemptStore(db),
    providers: {
      codex: { provider: "openai", label: "Codex", browser: refresher("codex") },
      claude: { provider: "anthropic", label: "Claude", browser: refresher("claude") },
    },
    logger,
    now: () => clock.now,
  });
  const models = createModels({
    connections: connectionStore,
    tokens: connections,
    catalogs: {
      codex: createCodexCatalog(fakeFetch as typeof fetch),
      claude: createClaudeCatalog(fakeFetch as typeof fetch),
    },
    settings: createOrgSettingStore(db),
    logger,
    now: () => clock.now,
  });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    models,
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
    const member = db.select().from(schema.member).where(eq(schema.member.userId, user.id)).get();
    return { userId: user.id, orgId: member?.organizationId as string, cookie };
  }

  function api(method: string, path: string, cookie: string, body?: object) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body && JSON.stringify(body),
    });
  }

  // Stores a connection with a token that lasts an hour from the clock.
  function connect(owner: { orgId: string; userId: string }, kind: "codex" | "claude") {
    const connection = connectionStore.create({
      orgId: owner.orgId,
      createdBy: owner.userId,
      provider: kind === "codex" ? "openai" : "anthropic",
      authKind: kind,
      account: `${kind}@example.com`,
    });
    credentials.put(connection.id, {
      access: `${kind}-access`,
      refresh: `${kind}-refresh`,
      expires: clock.now.getTime() + 60 * 60 * 1000,
      ...(kind === "codex" && { accountId: "acct-123" }),
    });
    return connection.id;
  }

  // Sign-up with both providers connected.
  async function ready() {
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const codexId = connect(owner, "codex");
    const claudeId = connect(owner, "claude");
    return { ...owner, codexId, claudeId };
  }

  return { db, clock, requests, replies, refreshes, models, signUp, api, connect, ready };
}

describe("model lists", () => {
  it("reads the Codex backend's list with the account's token, in picker order", async () => {
    const { models, requests, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const id = connect(owner, "codex");

    const { models: list, errors } = await models.resolveModels(owner.orgId);

    expect(errors).toEqual([]);
    expect(list).toEqual([
      {
        ref: "codex/gpt-big",
        id: "gpt-big",
        name: "GPT Big",
        connectionId: id,
        authKind: "codex",
        contextWindow: 272000,
        reasoning: true,
      },
      {
        ref: "codex/gpt-mini",
        id: "gpt-mini",
        name: "GPT Mini",
        connectionId: id,
        authKind: "codex",
        contextWindow: 128000,
        reasoning: false,
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(codexUrl);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer codex-access");
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct-123");
  });

  it("reads Anthropic's list with the OAuth token and Claude Code's headers", async () => {
    const { models, requests, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const id = connect(owner, "claude");

    const { models: list } = await models.resolveModels(owner.orgId);

    expect(list).toEqual([
      {
        ref: "claude/claude-big",
        id: "claude-big",
        name: "Claude Big",
        connectionId: id,
        authKind: "claude",
        contextWindow: 1000000,
        reasoning: true,
      },
      {
        ref: "claude/claude-old",
        id: "claude-old",
        name: "Claude Old",
        connectionId: id,
        authKind: "claude",
      },
    ]);
    const headers = requests[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer claude-access");
    expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(headers?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers?.get("user-agent")).toBe("mage");
    expect(headers?.has("x-app")).toBe(false);
    expect(headers?.has("x-api-key")).toBe(false);
  });

  it("follows Anthropic's pages", async () => {
    const { models, replies, requests, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    connect(owner, "claude");
    let page = 0;
    replies.claude = {
      status: 200,
      get body() {
        page += 1;
        const [first, second] = claudeModels.data;
        return page === 1
          ? { data: [first], has_more: true, last_id: "claude-big" }
          : { data: [second], has_more: false, last_id: "claude-old" };
      },
    };

    const { models: list } = await models.resolveModels(owner.orgId);

    expect(list.map((model) => model.id)).toEqual(["claude-big", "claude-old"]);
    expect(requests.map((request) => request.url)).toEqual([
      `${claudeUrl}?limit=1000`,
      `${claudeUrl}?limit=1000&after_id=claude-big`,
    ]);
  });

  it("merges every connection's list under its own prefix", async () => {
    const { models, ready } = setup();
    const { orgId } = await ready();

    const { models: list } = await models.resolveModels(orgId);

    expect(list.map((model) => model.ref).toSorted()).toEqual([
      "claude/claude-big",
      "claude/claude-old",
      "codex/gpt-big",
      "codex/gpt-mini",
    ]);
  });

  it("keeps a list for an hour and reads it again on refresh or after the hour", async () => {
    const { models, requests, clock, ready } = setup();
    const { orgId } = await ready();

    await models.resolveModels(orgId);
    await models.resolveModels(orgId);
    expect(requests).toHaveLength(2);

    await models.resolveModels(orgId, { refresh: true });
    expect(requests).toHaveLength(4);

    clock.now = new Date("2026-10-21T10:59:00Z");
    await models.resolveModels(orgId);
    expect(requests).toHaveLength(4);

    clock.now = new Date("2026-10-21T11:01:00Z");
    await models.resolveModels(orgId);
    expect(requests).toHaveLength(6);
  });

  it("reports a connection whose list fails and still lists the others", async () => {
    const { models, replies, ready } = setup();
    const { orgId, claudeId } = await ready();
    replies.claude = { status: 500 };

    const { models: list, errors } = await models.resolveModels(orgId);

    expect(list.map((model) => model.authKind)).toEqual(["codex", "codex"]);
    expect(errors).toEqual([{ connectionId: claudeId, message: expect.stringMatching(/Claude/) }]);
  });

  it("reports an answer that is not a list rather than an empty list", async () => {
    const { models, replies, ready } = setup();
    const { orgId, codexId } = await ready();
    replies.codex = { status: 200, body: { detail: "nope" } };

    const { errors } = await models.resolveModels(orgId);

    expect(errors).toEqual([{ connectionId: codexId, message: expect.stringMatching(/Codex/) }]);
  });

  it("does not keep a failed list", async () => {
    const { models, replies, ready } = setup();
    const { orgId } = await ready();
    replies.codex = { status: 500 };
    await models.resolveModels(orgId);

    replies.codex = null;
    const { models: list, errors } = await models.resolveModels(orgId);

    expect(errors).toEqual([]);
    expect(list).toHaveLength(4);
  });

  it("renews an expired token before reading the list", async () => {
    const { models, requests, refreshes, clock, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    connect(owner, "codex");
    clock.now = new Date("2026-10-21T12:00:00Z");

    await models.resolveModels(owner.orgId);

    expect(refreshes).toEqual(["codex-refresh"]);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer codex-renewed");
  });

  it("lists only the org's own connections", async () => {
    const { models, ready, signUp } = setup();
    await ready();
    const other = await signUp("Grace Hopper", "grace@example.com");

    expect(await models.resolveModels(other.orgId)).toEqual({ models: [], errors: [] });
  });
});

describe("/api/v1/models and the default model", () => {
  it("is unauthorized when signed out", async () => {
    const { api } = setup();

    expect((await api("GET", "/models", "")).status).toBe(401);
    expect((await api("GET", "/settings/default-model", "")).status).toBe(401);
  });

  it("lists models and bypasses the cache with ?refresh=1", async () => {
    const { api, requests, ready } = setup();
    const { cookie } = await ready();

    const res = await api("GET", "/models", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { ref: string }[]; errors: unknown[] };
    expect(body.models.map((model) => model.ref)).toContain("claude/claude-big");
    expect(body.errors).toEqual([]);

    await api("GET", "/models", cookie);
    expect(requests).toHaveLength(2);
    await api("GET", "/models?refresh=1", cookie);
    expect(requests).toHaveLength(4);
  });

  it("has no default until one is picked, then keeps it", async () => {
    const { api, ready } = setup();
    const { cookie } = await ready();

    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: null,
    });
    const res = await api("PUT", "/settings/default-model", cookie, { ref: "claude/claude-big" });
    expect(res.status).toBe(200);
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: "claude/claude-big",
    });

    await api("PUT", "/settings/default-model", cookie, { ref: "codex/gpt-mini" });
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: "codex/gpt-mini",
    });
  });

  it("refuses a default the org cannot use", async () => {
    const { api, ready, signUp, connect } = setup();
    const { cookie } = await ready();
    const other = await signUp("Grace Hopper", "grace@example.com");
    connect(other, "codex");

    for (const ref of ["codex/gpt-hidden", "claude/unknown", "gpt-big", ""]) {
      const res = await api("PUT", "/settings/default-model", cookie, { ref });
      expect(res.status).toBe(400);
    }
    const res = await api("PUT", "/settings/default-model", other.cookie, {
      ref: "claude/claude-big",
    });
    expect(res.status).toBe(400);
  });

  it("lets members read the default but not set it", async () => {
    const { db, api, ready } = setup();
    const { cookie, userId } = await ready();
    await api("PUT", "/settings/default-model", cookie, { ref: "codex/gpt-big" });
    db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, userId)).run();

    expect((await api("GET", "/models", cookie)).status).toBe(200);
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: "codex/gpt-big",
    });
    const res = await api("PUT", "/settings/default-model", cookie, { ref: "codex/gpt-mini" });
    expect(res.status).toBe(403);
  });
});

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import { createApp } from "@/server/app.ts";
import { openDatabase } from "@/server/db/db.ts";
import type { Guests } from "@/server/guests/service.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import { createAnthropicKeyCatalog } from "@/server/models/hosts/anthropic-api.ts";
import { createOpenAIKeyCatalog } from "@/server/models/hosts/openai-api.ts";
import { createCodexCatalog } from "@/server/models/hosts/openai-codex.ts";
import { createAuth, createIdentity } from "@/server/orgs/auth.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import { createOrgSettingStore } from "@/server/orgs/setting-store.ts";
import * as schema from "@/server/schema.ts";
import type { Skills } from "@/server/skills/service.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import { createSpaceStore } from "@/server/spaces/store.ts";
import type { Threads } from "@/server/threads/service.ts";
import { HOST_IDS, type HostId } from "@/shared/hosts.ts";
import { replyCandidates } from "@/shared/models.ts";
import { FIRST_SPACE_NAME } from "@/shared/spaces.ts";

import { createConnectionStore } from "./connection-store.ts";
import { createCredentialStore } from "./credential-store.ts";
import { createModelChoiceStore } from "./choice-store.ts";
import { createHostAdapters } from "./hosts.ts";
import { ModelError, type ModelGateway, type ModelRequest, type ModelToken } from "./gateway.ts";
import type { DeviceOAuth } from "./oauth.ts";
import { createConnections } from "./connections.ts";
import { createModels, pickReplyModel } from "./service.ts";

// Never called by these tests.
const unusedSpaces = {} as Spaces;
const unusedThreads = {} as Threads;
const unusedGuests = {} as Guests;

const baseUrl = "http://localhost:4783";
const codexUrl = "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0";
const anthropicUrl = "https://api.anthropic.com/v1/models";

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

const anthropicModels = {
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
  // Sign-up starts the person's org with its first space, as the app wires it.
  const hooks = createHooks();
  hooks.on("person.signedUp", ({ orgId, userId }) => {
    createSpaceStore(db).create({
      orgId,
      kind: "personal",
      name: FIRST_SPACE_NAME,
      primary: true,
      createdBy: userId,
    });
  });
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [], hooks });
  const connectionStore = createConnectionStore(db);
  const credentials = createCredentialStore(
    db,
    createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
  );
  const clock = { now: new Date("2026-10-21T10:00:00Z") };
  const requests: { url: string; headers: Headers }[] = [];
  // Replaces the provider's answer when set.
  const replies: { codex: Reply | null; anthropic: Reply | null } = {
    codex: null,
    anthropic: null,
  };
  const refreshes: string[] = [];
  // What each gateway was asked to stream.
  const streamed: { kind: string; token: ModelToken; request: ModelRequest }[] = [];
  // Access tokens the gateways refuse as a provider refuses a revoked one.
  const refused = new Set<string>();
  function recordingGateway(kind: string): ModelGateway {
    return {
      async *stream(token, request) {
        streamed.push({ kind, token, request });
        if (refused.has(token.access)) throw new ModelError("auth", "401 token revoked");
        yield* [{ type: "step-start" as const }, { type: "delta" as const, text: "Hi" }];
      },
    };
  }

  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    // Anthropic refuses this key.
    if (request.headers.get("x-api-key") === "sk-ant-wrong") {
      return Promise.resolve(
        Response.json({ error: { type: "authentication_error" } }, { status: 401 }),
      );
    }
    // A server people run, which needs no key, at either of two addresses.
    if (["http://llm.local/v1/models", "http://llm2.local/v1/models"].includes(request.url)) {
      return Promise.resolve(
        Response.json({ data: [{ id: "llama-4-scout" }, { id: "nomic-embed-text" }] }),
      );
    }
    const provider = request.url.startsWith(anthropicUrl) ? "anthropic" : "codex";
    const reply = replies[provider];
    if (reply) return Promise.resolve(Response.json(reply.body ?? {}, reply));
    // At the provider's API or a proxy's.
    if (request.url.endsWith("/models?client_version=0.163.0")) {
      return Promise.resolve(Response.json(codexModels));
    }
    if (request.url.endsWith("/models?limit=1000")) {
      return Promise.resolve(Response.json(anthropicModels));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  function refresher(prefix: string): DeviceOAuth {
    return {
      startDevice: () => Promise.reject(new Error("not used")),
      pollDevice: () => Promise.reject(new Error("not used")),
      exchangeDevice: () => Promise.reject(new Error("not used")),
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
    providers: {
      codex: { label: "Codex", oauth: refresher("codex") },
    },
    logger,
    now: () => clock.now,
  });
  const models = createModels({
    connections: connectionStore,
    choices: createModelChoiceStore(db),
    spaces: createSpaceStore(db),
    tokens: connections,
    catalogs: {
      ...createHostAdapters(fakeFetch as typeof fetch).catalogs,
      codex: createCodexCatalog(fakeFetch as typeof fetch),
      openai: createOpenAIKeyCatalog(fakeFetch as typeof fetch),
      anthropic: createAnthropicKeyCatalog(fakeFetch as typeof fetch),
    },
    settings: createOrgSettingStore(db),
    gateways: Object.fromEntries(HOST_IDS.map((host) => [host, recordingGateway(host)])) as Record<
      HostId,
      ModelGateway
    >,
    logger,
    now: () => clock.now,
  });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    models,
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

  // Stores the Codex sign-in with a token that lasts an hour from the clock, or an Anthropic API
  // key.
  function connect(owner: { orgId: string; userId: string }, kind: "codex" | "anthropic") {
    if (kind === "anthropic") {
      return connections.add(owner, {
        host: "anthropic",
        authKind: "api_key",
        label: null,
        settings: { method: "api_key" },
        secrets: { apiKey: "anthropic-key" },
      }).id;
    }
    const connection = connectionStore.create({
      orgId: owner.orgId,
      createdBy: owner.userId,
      host: "codex",
      authKind: "oauth",
      account: "codex@example.com",
    });
    credentials.put(connection.id, {
      access: "codex-access",
      refresh: "codex-refresh",
      expires: clock.now.getTime() + 60 * 60 * 1000,
      accountId: "acct-123",
    });
    return connection.id;
  }

  // Sign-up with both providers connected.
  async function ready() {
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const codexId = connect(owner, "codex");
    const anthropicId = connect(owner, "anthropic");
    return { ...owner, codexId, anthropicId };
  }

  return {
    db,
    clock,
    connections,
    requests,
    replies,
    refreshes,
    streamed,
    refused,
    models,
    signUp,
    api,
    connect,
    ready,
  };
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
        host: "codex",
        maker: "openai",
        authKind: "oauth",
        connectionLabel: "ChatGPT",
        contextWindow: 272000,
        reasoning: true,
      },
      {
        ref: "codex/gpt-mini",
        id: "gpt-mini",
        name: "GPT Mini",
        connectionId: id,
        host: "codex",
        maker: "openai",
        authKind: "oauth",
        connectionLabel: "ChatGPT",
        contextWindow: 128000,
        reasoning: false,
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(codexUrl);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer codex-access");
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct-123");
  });

  it("reads Anthropic's list with the key", async () => {
    const { models, requests, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const id = connect(owner, "anthropic");

    const { models: list } = await models.resolveModels(owner.orgId);

    expect(list).toEqual([
      {
        ref: `${id}/claude-big`,
        id: "claude-big",
        name: "Claude Big",
        connectionId: id,
        host: "anthropic",
        maker: "anthropic",
        authKind: "api_key",
        connectionLabel: "Anthropic API key",
        contextWindow: 1000000,
        reasoning: true,
      },
      {
        ref: `${id}/claude-old`,
        id: "claude-old",
        name: "Claude Old",
        connectionId: id,
        host: "anthropic",
        maker: "anthropic",
        authKind: "api_key",
        connectionLabel: "Anthropic API key",
      },
    ]);
    const headers = requests[0]?.headers;
    expect(headers?.get("x-api-key")).toBe("anthropic-key");
    expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(headers?.has("authorization")).toBe(false);
  });

  it("follows Anthropic's pages", async () => {
    const { models, replies, requests, signUp, connect } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    connect(owner, "anthropic");
    let page = 0;
    replies.anthropic = {
      status: 200,
      get body() {
        page += 1;
        const [first, second] = anthropicModels.data;
        return page === 1
          ? { data: [first], has_more: true, last_id: "claude-big" }
          : { data: [second], has_more: false, last_id: "claude-old" };
      },
    };

    const { models: list } = await models.resolveModels(owner.orgId);

    expect(list.map((model) => model.id)).toEqual(["claude-big", "claude-old"]);
    expect(requests.map((request) => request.url)).toEqual([
      `${anthropicUrl}?limit=1000`,
      `${anthropicUrl}?limit=1000&after_id=claude-big`,
    ]);
  });

  it("merges every connection's list under its own prefix", async () => {
    const { models, ready } = setup();
    const { orgId, anthropicId } = await ready();

    const { models: list } = await models.resolveModels(orgId);

    expect(list.map((model) => model.ref).toSorted()).toEqual(
      [
        `${anthropicId}/claude-big`,
        `${anthropicId}/claude-old`,
        "codex/gpt-big",
        "codex/gpt-mini",
      ].toSorted(),
    );
  });

  it("shows a model by its maker, its connection's host and its listed name, without asking again", async () => {
    const { models, requests, ready } = setup();
    const { orgId, anthropicId } = await ready();
    const before = models.shownModels(orgId);
    expect(before(`${anthropicId}/claude-big`)).toEqual({
      ref: `${anthropicId}/claude-big`,
      name: "claude-big",
      maker: "anthropic",
      host: "anthropic",
      connection: "Anthropic API key",
    });

    await models.resolveModels(orgId);
    const shown = models.shownModels(orgId);
    expect(shown("codex/gpt-big")).toMatchObject({
      name: "GPT Big",
      maker: "openai",
      host: "codex",
      connection: "ChatGPT",
    });
    expect(shown(`${anthropicId}/claude-big`)).toMatchObject({
      name: "Claude Big",
      maker: "anthropic",
      host: "anthropic",
    });
    expect(shown("gone/echo")).toEqual({
      ref: "gone/echo",
      name: "echo",
      maker: null,
      host: null,
      connection: null,
    });
    // A sign-in's ref still says whose models it had.
    expect(shown("codex/gpt-gone")).toMatchObject({ maker: "openai", host: "codex" });
    expect(requests).toHaveLength(2);
  });

  it("keeps each org's lists while other orgs read theirs", async () => {
    const { models, requests, ready, signUp, connect } = setup();
    const { orgId, anthropicId } = await ready();
    await models.resolveModels(orgId);
    const grace = await signUp("Grace Hopper", "grace@example.com");
    connect(grace, "anthropic");
    await models.resolveModels(grace.orgId);

    expect(models.shownModels(orgId)(`${anthropicId}/claude-big`).name).toBe("Claude Big");
    await models.resolveModels(orgId);
    expect(requests).toHaveLength(3);
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
    const { orgId, anthropicId } = await ready();
    replies.anthropic = { status: 500 };

    const { models: list, errors } = await models.resolveModels(orgId);

    expect(list.map((model) => model.authKind)).toEqual(["oauth", "oauth"]);
    expect(errors).toEqual([
      { connectionId: anthropicId, message: expect.stringMatching(/Anthropic/) },
    ]);
  });

  it("reports an answer that is not a list rather than an empty list", async () => {
    const { models, replies, ready } = setup();
    const { orgId, codexId } = await ready();
    replies.codex = { status: 200, body: { detail: "nope" } };

    const { errors } = await models.resolveModels(orgId);

    expect(errors).toEqual([{ connectionId: codexId, message: expect.stringMatching(/ChatGPT/) }]);
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

    expect(await models.resolveModels(other.orgId)).toEqual({
      models: [],
      errors: [],
      turnedOff: [],
    });
  });
});

describe("/api/v1/models and the default model", () => {
  it("is unauthorized when signed out", async () => {
    const { api } = setup();

    expect((await api("GET", "/models", "")).status).toBe(401);
    expect((await api("GET", "/settings/default-model", "")).status).toBe(401);
  });

  it("says why a connection's own list could not be read", async () => {
    const { api, replies, ready } = setup();
    const { cookie, codexId } = await ready();
    replies.codex = { status: 401 };

    const res = await api("GET", `/connections/${codexId}/models`, cookie);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the ChatGPT models. Try again." });
  });

  it("lists models and bypasses the cache with ?refresh=1", async () => {
    const { api, requests, ready } = setup();
    const { cookie, anthropicId } = await ready();

    const res = await api("GET", "/models", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { ref: string }[]; errors: unknown[] };
    expect(body.models.map((model) => model.ref)).toContain(`${anthropicId}/claude-big`);
    expect(body.errors).toEqual([]);

    await api("GET", "/models", cookie);
    expect(requests).toHaveLength(2);
    await api("GET", "/models?refresh=1", cookie);
    expect(requests).toHaveLength(4);
  });

  it("has no default until one is picked, then keeps it", async () => {
    const { api, ready } = setup();
    const { cookie, anthropicId } = await ready();

    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: null,
    });
    const ref = `${anthropicId}/claude-big`;
    const res = await api("PUT", "/settings/default-model", cookie, { ref });
    expect(res.status).toBe(200);
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({ ref });

    await api("PUT", "/settings/default-model", cookie, { ref: "codex/gpt-mini" });
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toEqual({
      ref: "codex/gpt-mini",
    });
  });

  it("refuses a default the org cannot use", async () => {
    const { api, ready, signUp, connect } = setup();
    const { cookie, anthropicId } = await ready();
    const other = await signUp("Grace Hopper", "grace@example.com");
    connect(other, "codex");

    for (const ref of ["codex/gpt-hidden", `${anthropicId}/unknown`, "gpt-big", ""]) {
      const res = await api("PUT", "/settings/default-model", cookie, { ref });
      expect(res.status).toBe(400);
    }
    const res = await api("PUT", "/settings/default-model", other.cookie, {
      ref: `${anthropicId}/claude-big`,
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

describe("the title model", () => {
  const withHaiku = {
    status: 200,
    body: {
      ...anthropicModels,
      data: [...anthropicModels.data, { id: "claude-haiku-5-5", display_name: "Claude Haiku" }],
    },
  };

  it("is chosen automatically from the first connection whose list has its title model", async () => {
    const { api, replies, ready } = setup();
    const { cookie, anthropicId } = await ready();

    expect(await (await api("GET", "/settings/title-model", cookie)).json()).toEqual({
      ref: null,
      automatic: null,
    });
    replies.anthropic = withHaiku;
    expect(await (await api("GET", "/models?refresh=1", cookie)).json()).toMatchObject({
      errors: [],
    });
    expect(await (await api("GET", "/settings/title-model", cookie)).json()).toEqual({
      ref: null,
      automatic: `${anthropicId}/claude-haiku-5-5`,
    });
  });

  it("is the org's choice once an admin picks one, and automatic again after", async () => {
    const { db, api, ready } = setup();
    const { cookie, userId } = await ready();

    const res = await api("PUT", "/settings/title-model", cookie, { ref: "codex/gpt-mini" });
    expect(await res.json()).toEqual({ ref: "codex/gpt-mini", automatic: null });
    expect((await api("PUT", "/settings/title-model", cookie, { ref: "codex/x" })).status).toBe(
      400,
    );
    expect(await (await api("PUT", "/settings/title-model", cookie, { ref: null })).json()).toEqual(
      { ref: null, automatic: null },
    );

    db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, userId)).run();
    expect((await api("GET", "/settings/title-model", cookie)).status).toBe(200);
    expect(
      (await api("PUT", "/settings/title-model", cookie, { ref: "codex/gpt-mini" })).status,
    ).toBe(403);
  });
});

describe("opening a model", () => {
  const request = {
    instructions: "Be brief.",
    messages: [{ role: "user" as const, text: "[Ada Lovelace] Hi" }],
    maxSteps: 1,
    sessionId: "thread-1",
  };

  async function collect(stream: AsyncIterable<unknown>) {
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it("streams through the org's connection of the ref's kind with a renewed token", async () => {
    const { models, clock, streamed, refreshes, ready } = setup();
    const owner = await ready();
    clock.now = new Date(clock.now.getTime() + 2 * 60 * 60 * 1000);

    const model = await models.open(owner.orgId, "codex/gpt-big");
    const events = await collect(model.stream(request, new AbortController().signal));

    expect(events).toEqual([{ type: "step-start" }, { type: "delta", text: "Hi" }]);
    expect(refreshes).toEqual(["codex-refresh"]);
    expect(streamed).toEqual([
      {
        kind: "codex",
        token: { access: "codex-renewed", accountId: "acct-123", proxy: null },
        request: { ...request, model: "gpt-big", effort: "medium" },
      },
    ]);
  });

  it("streams Anthropic models through the org's key", async () => {
    const { models, streamed, ready } = setup();
    const owner = await ready();

    const model = await models.open(owner.orgId, `${owner.anthropicId}/claude-big`);
    const events = await collect(model.stream(request, new AbortController().signal));

    expect(events).toEqual([{ type: "step-start" }, { type: "delta", text: "Hi" }]);
    expect(streamed).toMatchObject([
      {
        kind: "anthropic",
        token: { access: "anthropic-key", proxy: null },
        request: { ...request, model: "claude-big", effort: "medium" },
      },
    ]);
  });

  it("asks a model that can think for the effort, and one that cannot for none", async () => {
    const { models, streamed, ready } = setup();
    const owner = await ready();

    for (const ref of ["codex/gpt-big", "codex/gpt-mini", `${owner.anthropicId}/claude-old`]) {
      const model = await models.open(owner.orgId, ref);
      await collect(model.stream({ ...request, effort: "high" }, new AbortController().signal));
    }

    expect(streamed.map((call) => [call.request.model, call.request.effort])).toEqual([
      ["gpt-big", "high"],
      ["gpt-mini", undefined],
      ["claude-old", undefined],
    ]);
  });

  it("renews a token the provider refuses once, and asks again", async () => {
    const { models, streamed, refreshes, refused, ready } = setup();
    const owner = await ready();
    refused.add("codex-access");

    const model = await models.open(owner.orgId, "codex/gpt-big");
    const events = await collect(model.stream(request, new AbortController().signal));

    expect(events).toEqual([{ type: "step-start" }, { type: "delta", text: "Hi" }]);
    expect(refreshes).toEqual(["codex-refresh"]);
    expect(streamed.map((call) => call.token.access)).toEqual(["codex-access", "codex-renewed"]);
  });

  it("fails as a sign-in failure when the renewed token is refused too", async () => {
    const { models, streamed, refused, ready } = setup();
    const owner = await ready();
    refused.add("codex-access");
    refused.add("codex-renewed");

    const model = await models.open(owner.orgId, "codex/gpt-big");
    await expect(collect(model.stream(request, new AbortController().signal))).rejects.toThrow(
      expect.objectContaining({ kind: "auth" }),
    );
    expect(streamed).toHaveLength(2);
  });

  it("says what is missing when the ref cannot be opened", async () => {
    const { models, signUp } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");

    await expect(models.open(owner.orgId, "codex/gpt-big")).rejects.toThrow(
      expect.objectContaining({
        kind: "auth",
        message: "codex/gpt-big needs a ChatGPT connection. Add one in Model providers.",
      }),
    );
    await expect(models.open(owner.orgId, "gpt-big")).rejects.toThrow("not a model ref");
  });
});

describe("proxies", () => {
  const proxyUrl = "https://proxy.example.com/anthropic/v1";

  function setProxy(
    api: ReturnType<typeof setup>["api"],
    cookie: string,
    id: string,
    body: { baseUrl: string | null; headers: Record<string, string | null> },
  ) {
    return api("PATCH", `/connections/${id}/proxy`, cookie, body);
  }

  it("send a connection's lists and replies to the proxy, with its headers over ours", async () => {
    const { api, models, requests, streamed, ready } = setup();
    const { cookie, orgId, anthropicId } = await ready();

    const res = await setProxy(api, cookie, anthropicId, {
      baseUrl: `${proxyUrl}/`,
      headers: { "X-Team": "blue", "User-Agent": "corp" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: anthropicId,
      proxy: { baseUrl: proxyUrl, headerNames: ["x-team", "user-agent"] },
    });

    await models.resolveModels(orgId);
    const listed = requests.find((request) => request.url.startsWith(proxyUrl));
    expect(listed?.url).toBe(`${proxyUrl}/models?limit=1000`);
    expect(Object.fromEntries(listed!.headers)).toMatchObject({
      "x-api-key": "anthropic-key",
      "x-team": "blue",
      "user-agent": "corp",
    });
    expect(requests.some((request) => request.url.startsWith(anthropicUrl))).toBe(false);

    const model = await models.open(orgId, `${anthropicId}/claude-big`);
    for await (const _ of model.stream(
      { instructions: "", messages: [], maxSteps: 1, sessionId: "t" },
      new AbortController().signal,
    ));
    expect(streamed.at(-1)?.token.proxy).toEqual({
      baseUrl: proxyUrl,
      headers: { "x-team": "blue", "user-agent": "corp" },
    });
  });

  it("refuse headers Mage sets, other addresses than http(s), and headers without values", async () => {
    const { api, ready } = setup();
    const { cookie, codexId } = await ready();

    for (const name of [
      "Authorization",
      "ChatGPT-Account-ID",
      "anthropic-version",
      "Anthropic-Beta",
      "content-type",
      "Host",
    ]) {
      const res = await setProxy(api, cookie, codexId, { baseUrl: null, headers: { [name]: "x" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `Mage sets ${name.toLowerCase()} itself` });
    }
    for (const baseUrl of ["ftp://proxy.example.com", "not a url"]) {
      expect((await setProxy(api, cookie, codexId, { baseUrl, headers: {} })).status).toBe(400);
    }
    const unknown = await setProxy(api, cookie, codexId, {
      baseUrl: null,
      headers: { "x-new": null },
    });
    expect(unknown.status).toBe(400);
    const split = await setProxy(api, cookie, codexId, {
      baseUrl: null,
      headers: { "x-two": "a\r\nb" },
    });
    expect(split.status).toBe(400);
  });

  it("never show header values, keep a value given as null, and keep them sealed", async () => {
    const { db, api, connections, ready } = setup();
    const { cookie, orgId, userId, codexId } = await ready();

    await setProxy(api, cookie, codexId, { baseUrl: null, headers: { "X-Secret": "s3cret" } });
    const listed = await (await api("GET", "/connections", cookie)).text();
    expect(listed).not.toContain("s3cret");
    expect(JSON.parse(listed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: codexId,
          proxy: { baseUrl: null, headerNames: ["x-secret"] },
        }),
        expect.objectContaining({ proxy: null }),
      ]),
    );
    const sealed = db.select().from(schema.credential).all();
    expect(sealed.some((row) => Buffer.from(row.sealed).includes("s3cret"))).toBe(false);

    await setProxy(api, cookie, codexId, {
      baseUrl: null,
      headers: { "x-secret": null, "x-other": "o" },
    });
    expect(connections.proxyOf({ orgId, userId }, codexId)).toEqual({
      baseUrl: null,
      headerNames: ["x-secret", "x-other"],
    });
    const token = await connections.withFreshToken(orgId, codexId, async (t) => t);
    expect(token.proxy).toEqual({
      baseUrl: null,
      headers: { "x-secret": "s3cret", "x-other": "o" },
    });
  });

  it("survive a token refresh", async () => {
    const { api, clock, connections, refreshes, ready } = setup();
    const { cookie, orgId, codexId } = await ready();
    await setProxy(api, cookie, codexId, { baseUrl: proxyUrl, headers: { "x-team": "blue" } });

    clock.now = new Date(clock.now.getTime() + 2 * 60 * 60 * 1000);
    const token = await connections.withFreshToken(orgId, codexId, async (t) => t);

    expect(refreshes).toEqual(["codex-refresh"]);
    expect(token).toEqual({
      access: "codex-renewed",
      accountId: "acct-123",
      proxy: { baseUrl: proxyUrl, headers: { "x-team": "blue" } },
    });
  });

  it("forget the cached list when changed, and go back to the provider when cleared", async () => {
    const { api, models, requests, ready } = setup();
    const { cookie, orgId, anthropicId } = await ready();
    await models.resolveModels(orgId);
    const urls = () => requests.map((request) => request.url.split("?")[0]);

    await setProxy(api, cookie, anthropicId, { baseUrl: proxyUrl, headers: {} });
    await models.resolveModels(orgId);
    expect(urls().at(-1)).toBe(`${proxyUrl}/models`);

    const cleared = await setProxy(api, cookie, anthropicId, { baseUrl: null, headers: {} });
    expect(await cleared.json()).toMatchObject({ proxy: null });
    await models.resolveModels(orgId);
    expect(urls().at(-1)).toBe(anthropicUrl);
  });
});

describe("API keys", () => {
  const key = ["sk", "ant", "api03", "secret", "abcd"].join("-");

  async function addKey(
    api: ReturnType<typeof setup>["api"],
    cookie: string,
    body: { provider: string; label?: string | null; key: string; proxy?: unknown },
  ) {
    const { provider, key: apiKey, ...rest } = body;
    return api("POST", "/connections", cookie, {
      host: provider,
      method: "api_key",
      values: { apiKey },
      ...rest,
    });
  }

  it("are added once the provider lists models with them, and never shown again", async () => {
    const { api, db, requests, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await addKey(api, cookie, { provider: "anthropic", label: "Work", key });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret");
    const added = JSON.parse(text) as { id: string };
    expect(added).toMatchObject({
      host: "anthropic",
      authKind: "api_key",
      account: "sk-ant-…abcd",
      settings: { method: "api_key" },
      label: "Work",
      proxy: null,
    });
    expect(requests[0]?.url).toBe(`${anthropicUrl}?limit=1000`);
    expect(requests[0]?.headers.get("x-api-key")).toBe(key);
    expect(requests[0]?.headers.get("authorization")).toBeNull();

    const listed = await (await api("GET", "/connections", cookie)).text();
    expect(listed).not.toContain("secret");
    expect(JSON.stringify(db.select().from(schema.credential).all())).not.toContain("secret");

    const models = (await (await api("GET", "/models", cookie)).json()) as {
      models: { ref: string; connectionLabel: string }[];
    };
    expect(models.models.map((model) => [model.ref, model.connectionLabel])).toEqual([
      [`${added.id}/claude-big`, "Anthropic · Work"],
      [`${added.id}/claude-old`, "Anthropic · Work"],
    ]);
    // Read from the list the key was checked with.
    expect(requests).toHaveLength(1);
  });

  it("refuse a key the provider does not take, and store nothing", async () => {
    const { api, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await addKey(api, cookie, { provider: "anthropic", key: "sk-ant-wrong" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Anthropic did not accept these details (model list failed with status 401).",
    });
    expect((await addKey(api, cookie, { provider: "anthropic", key: "" })).status).toBe(400);
    expect((await addKey(api, cookie, { provider: "nowhere", key })).status).toBe(400);
    expect(await (await api("GET", "/connections", cookie)).json()).toEqual([]);
  });

  it("can be several, each with its own refs, and deleted", async () => {
    const { api, ready } = setup();
    const { cookie, anthropicId } = await ready();
    const first = (await (await addKey(api, cookie, { provider: "anthropic", key })).json()) as {
      id: string;
      label: string | null;
    };
    const second = (await (
      await addKey(api, cookie, { provider: "anthropic", label: "Spare", key: `${key}2` })
    ).json()) as { id: string };
    expect(first.label).toBeNull();

    const refs = async () =>
      ((await (await api("GET", "/models", cookie)).json()) as { models: { ref: string }[] }).models
        .map((model) => model.ref)
        .filter((ref) => ref.endsWith("/claude-big"));
    expect(await refs()).toEqual([
      `${anthropicId}/claude-big`,
      `${first.id}/claude-big`,
      `${second.id}/claude-big`,
    ]);

    expect((await api("DELETE", `/connections/${first.id}`, cookie)).status).toBe(200);
    expect(await refs()).not.toContain(`${first.id}/claude-big`);
  });

  it("reply through the provider's API with the key, and fail as a sign-in once removed", async () => {
    const { api, models, streamed, signUp, connections } = setup();
    const owner = await signUp("Ada Lovelace", "ada@example.com");
    const added = (await (
      await addKey(api, owner.cookie, { provider: "anthropic", key })
    ).json()) as { id: string };

    const model = await models.open(owner.orgId, `${added.id}/claude-big`);
    for await (const _event of model.stream(
      { instructions: "", messages: [], maxSteps: 1, sessionId: "t1" },
      new AbortController().signal,
    ));
    expect(streamed).toMatchObject([
      { kind: "anthropic", token: { access: key }, request: { model: "claude-big" } },
    ]);

    connections.remove(owner, added.id);
    await expect(models.open(owner.orgId, `${added.id}/claude-big`)).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("are checked through the proxy given with them, which they keep, and can be relabelled", async () => {
    const { api, requests, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await addKey(api, cookie, {
      provider: "anthropic",
      key,
      proxy: { baseUrl: "https://proxy.example.com/v1", headers: { "X-Team": "blue" } },
    } as never);
    expect(res.status).toBe(200);
    const added = (await res.json()) as { id: string; proxy: unknown };
    expect(added.proxy).toEqual({
      baseUrl: "https://proxy.example.com/v1",
      headerNames: ["x-team"],
    });
    expect(requests[0]?.url).toBe("https://proxy.example.com/v1/models?limit=1000");
    expect(requests[0]?.headers.get("x-team")).toBe("blue");

    const bad = await addKey(api, cookie, {
      provider: "anthropic",
      key,
      proxy: { baseUrl: "ftp://proxy.example.com", headers: {} },
    } as never);
    expect(bad.status).toBe(400);

    const renamed = await api("PATCH", `/connections/${added.id}`, cookie, { label: "Team" });
    expect(await renamed.json()).toMatchObject({
      label: "Team",
      hints: { apiKey: "sk-ant-…abcd" },
      proxy: { baseUrl: "https://proxy.example.com/v1" },
    });
    expect(requests.at(-1)?.url).toBe("https://proxy.example.com/v1/models?limit=1000");
    expect(requests.at(-1)?.headers.get("x-api-key")).toBe(key);
    const cleared = await api("PATCH", `/connections/${added.id}`, cookie, { label: " " });
    expect(await cleared.json()).toMatchObject({ label: null });
  });

  it("are for the owner of a personal org", async () => {
    const { api, db, signUp } = setup();
    const { cookie, userId } = await signUp("Ada Lovelace", "ada@example.com");
    db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, userId)).run();

    expect((await addKey(api, cookie, { provider: "anthropic", key })).status).toBe(403);
  });
});

describe("connections to other hosts", () => {
  it("are added with their settings shown and their secrets sealed, models with their makers", async () => {
    const { api, db, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await api("POST", "/connections", cookie, {
      host: "custom",
      method: "endpoint",
      label: "Lab box",
      values: { baseUrl: "http://llm.local/v1/", apiKey: "lab-secret-key", models: "my-tune" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("lab-secret-key");
    const added = JSON.parse(text) as { id: string };
    expect(added).toMatchObject({
      host: "custom",
      authKind: "endpoint",
      account: "llm.local",
      label: "Lab box",
      settings: { method: "endpoint", baseUrl: "http://llm.local/v1", models: "my-tune" },
    });
    expect(JSON.stringify(db.select().from(schema.credential).all())).not.toContain("lab-secret");

    const { models } = (await (await api("GET", "/models", cookie)).json()) as {
      models: { id: string; maker: string | null; host: string; connectionLabel: string }[];
    };
    expect(models.map((model) => [model.id, model.maker, model.host])).toEqual([
      ["llama-4-scout", "meta", "custom"],
      ["my-tune", null, "custom"],
    ]);
    expect(models[0]?.connectionLabel).toBe("OpenAI-compatible · Lab box");
  });

  it("refuse missing fields and details the host does not take, and store nothing", async () => {
    const { api, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const missing = await api("POST", "/connections", cookie, {
      host: "bedrock",
      method: "access_keys",
      values: { region: "us-east-1", accessKeyId: "AKIA1" },
    });
    expect(await missing.json()).toEqual({ error: "Give the secret access key" });
    const refused = await api("POST", "/connections", cookie, {
      host: "bedrock",
      method: "access_keys",
      values: { region: "us-east-1", accessKeyId: "AKIA1", secretAccessKey: "s" },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^Amazon Bedrock did not accept these details/,
    );
    const signIn = await api("POST", "/connections", cookie, {
      host: "codex",
      method: "sign_in",
      values: {},
    });
    expect(signIn.status).toBe(400);
    expect(await (await api("GET", "/connections", cookie)).json()).toEqual([]);
  });
});

describe("changing a connection", () => {
  async function labBox() {
    const workspace = setup();
    const owner = await workspace.signUp("Ada Lovelace", "ada@example.com");
    const { cookie } = owner;
    const res = await workspace.api("POST", "/connections", cookie, {
      host: "custom",
      method: "endpoint",
      label: "Lab box",
      values: { baseUrl: "http://llm.local/v1", apiKey: "lab-secret-key", models: "my-tune" },
    });
    const { id } = (await res.json()) as { id: string };
    return { ...workspace, owner, cookie, id };
  }

  it("keeps a secret left blank, and its refs, and reads its list again", async () => {
    const { api, cookie, id, requests } = await labBox();
    const ref = `${id}/llama-4-scout`;
    await api("PUT", "/settings/default-model", cookie, { ref });

    const res = await api("PATCH", `/connections/${id}`, cookie, {
      method: "endpoint",
      label: "Lab",
      values: { baseUrl: "http://llm2.local/v1/", apiKey: "", models: "other-tune" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("lab-secret-key");
    expect(JSON.parse(text)).toMatchObject({
      id,
      label: "Lab",
      account: "llm2.local",
      settings: { method: "endpoint", baseUrl: "http://llm2.local/v1", models: "other-tune" },
      hints: { apiKey: "lab-secret-…-key" },
    });
    expect(requests.at(-1)?.url).toBe("http://llm2.local/v1/models");
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer lab-secret-key");

    const { models } = (await (await api("GET", "/models", cookie)).json()) as {
      models: { ref: string; connectionLabel: string }[];
    };
    expect(models.map((model) => [model.ref, model.connectionLabel])).toEqual([
      [ref, "OpenAI-compatible · Lab"],
      [`${id}/other-tune`, "OpenAI-compatible · Lab"],
    ]);
    expect(await (await api("GET", "/settings/default-model", cookie)).json()).toMatchObject({
      ref,
    });

    // A secret typed replaces the stored one.
    await api("PATCH", `/connections/${id}`, cookie, { values: { apiKey: "new-lab-key-0001" } });
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer new-lab-key-0001");
  });

  it("refuses details the host does not take, and keeps what it had", async () => {
    const { api, cookie, id } = await labBox();
    const refused = await api("PATCH", `/connections/${id}`, cookie, {
      values: { baseUrl: "http://elsewhere.local/v1", models: "" },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^OpenAI-compatible did not accept these details/,
    );
    const missing = await api("PATCH", `/connections/${id}`, cookie, { values: { baseUrl: "" } });
    expect(await missing.json()).toEqual({ error: "Give the base url" });
    const [kept] = (await (await api("GET", "/connections", cookie)).json()) as object[];
    expect(kept).toMatchObject({ account: "llm.local", label: "Lab box" });
  });

  it("is for the org's owners, and not for a sign-in", async () => {
    const { api, cookie, db, id, connect, owner } = await labBox();
    const signIn = connect(owner, "codex");
    const refused = await api("PATCH", `/connections/${signIn}`, cookie, { label: "Mine" });
    expect(await refused.json()).toEqual({ error: "A sign-in has nothing to change" });

    db.update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, owner.userId))
      .run();
    expect((await api("PATCH", `/connections/${id}`, cookie, { label: "Mine" })).status).toBe(403);
  });
});

describe("the default effort", () => {
  it("is none until an admin picks one, and goes back to none", async () => {
    const { api, db, signUp } = setup();
    const { cookie, userId } = await signUp("Ada Lovelace", "ada@example.com");
    const effort = async () => (await api("GET", "/settings/default-effort", cookie)).json();

    expect(await effort()).toEqual({ effort: null });
    expect((await api("PUT", "/settings/default-effort", cookie, { effort: "high" })).status).toBe(
      200,
    );
    expect(await effort()).toEqual({ effort: "high" });
    expect((await api("PUT", "/settings/default-effort", cookie, { effort: "max" })).status).toBe(
      400,
    );
    await api("PUT", "/settings/default-effort", cookie, { effort: null });
    expect(await effort()).toEqual({ effort: null });

    db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, userId)).run();
    expect((await api("PUT", "/settings/default-effort", cookie, { effort: "low" })).status).toBe(
      403,
    );
  });
});

describe("turning models on and off", () => {
  type Listed = {
    autoEnable: boolean;
    models: { id: string; enabled: boolean }[];
    spacesUsingOff?: { name: string }[];
  };
  const withNew = {
    status: 200,
    body: {
      ...anthropicModels,
      data: [
        ...anthropicModels.data,
        {
          id: "claude-new",
          display_name: "Claude New",
          max_input_tokens: 1000,
          capabilities: null,
        },
      ],
    },
  };

  it("keeps a model turned off out of the pickers, and refuses it as a default", async () => {
    const { api, ready } = setup();
    const { cookie, anthropicId } = await ready();

    const res = await api("PATCH", `/connections/${anthropicId}/models`, cookie, {
      set: { ids: ["claude-old"], enabled: false },
    });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as Listed;
    expect(listed.models.map((m) => [m.id, m.enabled])).toEqual([
      ["claude-big", true],
      ["claude-old", false],
    ]);
    const refs = (
      (await (await api("GET", "/models", cookie)).json()) as { models: { ref: string }[] }
    ).models.map((m) => m.ref);
    expect(refs).toContain(`${anthropicId}/claude-big`);
    expect(refs).not.toContain(`${anthropicId}/claude-old`);
    expect(
      (await api("PUT", "/settings/default-model", cookie, { ref: `${anthropicId}/claude-old` }))
        .status,
    ).toBe(400);
  });

  it("keeps the org's default model on, and names spaces that start threads on one turned off", async () => {
    const { api, ready, db } = setup();
    const owner = await ready();
    await api("PUT", "/settings/default-model", owner.cookie, {
      ref: `${owner.anthropicId}/claude-big`,
    });
    const off = (ids: string[]) =>
      api("PATCH", `/connections/${owner.anthropicId}/models`, owner.cookie, {
        set: { ids, enabled: false },
      });

    const refused = await off(["claude-big"]);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Claude Big is the organization's default model. Choose another default first.",
    });

    // Turned off with others, it stays on and the others go.
    const together = (await (await off(["claude-big", "claude-old"])).json()) as {
      models: { id: string; enabled: boolean; orgDefault: boolean }[];
    };
    expect(together.models.map((m) => [m.id, m.enabled, m.orgDefault])).toEqual([
      ["claude-big", true, true],
      ["claude-old", false, false],
    ]);

    const space = db
      .select()
      .from(schema.space)
      .where(eq(schema.space.organizationId, owner.orgId))
      .get();
    db.update(schema.space)
      .set({ defaultModel: `${owner.anthropicId}/claude-old` })
      .run();
    const res = await off(["claude-old"]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Listed).spacesUsingOff).toEqual([
      { id: space?.id, name: space?.name },
    ]);
  });

  it("turns on models first listed later, unless the connection says not to", async () => {
    const { api, ready, replies } = setup();
    const { cookie, anthropicId } = await ready();
    const list = async () =>
      (await (
        await api("GET", `/connections/${anthropicId}/models?refresh=1`, cookie)
      ).json()) as Listed;
    expect((await list()).autoEnable).toBe(true);

    await api("PATCH", `/connections/${anthropicId}/models`, cookie, { autoEnable: false });
    replies.anthropic = withNew;
    const later = await list();
    expect(later.autoEnable).toBe(false);
    expect(later.models.find((m) => m.id === "claude-new")?.enabled).toBe(false);
    expect(later.models.find((m) => m.id === "claude-big")?.enabled).toBe(true);
  });

  it("leaves threads and spaces on a model turned off, which can no longer reply", async () => {
    const { api, ready, db, models } = setup();
    const owner = await ready();
    const old = `${owner.anthropicId}/claude-old`;
    const space = db
      .select()
      .from(schema.space)
      .where(eq(schema.space.organizationId, owner.orgId))
      .get();
    db.update(schema.space).set({ defaultModel: old }).run();
    db.insert(schema.thread)
      .values({ id: "t1", spaceId: space!.id, model: old, createdBy: owner.userId })
      .run();
    const turn = (enabled: boolean) =>
      api("PATCH", `/connections/${owner.anthropicId}/models`, owner.cookie, {
        set: { ids: ["claude-old"], enabled },
      });

    await turn(false);
    expect(db.select().from(schema.thread).get()?.model).toBe(old);
    expect(db.select().from(schema.space).get()?.defaultModel).toBe(old);
    expect(await models.availability(owner.orgId, old)).toEqual({
      ref: old,
      name: "Claude Old",
      status: "off",
    });

    await turn(true);
    expect(db.select().from(schema.thread).get()?.model).toBe(old);
    expect((await models.availability(owner.orgId, old)).status).toBe("ok");
    expect((await models.availability(owner.orgId, `${owner.anthropicId}/gone`)).status).toBe(
      "unavailable",
    );
  });

  it("does not reply with a model turned off", async () => {
    const { api, ready, models } = setup();
    const owner = await ready();
    await api("PATCH", `/connections/${owner.anthropicId}/models`, owner.cookie, {
      set: { ids: ["claude-old"], enabled: false },
    });

    await expect(models.open(owner.orgId, `${owner.anthropicId}/claude-old`)).rejects.toMatchObject(
      {
        kind: "model",
        summary: "Model Claude Old is turned off. Choose another model to continue.",
      },
    );
  });
});

describe("the model a thread replies with", () => {
  // As a ref from the Claude sign-in, since removed, is.
  it("is the first model still on when even the org's default is gone", async () => {
    const { ready, db, models } = setup();
    const owner = await ready();
    db.insert(schema.orgSetting)
      .values({ organizationId: owner.orgId, defaultModel: "claude/gone" })
      .run();
    const space = { orgId: owner.orgId, defaultModel: null, defaultEffort: null };

    const [first] = (await models.resolveModels(owner.orgId)).models;
    expect(await models.replyModel(space, { model: null, effort: null })).toEqual({
      chosen: { ref: "claude/gone", name: "gone", status: "unavailable" },
      used: { ref: first?.ref, name: first?.name, status: "ok" },
      effort: null,
    });
    // The org's choice stays as it was.
    expect(db.select().from(schema.orgSetting).get()?.defaultModel).toBe("claude/gone");
  });
});

describe("a model and its effort", () => {
  const thread = { model: "a/own", effort: "high" as const };
  const space = { model: "a/space", effort: "medium" as const };
  const org = { model: "a/org", effort: "low" as const };

  it("are the thread's own, then each default with the effort that goes with it", () => {
    expect(replyCandidates(thread, space, org)).toEqual([
      { ref: "a/own", effort: "high" },
      { ref: "a/space", effort: "medium" },
      { ref: "a/org", effort: "low" },
    ]);
  });

  it("follow the defaults where the thread has none, its own effort with the model it follows", () => {
    expect(replyCandidates({ model: null, effort: null }, space, org)[0]).toEqual({
      ref: "a/space",
      effort: "medium",
    });
    expect(replyCandidates({ model: "a/own", effort: null }, space, org)[0]).toEqual({
      ref: "a/own",
      effort: "medium",
    });
    expect(replyCandidates({ model: null, effort: "high" }, space, org)[0]).toEqual({
      ref: "a/space",
      effort: "high",
    });
    // A space without an effort of its own takes the org's with its model.
    expect(replyCandidates(thread, { model: "a/space", effort: null }, org)[1]).toEqual({
      ref: "a/space",
      effort: "low",
    });
  });

  it("fall back together to the first that can reply", async () => {
    const status = (off: string[]) => (ref: string) =>
      Promise.resolve({
        ref,
        name: ref,
        status: off.includes(ref) ? ("off" as const) : ("ok" as const),
      });
    const candidates = replyCandidates(thread, space, org);

    expect(await pickReplyModel(candidates, status(["a/own"]))).toMatchObject({
      chosen: { ref: "a/own" },
      used: { ref: "a/space" },
      effort: "medium",
    });
    expect(await pickReplyModel(candidates, status(["a/own", "a/space"]))).toMatchObject({
      used: { ref: "a/org" },
      effort: "low",
    });
    expect(await pickReplyModel(candidates, status(["a/own", "a/space", "a/org"]))).toMatchObject({
      chosen: { ref: "a/own" },
      used: null,
      effort: "high",
    });
  });

  it("are the first model still on with its usual effort when no default can reply", async () => {
    const { ready, db, models } = setup();
    const owner = await ready();
    db.insert(schema.orgSetting)
      .values({ organizationId: owner.orgId, defaultModel: "claude/gone", defaultEffort: "high" })
      .run();
    const space = { orgId: owner.orgId, defaultModel: null, defaultEffort: null };

    const reply = await models.replyModel(space, { model: "claude/gone", effort: "low" });

    expect(reply?.used?.status).toBe("ok");
    expect(reply?.effort).toBeNull();
  });
});

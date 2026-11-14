// A signed-up app with real spaces, threads, guests and runs over an in-memory database, for the
// tests of spaces, threads, their guests, their events and the agent's runs. The
// agent replies through a model the test drives, once the test starts the worker; threads are
// named, when asked for, through another. A stand-in directory provisions people and groups over
// SCIM, a stand-in MCP server answers at its address, unless the test takes it down, and a
// stand-in git host serves repositories of skills, made the first time one is read.

import { rmSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, expect } from "vite-plus/test";

import type { RunWorkerOptions } from "@/server/agent/runs.ts";
import type { Toolset } from "@/server/agent/tools.ts";
import { compose, type Systems } from "@/server/compose.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { RunTraces } from "@/server/kernel/tracing.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import type { Connections } from "@/server/models/connections.ts";
import {
  defaultsOf,
  type Models,
  type ModelList,
  pickReplyModel,
} from "@/server/models/service.ts";
import type { OrgRole } from "@/server/orgs/directory.ts";
import * as schema from "@/server/schema.ts";
import type { Space, SpaceRole } from "@/server/spaces/service.ts";
import { type ModelPair, replyCandidates } from "@/shared/models.ts";
import type { Effort } from "@/shared/threads/thread.ts";

import { createFixtures, gitStandIn } from "../../../mock/git.ts";
import { mcpStandIn } from "../../../mock/mcp.ts";
import { scimClient } from "../../../mock/directory.ts";
import { openTestDatabase, type TestDatabase } from "./database.ts";
import { invariants } from "./invariants.ts";
import { createSeed, joinSpace, seedRoutes } from "./seed.ts";
import { scriptedModel } from "./scripted-model.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;

const baseUrl = "http://localhost:4783";
export const ARTIFACT_ORIGIN = "http://localhost:4784";

export const SCIM_TOKEN = "test-scim-token-that-is-long-enough-0123456789";

// Where the stand-in MCP server answers.
export const MCP_ORIGIN = "http://localhost:4791";

// Where the stand-in git host answers, and the folder of its repositories, made once for every
// test in the file that reads one.
export const GIT_ORIGIN = "http://git.test";
let gitRoot: string | null = null;
export function gitFixtures() {
  if (!gitRoot) {
    const root = createFixtures();
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    gitRoot = root;
  }
  return gitRoot;
}
const gitFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== GIT_ORIGIN) {
    return Promise.reject(new TypeError("fetch failed"));
  }
  return gitStandIn(gitFixtures())(request);
}) as typeof fetch;

export type SpaceBody = {
  id: string;
  name: string;
  primary: boolean;
  role: string | null;
  manage: boolean;
  kind: string;
  everyoneRole: string | null;
};
export type ThreadBody = {
  id: string;
  spaceId: string;
  title: string;
  model: string | null;
};

// The databases of the workspaces the test under way set up, checked as it ends, once their
// workers have stopped.
// Each workspace also counts locks taken out of order and calls across the network made inside a
// transaction, of which a test may make none.
const opened = new Set<Systems>();
const working = new Set<{ stop(): Promise<void> }>();
afterEach(async () => {
  await Promise.all([...working].map((worker) => worker.stop()));
  working.clear();
  const all = [...opened];
  opened.clear();
  await Promise.all(all.map(async ({ sync }) => sync.stop()));
  const broken = (await Promise.all(all.map(async ({ db }) => invariants(db)))).flat();
  expect(broken).toEqual([]);
  const { outOfOrder, insideCalls } = all.reduce(
    (sum, { sync }) => ({
      outOfOrder: sum.outOfOrder + sync.stats.outOfOrder,
      insideCalls: sum.insideCalls + sync.stats.insideCalls,
    }),
    { outOfOrder: 0, insideCalls: 0 },
  );
  expect({ outOfOrder, insideCalls }).toEqual({ outOfOrder: 0, insideCalls: 0 });
});

export function setup(
  workerOptions: Partial<RunWorkerOptions> = {},
  {
    titles = false,
    teamOrgs = "everyone" as "everyone" | "operator",
    operatorEmails = [] as string[],
    // Toolsets of Mage's own beside the usual ones, for tests of tools that need one.
    toolsets = [] as Toolset[],
    // A database another workspace shares, as a second server instance would: its `database`.
    database = undefined as TestDatabase | undefined,
    // Whether the app has the routes tests arrange data through.
    testRoutes = true,
    // What ties runs' spans to what woke their threads; runs are not traced without it.
    traces = undefined as RunTraces | undefined,
  } = {},
) {
  const shared = database ?? openTestDatabase();
  const logger = createLogger({ write() {} });
  // The models the org can use, and its defaults.
  const org = {
    defaultModel: null as string | null,
    defaultEffort: null as Effort | null,
    models: ["codex/gpt-big"],
    // Refs of models that take no effort.
    plain: [] as string[],
    // Refs turned off.
    off: [] as string[],
    // The slug each connection goes by in aliases, by the prefix of its refs.
    slugs: {} as Record<string, string>,
    titleModel: null as string | null,
    automaticTitleModel: null as string | null,
  };
  const prefixOf = (ref: string) => ref.slice(0, ref.indexOf("/"));
  const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
  const canonical = (ref: string) => {
    const prefix = Object.keys(org.slugs).find((one) => org.slugs[one] === prefixOf(ref));
    return prefix ? `${prefix}/${idOf(ref)}` : ref;
  };
  const alias = (given: string) => {
    const ref = canonical(given);
    return `${org.slugs[prefixOf(ref)] ?? prefixOf(ref)}/${idOf(ref)}`;
  };
  const canonicalRef = async (_orgId: string, ref: string) => canonical(ref);
  const aliasOf = async (_orgId: string, given: string) => alias(given);
  // A ref's host by its prefix: the ChatGPT sign-in's, and an Anthropic key's, named `claude`.
  const throughOf = (ref: string) =>
    prefixOf(ref) === "codex" ? "ChatGPT" : prefixOf(ref) === "claude" ? "Anthropic" : null;
  const modelLabels = async () => async (given: string) => {
    const ref = canonical(given);
    return throughOf(ref) && `${idOf(ref)} · ${throughOf(ref)}`;
  };
  const models = {
    aliasOf,
    canonicalRef,
    modelLabels,
    resolveModels: async (_orgId: string): Promise<ModelList> => ({
      models: org.models
        .filter((ref) => !org.off.includes(ref))
        .map((ref) => ({
          id: ref.slice(ref.indexOf("/") + 1),
          ref,
          alias: alias(ref),
          name: ref.slice(ref.indexOf("/") + 1),
          connectionId: ref.slice(0, ref.indexOf("/")),
          host: "codex",
          maker: "openai",
          authKind: "oauth",
          connectionLabel: "ChatGPT",
          connectionName: null,
          // Only a model said to take no effort says so.
          ...(org.plain.includes(ref) && { reasoning: false }),
        })),
      errors: [],
      turnedOff: [],
    }),
    defaultModel: async () => org.defaultModel,
    defaults: async (space: Pick<Space, "defaultModel" | "defaultEffort">) =>
      defaultsOf(space, org),
    replyModel: (space: Pick<Space, "defaultModel" | "defaultEffort">, own: ModelPair) =>
      replyModel(space, own),
    availability: (_orgId: string, ref: string) =>
      Promise.resolve({
        ref,
        name: ref.slice(ref.indexOf("/") + 1),
        status: org.off.includes(ref) ? ("off" as const) : ("ok" as const),
      }),
    // A ref's maker and host by its prefix: the ChatGPT sign-in's models are OpenAI's, and those
    // of an Anthropic key, named `claude`, Anthropic's.
    shownModels: async () => (ref: string) => {
      const prefix = ref.slice(0, ref.indexOf("/"));
      const host = prefix === "codex" ? "codex" : prefix === "claude" ? "anthropic" : null;
      const maker = host && (host === "codex" ? "openai" : "anthropic");
      const connection = host && (host === "codex" ? "ChatGPT" : "Anthropic API key");
      return { ref, name: ref.slice(ref.indexOf("/") + 1), maker, host, connection } as const;
    },
    requireModel: (_orgId: string, ref: string) =>
      org.models.includes(ref)
        ? Promise.resolve()
        : Promise.reject(new ServiceError(400, `${ref} is not a model this org can use.`)),
  };
  // The model a run replies with, as the models service decides it, from the refs turned off.
  function replyModel(space: Pick<Space, "defaultModel" | "defaultEffort">, own: ModelPair) {
    return pickReplyModel(
      replyCandidates(
        own,
        { model: space.defaultModel, effort: space.defaultEffort },
        { model: org.defaultModel, effort: org.defaultEffort },
      ),
      (ref) => models.availability("", ref),
    );
  }
  // The stand-in MCP server, reached while it is up; anything else cannot be reached.
  const mcpNetwork = {
    up: true,
    handle: mcpStandIn({ origin: MCP_ORIGIN }),
    // Each request it was sent.
    requests: [] as Request[],
  };
  const mcpFetch = async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!mcpNetwork.up || new URL(request.url).origin !== MCP_ORIGIN) {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }
    mcpNetwork.requests.push(request.clone());
    return mcpNetwork.handle(request);
  };
  const model = scriptedModel();
  const titleModel = scriptedModel();
  // The model refs threads were named with.
  const titledWith: string[] = [];
  const logLines: object[] = [];
  // A test sets the clock and runs ticks itself, as one more instance would with `triggersFor`.
  const clock = { now: new Date() };
  // Stands for the server stopping.
  const shutdown = new AbortController();
  const systems = compose({
    database: shared,
    config: {
      baseUrl,
      authSecret: "test-secret-that-is-long-enough-0123456789",
      authTrustedOrigins: [],
      oidc: null,
      scimToken: SCIM_TOKEN,
      artifactOrigin: ARTIFACT_ORIGIN,
      teamOrgs,
      operatorEmails,
      fakeModels: false,
    },
    cipher: createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
    logger,
    fetch: () => Promise.reject(new TypeError("fetch failed")),
    shutdown: shutdown.signal,
    ...(traces && { traces }),
    ports: {
      models: { ...unusedModels, ...models },
      runModels: { open: () => model.open(), replyModel },
      connections: unusedConnections,
      mcpFetch: mcpFetch as typeof fetch,
      gitFetch,
      titleModels: titles && {
        defaultModel: models.defaultModel,
        chosenTitleModel: async () => org.titleModel,
        automaticTitleModel: () => Promise.resolve(org.automaticTitleModel),
        open: (_orgId, ref) => {
          titledWith.push(ref);
          return titleModel.open();
        },
      },
    },
    options: {
      now: () => clock.now,
      toolsets,
      heartbeatMs: 20,
      pingDatabase: () => Promise.resolve(true),
      worker: {
        flushMs: 1,
        logger: createLogger({ write: (line: string) => void logLines.push(JSON.parse(line)) }),
        ...workerOptions,
      },
      ...(testRoutes && { testRoutes: (deps) => seedRoutes(createSeed(deps)) }),
    },
  });
  opened.add(systems);
  const { app, spaceStore, db } = systems;
  // Subscriptions still open.
  const listening = {
    get count() {
      return systems.bus.subscriptions();
    },
  };
  // A worker as a server process would start it, sharing this app's stores.
  function makeWorker(options: Partial<RunWorkerOptions> = {}) {
    const made = systems.makeWorker(options);
    working.add(made);
    return made;
  }
  working.add(systems.worker);

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
    const member = (
      await db.select().from(schema.member).where(eq(schema.member.userId, user.id)).limit(1)
    )[0];
    return {
      userId: user.id,
      orgId: member?.organizationId as string,
      role: "owner" as OrgRole,
      cookie,
    };
  }

  // Makes the user a member of the space with the role, acting from then on in the space's org.
  async function join<T extends { userId: string }>(user: T, spaceId: string, role: SpaceRole) {
    const space = await spaceStore.find(spaceId);
    if (!space) throw new Error("no space");
    await joinSpace(db, user.userId, space, role);
    return { ...user, orgId: space.orgId, role: "member" as OrgRole };
  }

  // `org` names the org the request acts in.
  async function api(method: string, path: string, cookie: string, body?: object, org?: string) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        ...(org && { "X-Mage-Org": org }),
      },
      body: body && JSON.stringify(body),
    });
  }

  async function listSpaces(cookie: string) {
    const res = await api("GET", "/spaces", cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as SpaceBody[];
  }

  async function createSpace(cookie: string, name: string) {
    const res = await api("POST", "/spaces", cookie, { name });
    expect(res.status).toBe(200);
    return (await res.json()) as SpaceBody;
  }

  async function yourSpace(cookie: string) {
    const [space] = await listSpaces(cookie);
    if (!space) throw new Error("no space");
    return space;
  }

  async function createThread(cookie: string, spaceId: string, text?: string) {
    const res = await api("POST", `/spaces/${spaceId}/threads`, cookie, text ? { text } : {});
    expect(res.status).toBe(200);
    return (await res.json()) as ThreadBody;
  }

  const scim = scimClient({
    baseUrl,
    token: SCIM_TOKEN,
    fetch: (url, init) => app.request(url, init),
  });

  return {
    ...systems,
    // The database itself, outside any transaction, for another workspace to share.
    database: shared,
    shutdown,
    scim,
    org,
    model,
    titleModel,
    titledWith,
    makeWorker,
    triggersFor: systems.makeTriggers,
    logLines,
    listening,
    clock,
    mcpNetwork,
    signUp,
    join,
    api,
    listSpaces,
    createSpace,
    yourSpace,
    createThread,
  };
}

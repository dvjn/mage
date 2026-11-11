// A signed-up app with real spaces, threads, guests and runs over an in-memory database, for the
// tests of spaces, threads, their guests, their events and the agent's runs. The
// agent replies through a model the test drives, once the test starts the worker; threads are
// named, when asked for, through another. A stand-in directory provisions people and groups over
// SCIM, a stand-in MCP server answers at its address, unless the test takes it down, and a
// stand-in git host serves repositories of skills, made the first time one is read.

import { rmSync } from "node:fs";

import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { expect } from "vite-plus/test";

import { createSubagentStore } from "@/server/agent/subagent-store.ts";
import { createSubagents } from "@/server/agent/subagents.ts";
import { CHOOSE_MODELS, SUBAGENTS_TOOLSET } from "@/shared/subagents.ts";
import { createRichReplies } from "@/server/agent/rich-replies.ts";
import { createRunStore } from "@/server/agent/run-store.ts";
import { createRunWorker, type RunWorkerOptions } from "@/server/agent/runs.ts";
import { createSystemTools } from "@/server/agent/system-tools.ts";
import { createToolPolicies } from "@/server/agent/tool-policies.ts";
import { createToolPolicyStore } from "@/server/agent/tool-policy-store.ts";
import { createMcpTools, createToolSearch } from "@/server/agent/tool-search.ts";
import { createToolSettingStore } from "@/server/agent/tool-setting-store.ts";
import { createArtifacts } from "@/server/artifacts/service.ts";
import { createArtifactStore } from "@/server/artifacts/store.ts";
import { createToolDecisions, createTools } from "@/server/agent/tools.ts";
import { createApp } from "@/server/app.ts";
import { createTransact, openDatabase } from "@/server/db/db.ts";
import { createGuests } from "@/server/guests/service.ts";
import { createGuestStore } from "@/server/guests/store.ts";
import { createInstructions } from "@/server/instructions/service.ts";
import { createInstructionStore } from "@/server/instructions/store.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import { createEventBus } from "@/server/kernel/event-bus.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import { createMcpClient, mcpOAuthClientAt } from "@/server/mcp/client.ts";
import { createMcpServers } from "@/server/mcp/service.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/server/mcp/store.ts";
import type { Connections } from "@/server/models/connections.ts";
import {
  defaultsOf,
  type Models,
  type ModelList,
  pickReplyModel,
} from "@/server/models/service.ts";
import { createAuth, createIdentity } from "@/server/orgs/auth.ts";
import { createDirectory } from "@/server/orgs/directory-store.ts";
import type { OrgRole } from "@/server/orgs/directory.ts";
import { createGroups } from "@/server/orgs/groups.ts";
import { createOrgInviteStore } from "@/server/orgs/invite-store.ts";
import { createOrgs } from "@/server/orgs/service.ts";
import { createOrgSettingStore } from "@/server/orgs/setting-store.ts";
import * as schema from "@/server/schema.ts";
import { createGitReader } from "@/server/skills/git.ts";
import { createSkills } from "@/server/skills/service.ts";
import { createSkillStore } from "@/server/skills/store.ts";
import { createZipReader } from "@/server/skills/zip.ts";
import { agentNameIn, type Space, type SpaceRole, createSpaces } from "@/server/spaces/service.ts";
import { createSpaceStore } from "@/server/spaces/store.ts";
import { createThreadAccess } from "@/server/spaces/thread-access.ts";
import { createDeltaStore } from "@/server/threads/delta-store.ts";
import { createAsideStore } from "@/server/threads/asides.ts";
import { createThreadLog } from "@/server/threads/log.ts";
import { createThreadReadStore } from "@/server/threads/read-store.ts";
import { createThreads } from "@/server/threads/service.ts";
import { createCommands } from "@/server/threads/commands.ts";
import { createThreadStore } from "@/server/threads/store.ts";
import { createTitles } from "@/server/threads/titles.ts";
import { type ModelPair, replyCandidates } from "@/shared/models.ts";
import type { Effort } from "@/shared/threads/thread.ts";

import { createFixtures, gitStandIn } from "../../../e2e/git-server.ts";
import { mcpStandIn } from "../../../e2e/mcp-server.ts";
import { scimClient } from "../../../e2e/scim-client.ts";
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

export function setup(
  workerOptions: Partial<RunWorkerOptions> = {},
  {
    titles = false,
    teamOrgs = "everyone" as "everyone" | "operator",
    operatorEmails = [] as string[],
  } = {},
) {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const hooks = createHooks();
  const auth = createAuth({
    db,
    hooks,
    logger,
    secret,
    baseUrl,
    trustedOrigins: [],
    scim: {
      token: SCIM_TOKEN,
      changed: (userId, active) => orgs.directoryChanged(userId, active),
    },
  });
  const spaceStore = createSpaceStore(db);
  const threadStore = createThreadStore(db);
  // The models the org can use, and its defaults.
  const org = {
    defaultModel: null as string | null,
    defaultEffort: null as Effort | null,
    models: ["codex/gpt-big"],
    // Refs of models that take no effort.
    plain: [] as string[],
    // Refs turned off.
    off: [] as string[],
    titleModel: null as string | null,
    automaticTitleModel: null as string | null,
  };
  const models = {
    resolveModels: async (_orgId: string): Promise<ModelList> => ({
      models: org.models
        .filter((ref) => !org.off.includes(ref))
        .map((ref) => ({
          id: ref.slice(ref.indexOf("/") + 1),
          ref,
          name: ref.slice(ref.indexOf("/") + 1),
          connectionId: ref.slice(0, ref.indexOf("/")),
          host: "codex",
          maker: "openai",
          authKind: "oauth",
          connectionLabel: "ChatGPT",
          connectionName: null,
        })),
      errors: [],
      turnedOff: [],
    }),
    defaultModel: () => org.defaultModel,
    defaults: (space: Pick<Space, "defaultModel" | "defaultEffort">) => defaultsOf(space, org),
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
    shownModels: () => (ref: string) => {
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
  const directory = createDirectory(db, auth);
  const settingStore = createOrgSettingStore(db);
  const spaces = createSpaces({
    spaces: spaceStore,
    threads: threadStore,
    models,
    directory,
    settings: settingStore,
    hooks,
  });
  const guestStore = createGuestStore(db);
  const access = createThreadAccess({
    spaces,
    threads: threadStore,
    guests: guestStore,
    directory,
  });
  const toolSettings = createToolSettingStore(db);
  const toolPolicyStore = createToolPolicyStore(db);
  const bus = createEventBus();
  // Subscriptions still open.
  const listening = { count: 0 };
  const countingBus: typeof bus = {
    ...bus,
    publish: (threadId, event) => bus.publish(threadId, event),
    subscribe(threadId, listener) {
      listening.count += 1;
      const unsubscribe = bus.subscribe(threadId, listener);
      return () => {
        listening.count -= 1;
        unsubscribe();
      };
    },
  };
  const runStore = createRunStore(db);
  const deltaStore = createDeltaStore(db);
  const transact = createTransact(db);
  const log = createThreadLog({ threads: threadStore, bus: countingBus, transact });
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
  const mcpServerStore = createMcpServerStore(db);
  const mcp = createMcpServers({
    servers: mcpServerStore,
    credentials: createMcpCredentialStore(
      db,
      createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
    ),
    client: createMcpClient({
      fetch: mcpFetch,
      oauth: mcpOAuthClientAt(baseUrl),
      version: "test",
    }),
    spaces,
    settings: settingStore,
    logger,
    hooks,
  });
  const cipher = createCipher({ version: 1, key: Buffer.alloc(32, 7) });
  const skillStore = createSkillStore(db, cipher);
  const instructions = createInstructions({ store: createInstructionStore(db), spaces });
  const skills = createSkills({
    skills: skillStore,
    git: createGitReader({ fetch: gitFetch }),
    archives: createZipReader(),
    spaces,
    settings: settingStore,
    logger,
  });
  const subagentStore = createSubagentStore(db);
  const subagents = createSubagents({
    subagents: subagentStore,
    threads: threadStore,
    runs: runStore,
    log,
    bus: countingBus,
    choosesModels: (spaceId) => {
      const space = spaceStore.find(spaceId);
      return !!space && tools.optionOn(space, SUBAGENTS_TOOLSET, CHOOSE_MODELS);
    },
    modelsIn: () =>
      Promise.resolve(org.models.map((ref) => ({ ref, reasoning: !org.plain.includes(ref) }))),
  });
  const artifacts = createArtifacts({
    store: createArtifactStore(db),
    threads: threadStore,
    spaceStore,
    spaces,
    access,
    guests: guestStore,
    directory,
    appOrigin: baseUrl,
    artifactOrigin: ARTIFACT_ORIGIN,
    secret: "test-secret-that-is-long-enough-0123456789",
  });
  const tools = createTools({
    toolsets: [
      createRichReplies(),
      createSystemTools({
        threads: threadStore,
        spaceStore,
        guests: guestStore,
        models: {
          replyModel,
          requireModel: models.requireModel,
          resolveModels: models.resolveModels,
        },
        open: () => model.open(),
      }),
      skills.toolset(),
      createMcpTools(
        [
          createToolSearch((space) => mcp.toolsetsInSpace(space).length > 0),
          // A server's resources follow its tools: listed only while one of them is on in the space.
          ...mcp.resourceTools((space) => {
            const rules = tools.rulesIn(space);
            return (toolId) => !rules(toolId).off;
          }),
        ],
        mcp.hasServers,
      ),
      subagents.toolset(),
      artifacts.toolset(),
    ],
    scoped: {
      inSpace: (space) => mcp.toolsetsInSpace(space),
      forOrgSettings: (orgId) => mcp.toolsetsForOrgSettings(orgId),
      forSpaceSettings: (space) => mcp.toolsetsForSpaceSettings(space),
      named: (toolId) => mcp.named(toolId),
    },
    settings: toolSettings,
    policies: toolPolicyStore,
    directory,
    access,
  });

  const model = scriptedModel();
  const titleModel = scriptedModel();
  // The model refs threads were named with.
  const titledWith: string[] = [];
  const threads = createThreads({
    agentNameIn: (space) => agentNameIn(settingStore, space),
    ask: (threadId, branchId, rowId) => worker.requestAt(threadId, branchId, rowId),
    asides: createAsideStore(db),
    spaces,
    spaceStore,
    access,
    guests: guestStore,
    threads: threadStore,
    reads: createThreadReadStore(db),
    runs: runStore,
    deltas: deltaStore,
    models,
    log,
    bus: countingBus,
    tools,
    subagents,
    commands: createCommands({ skills, prompts: mcp }),
    ...(titles && {
      titles: createTitles({
        models: {
          defaultModel: models.defaultModel,
          chosenTitleModel: () => org.titleModel,
          automaticTitleModel: () => Promise.resolve(org.automaticTitleModel),
          open: (_orgId, ref) => {
            titledWith.push(ref);
            return titleModel.open();
          },
        },
        threads: threadStore,
        log,
        logger,
      }),
    }),
  });
  const logLines: object[] = [];
  // A worker as a server process would start it, sharing this app's stores.
  function makeWorker(options: Partial<RunWorkerOptions> = {}) {
    return createRunWorker({
      runs: runStore,
      threads: threadStore,
      spaceStore,
      access,
      deltas: deltaStore,
      log,
      bus: countingBus,
      transact,
      flushMs: 1,
      models: { open: () => model.open(), replyModel },
      tools,
      guidance: (space, offered, thread) => ({
        ...instructions.textsFor(space),
        mcpServers: mcp.instructionsIn(space, offered),
        skills: skills.listFor(space, offered),
        agentName: agentNameIn(settingStore, space),
        ...subagents.guidance(thread, tools.guidanceIn(space)),
      }),
      narrow: (thread, offered) => subagents.toolsOf(thread, offered),
      before: (thread) => subagents.before(thread),
      ended: (run) => subagents.ended(run),
      logger: createLogger({ write: (line: string) => void logLines.push(JSON.parse(line)) }),
      runsIn: (space) => spaces.runsIn(space),
      hooks,
      ...workerOptions,
      ...options,
    });
  }
  const worker = makeWorker();
  const orgs = createOrgs({
    directory,
    invites: createOrgInviteStore(db),
    spaces,
    spaceStore,
    threads: threadStore,
    runs: runStore,
    settings: settingStore,
    hooks,
    baseUrl,
    teamOrgs,
    operatorEmails,
  });
  // Stands for the server stopping.
  const shutdown = new AbortController();
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections: unusedConnections,
    models: { ...unusedModels, ...models },
    spaces,
    threads,
    guests: createGuests({
      access,
      guests: guestStore,
      directory,
      threads: threadStore,
      transact,
      bus: countingBus,
      baseUrl,
    }),
    orgs,
    groups: createGroups({ directory }),
    tools: createToolDecisions({
      tools,
      access,
      threads: threadStore,
      spaceStore,
      runs: runStore,
      spaces,
      settings: toolSettings,
      policies: toolPolicyStore,
      log,
      bus: countingBus,
    }),
    toolPolicies: createToolPolicies({
      policies: toolPolicyStore,
      settings: toolSettings,
      tools,
      spaceStore,
      spaces,
      directory,
    }),
    mcp,
    instructions,
    skills,
    artifacts,
    logger,
    signInOptions: { oidc: null },
    pingDatabase: () => Promise.resolve(true),
    heartbeatMs: 20,
    shutdown: shutdown.signal,
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
    return {
      userId: user.id,
      orgId: member?.organizationId as string,
      role: "owner" as OrgRole,
      cookie,
    };
  }

  // Makes the user a member of the space with the role, acting from then on in the space's org.
  function join<T extends { userId: string }>(user: T, spaceId: string, role: SpaceRole) {
    const space = spaceStore.find(spaceId);
    if (!space) throw new Error("no space");
    db.insert(schema.member)
      .values({
        id: ulid(),
        organizationId: space.orgId,
        userId: user.userId,
        role: "member",
        directRole: "member",
        createdAt: new Date(),
      })
      .run();
    db.update(schema.session)
      .set({ activeOrganizationId: space.orgId })
      .where(eq(schema.session.userId, user.userId))
      .run();
    db.insert(schema.spaceMember)
      .values({ spaceId, subjectKind: "user", subjectId: user.userId, role, source: "direct" })
      .run();
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
    db,
    app,
    hooks,
    shutdown,
    scim,
    org,
    spaceStore,
    threadStore,
    runStore,
    deltaStore,
    transact,
    log,
    bus: countingBus,
    model,
    titleModel,
    titledWith,
    worker,
    makeWorker,
    logLines,
    listening,
    spaces,
    threads,
    access,
    directory,
    settingStore,
    guestStore,
    toolSettings,
    toolPolicyStore,
    tools,
    subagents,
    subagentStore,
    mcp,
    mcpNetwork,
    mcpServerStore,
    instructions,
    skills,
    skillStore,
    artifacts,
    signUp,
    join,
    api,
    listSpaces,
    createSpace,
    yourSpace,
    createThread,
  };
}

// A signed-up app with real spaces, folders, threads, guests and runs over an in-memory database,
// for the tests of spaces, folders, threads, their guests, their events and the agent's runs. The
// agent replies through a model the test drives, once the test starts the worker; threads are
// named, when asked for, through another. A stand-in directory provisions people and groups over
// SCIM, and a stand-in MCP server answers at its address, unless the test takes it down.

import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { expect } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createTransact, openDatabase } from "@/adapters/db.ts";
import { createDeltaStore } from "@/adapters/deltas.ts";
import { createDirectory } from "@/adapters/directory.ts";
import { createEventBus } from "@/adapters/event-bus.ts";
import { createFolderStore } from "@/adapters/folders.ts";
import { createGuestStore } from "@/adapters/guests.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createMcpClient } from "@/adapters/mcp-client.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/adapters/mcp-servers.ts";
import { createOrgInviteStore } from "@/adapters/org-invites.ts";
import { createOrgSettingStore } from "@/adapters/org-settings.ts";
import { createRunStore } from "@/adapters/runs.ts";
import * as schema from "@/adapters/schema.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createThreadReadStore } from "@/adapters/thread-reads.ts";
import { createThreadStore } from "@/adapters/threads.ts";
import { createToolSettingStore } from "@/adapters/tool-settings.ts";
import { createApp } from "@/http/app.ts";
import type { OrgRole } from "@/ports/directory.ts";
import type { Space, SpaceRole } from "@/ports/spaces.ts";
import type { Connections } from "@/services/connections.ts";
import { defaultsOf, type Models, pickReplyModel } from "@/services/models.ts";
import { type ModelPair, replyCandidates } from "@/shared/models.ts";
import { ServiceError } from "@/services/errors.ts";
import { createFolders } from "@/services/folders.ts";
import { createGroups } from "@/services/groups.ts";
import { createGuests } from "@/services/guests.ts";
import { createMcpServers } from "@/services/mcp-servers.ts";
import { createOrgs } from "@/services/orgs.ts";
import { createRunWorker, dropRefusedWaiting, type RunWorkerOptions } from "@/services/runs.ts";
import { createSpaces } from "@/services/spaces.ts";
import { createSystemTools } from "@/services/system-tools.ts";
import { createThreadAccess } from "@/services/thread-access.ts";
import { createThreadLog } from "@/services/thread-log.ts";
import { createThreads } from "@/services/threads.ts";
import { createTitles } from "@/services/titles.ts";
import { createToolDecisions, createTools } from "@/services/tools.ts";
import type { Effort } from "@/shared/threads.ts";

import { mcpStandIn } from "../e2e/mcp-server.ts";
import { scimClient } from "../e2e/scim-client.ts";
import { scriptedModel } from "./scripted-model.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;

const baseUrl = "http://localhost:4783";

export const SCIM_TOKEN = "test-scim-token-that-is-long-enough-0123456789";

// Where the stand-in MCP server answers.
export const MCP_ORIGIN = "http://localhost:4791";

export type SpaceBody = {
  id: string;
  name: string;
  primary: boolean;
  role: string | null;
  manage: boolean;
  kind: string;
  everyoneRole: string | null;
};
export type FolderBody = {
  id: string;
  spaceId: string;
  parentFolderId: string | null;
  name: string;
};
export type ThreadBody = {
  id: string;
  spaceId: string;
  folderId: string | null;
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
  const auth = createAuth({
    db,
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
    // Refs turned off.
    off: [] as string[],
    titleModel: null as string | null,
    automaticTitleModel: null as string | null,
  };
  const models = {
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
  const accessChanged = (orgId: string) =>
    dropRefusedWaiting({ threads: threadStore, spaceStore, runs: runStore, access, log, orgId });
  const spaces = createSpaces({
    spaces: spaceStore,
    threads: threadStore,
    models,
    directory,
    settings: settingStore,
    accessChanged,
  });
  const folderStore = createFolderStore(db);
  const folders = createFolders({ spaces, folders: folderStore });
  const guestStore = createGuestStore(db);
  const access = createThreadAccess({
    spaces,
    threads: threadStore,
    guests: guestStore,
  });
  const toolSettings = createToolSettingStore(db);
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
      oauth: { clientName: "Mage", redirectUrl: `${baseUrl}/api/mcp/oauth/callback` },
      version: "test",
    }),
    spaces,
    settings: settingStore,
    logger,
  });
  const tools = createTools({
    toolsets: [
      createSystemTools({
        threads: threadStore,
        spaceStore,
        folders: folderStore,
        guests: guestStore,
        models: { replyModel, requireModel: models.requireModel },
      }),
    ],
    scoped: {
      inSpace: (space) => mcp.toolsetsInSpace(space),
      forOrgSettings: (orgId) => mcp.toolsetsForOrgSettings(orgId),
      forSpaceSettings: (space) => mcp.toolsetsForSpaceSettings(space),
    },
    settings: toolSettings,
    access,
  });
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
  const model = scriptedModel();
  const titleModel = scriptedModel();
  // The model refs threads were named with.
  const titledWith: string[] = [];
  const threads = createThreads({
    spaces,
    spaceStore,
    access,
    guests: guestStore,
    folders,
    threads: threadStore,
    reads: createThreadReadStore(db),
    runs: runStore,
    deltas: deltaStore,
    models,
    log,
    bus: countingBus,
    tools,
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
      logger: createLogger({ write: (line: string) => void logLines.push(JSON.parse(line)) }),
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
    accessChanged,
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
    folders,
    threads,
    guests: createGuests({
      access,
      guests: guestStore,
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
      log,
      bus: countingBus,
    }),
    mcp,
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

  async function createFolder(cookie: string, spaceId: string, name: string) {
    const res = await api("POST", `/spaces/${spaceId}/folders`, cookie, { name });
    expect(res.status).toBe(200);
    return (await res.json()) as FolderBody;
  }

  async function listFolders(cookie: string, spaceId: string) {
    const res = await api("GET", `/spaces/${spaceId}/folders`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as FolderBody[];
  }

  const scim = scimClient({
    baseUrl,
    token: SCIM_TOKEN,
    fetch: (url, init) => app.request(url, init),
  });

  return {
    db,
    app,
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
    tools,
    mcp,
    mcpNetwork,
    mcpServerStore,
    signUp,
    join,
    api,
    listSpaces,
    createSpace,
    yourSpace,
    createThread,
    createFolder,
    listFolders,
  };
}

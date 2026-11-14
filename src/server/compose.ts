// Builds every system of the server over one database, in the order they depend on each other,
// for the server process and for the tests alike. Tests hand in stand-ins for what reaches outside
// (models, connections, MCP and git hosts) through `ports`; the server hands in none.

import type { Hono } from "hono";
import { ulid } from "ulid";

import type { ArtifactPreviewer } from "@/server/artifacts/preview.ts";
import { createArtifacts } from "@/server/artifacts/service.ts";
import { createArtifactStore } from "@/server/artifacts/store.ts";
import { createCallStore } from "@/server/agent/call-store.ts";
import { createLive } from "@/server/agent/live.ts";
import { createLiveStore } from "@/server/agent/live-store.ts";
import { createCalls } from "@/server/agent/calls.ts";
import { createNotifier } from "@/server/agent/notifications.ts";
import { createTasks } from "@/server/agent/tasks.ts";
import { createTaskStore } from "@/server/agent/task-store.ts";
import { createTriggerStore } from "@/server/agent/trigger-store.ts";
import { createTriggers } from "@/server/agent/triggers.ts";
import { createSubagentStore } from "@/server/agent/subagent-store.ts";
import { createSubagents } from "@/server/agent/subagents.ts";
import { createWatchStore } from "@/server/agent/watches.ts";
import { createRichReplies } from "@/server/agent/rich-replies.ts";
import { createRunStore } from "@/server/agent/run-store.ts";
import { createRunWorker, type RunWorkerOptions } from "@/server/agent/runs.ts";
import { createSystemTools } from "@/server/agent/system-tools.ts";
import { createToolPolicies } from "@/server/agent/tool-policies.ts";
import { createToolPolicyStore } from "@/server/agent/tool-policy-store.ts";
import { createMcpTools, createToolSearch } from "@/server/agent/tool-search.ts";
import { createToolSettingStore } from "@/server/agent/tool-setting-store.ts";
import { createToolDecisions, createTools, type Toolset } from "@/server/agent/tools.ts";
import { type Db, pingDatabase } from "@/server/db/db.ts";
import { createGuests } from "@/server/guests/service.ts";
import { createGuestStore } from "@/server/guests/store.ts";
import { createInstructions } from "@/server/instructions/service.ts";
import { createInstructionStore } from "@/server/instructions/store.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Config } from "@/server/kernel/config.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { createSync, type Listen } from "@/server/sync/sync.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { TraceRelay } from "@/server/kernel/trace-relay.ts";
import type { RunTraces } from "@/server/kernel/tracing.ts";
import { createMcpClient, mcpOAuthClientAt } from "@/server/mcp/client.ts";
import { createMcpServers } from "@/server/mcp/service.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/server/mcp/store.ts";
import { createModelChoiceStore } from "@/server/models/choice-store.ts";
import { createConnectionStore } from "@/server/models/connection-store.ts";
import { type Connections, createConnections } from "@/server/models/connections.ts";
import { createCredentialStore } from "@/server/models/credential-store.ts";
import { createHostAdapters } from "@/server/models/hosts.ts";
import {
  createFakeCatalogs,
  createFakeGateway,
  FAKE_MODEL_REF,
} from "@/server/models/hosts/fake-gateway.ts";
import { createClaudeOAuth } from "@/server/models/hosts/anthropic-claude.ts";
import { createCodexOAuth } from "@/server/models/hosts/openai-codex.ts";
import { createModels, type Models, type OpenModel } from "@/server/models/service.ts";
import { createAuth, createIdentity } from "@/server/orgs/auth.ts";
import { createDirectory } from "@/server/orgs/directory-store.ts";
import { createGroups } from "@/server/orgs/groups.ts";
import { createOrgInviteStore } from "@/server/orgs/invite-store.ts";
import { createOrgs } from "@/server/orgs/service.ts";
import { createOrgSettingStore } from "@/server/orgs/setting-store.ts";
import { createGitReader } from "@/server/skills/git.ts";
import { createSkills } from "@/server/skills/service.ts";
import { createSkillStore } from "@/server/skills/store.ts";
import { createZipReader } from "@/server/skills/zip.ts";
import { agentNameIn, createSpaces } from "@/server/spaces/service.ts";
import { createSpaceStore } from "@/server/spaces/store.ts";
import { createAccess } from "@/server/access/access.ts";
import { createDeltaStore } from "@/server/threads/delta-store.ts";
import { createAsideStore } from "@/server/threads/asides.ts";
import { createThreadLog, type ThreadLog } from "@/server/threads/log.ts";
import { createThreadReadStore } from "@/server/threads/read-store.ts";
import { createThreads } from "@/server/threads/service.ts";
import { createCommands } from "@/server/threads/commands.ts";
import { createThreadStore } from "@/server/threads/store.ts";
import { createTranscripts } from "@/server/threads/transcripts.ts";
import { createTitles, type TitlesOptions } from "@/server/threads/titles.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { CHOOSE_MODELS, SUBAGENTS_TOOLSET } from "@/shared/subagents.ts";

import { createApp } from "./app.ts";

// What the routes tests arrange data through are made from.
export interface SeedDeps {
  db: Db;
  threads: ReturnType<typeof createThreadStore>;
  guests: ReturnType<typeof createGuestStore>;
  reads: ReturnType<typeof createThreadReadStore>;
  log: ThreadLog;
}

export interface ComposeDeps {
  database: { db: Db; listen?: Listen };
  config: Pick<
    Config,
    | "baseUrl"
    | "authSecret"
    | "authTrustedOrigins"
    | "oidc"
    | "scimToken"
    | "artifactOrigin"
    | "teamOrgs"
    | "operatorEmails"
    | "fakeModels"
  >;
  cipher: Cipher;
  logger: Logger;
  fetch: typeof fetch;
  previewer?: ArtifactPreviewer | null;
  traces?: RunTraces;
  traceRelay?: TraceRelay;
  webRoot?: string;
  shutdown: AbortSignal;
  // Stand-ins for what reaches outside the server; the tests set these, the server none.
  ports?: {
    models?: Models;
    runModels?: Pick<Models, "open" | "replyModel">;
    connections?: Connections;
    mcpFetch?: typeof fetch;
    gitFetch?: typeof fetch;
    // What names threads; false names none.
    titleModels?: TitlesOptions["models"] | false;
  };
  options?: {
    // Names this server instance among those sharing the database.
    instanceId?: string;
    now?: () => Date;
    worker?: Partial<RunWorkerOptions>;
    toolsets?: Toolset[];
    heartbeatMs?: number;
    pingDatabase?: () => Promise<boolean>;
    testRoutes?: (deps: SeedDeps) => Hono;
  };
}

export type Systems = ReturnType<typeof compose>;

export function compose(deps: ComposeDeps) {
  const { config, cipher, logger, ports = {}, options = {} } = deps;
  const sync = createSync({
    db: deps.database.db,
    listen: deps.database.listen,
    logger,
    instanceId: options.instanceId,
  });
  const { db, transact } = sync;
  // What reaches across the network, which no transaction may wait on.
  const fetch = sync.outside("fetch", deps.fetch);
  const mcpFetch = sync.outside("MCP fetch", ports.mcpFetch ?? deps.fetch);
  const gitFetch = sync.outside("git fetch", ports.gitFetch ?? deps.fetch);
  const previewer = deps.previewer && {
    preview: sync.outside("artifact preview", deps.previewer.preview.bind(deps.previewer)),
  };
  const opened = <M extends { open: (orgId: string, ref: string) => Promise<OpenModel> }>(
    what: string,
    models: M,
  ): M => ({
    ...models,
    open: async (orgId: string, ref: string) => {
      const model = await models.open(orgId, ref);
      return { ...model, stream: sync.outside(what, model.stream.bind(model)) };
    },
  });
  const hooks = createHooks();
  const auth = createAuth({
    db,
    hooks,
    logger,
    secret: config.authSecret,
    baseUrl: config.baseUrl,
    trustedOrigins: config.authTrustedOrigins,
    oidc: config.oidc,
    // The directory's changes settle the orgs the person is in, or could be through a group.
    scim: config.scimToken
      ? {
          token: config.scimToken,
          changed: (userId, active) => orgs.directoryChanged(userId, active),
        }
      : null,
  });

  const connectionStore = createConnectionStore(db);
  const connections =
    ports.connections ??
    createConnections({
      connections: connectionStore,
      credentials: createCredentialStore(db, cipher),
      providers: {
        codex: { label: "ChatGPT", oauth: createCodexOAuth(fetch) },
        claude: { label: "Claude", oauth: createClaudeOAuth(fetch) },
      },
      logger,
    });
  const spaceStore = createSpaceStore(db);
  const threadStore = createThreadStore(db);
  const directory = createDirectory(db, auth);
  const settingStore = createOrgSettingStore(db);
  const models = ports.models ?? realModels();
  function realModels() {
    const hosts = createHostAdapters(fetch);
    // Connections are checked against the stand-in's lists when replies come from it, but for
    // servers people run, whose lists are read where they say.
    const catalogs = config.fakeModels ? createFakeCatalogs(hosts.catalogs) : hosts.catalogs;
    return createModels({
      connections: connectionStore,
      choices: createModelChoiceStore(db),
      spaces: spaceStore,
      tokens: connections,
      catalogs,
      settings: settingStore,
      gateways: hosts.gateways,
      logger,
    });
  }
  const runStore = createRunStore(db);
  const deltaStore = createDeltaStore(db);
  const { instanceId } = sync;
  const bus = sync.signals;
  const log = createThreadLog({ threads: threadStore, bus, transact, ordered: sync.ordered });
  const spaces = createSpaces({
    spaces: spaceStore,
    threads: threadStore,
    models,
    directory,
    settings: settingStore,
    hooks,
  });
  const guestStore = createGuestStore(db);
  const readStore = createThreadReadStore(db);
  const access = createAccess({
    spaceStore,
    spaces,
    threads: threadStore,
    guests: guestStore,
    directory,
    settings: settingStore,
  });
  const toolSettings = createToolSettingStore(db);
  const toolPolicyStore = createToolPolicyStore(db);
  const mcpServerStore = createMcpServerStore(db);
  const mcp = createMcpServers({
    servers: mcpServerStore,
    credentials: createMcpCredentialStore(db, cipher),
    client: createMcpClient({
      fetch: mcpFetch,
      oauth: mcpOAuthClientAt(config.baseUrl),
      version: "0.0.0",
    }),
    spaces,
    settings: settingStore,
    logger,
    hooks,
  });
  const instructions = createInstructions({ store: createInstructionStore(db), spaces });
  const skillStore = createSkillStore(db, cipher);
  const skills = createSkills({
    skills: skillStore,
    git: createGitReader({ fetch: gitFetch }),
    archives: createZipReader(),
    spaces,
    settings: settingStore,
    logger,
  });
  // Threads' transcripts, folded once for the agent and the people reading them.
  const transcripts = createTranscripts(threadStore, bus, hooks, sync.inTransaction);
  // Whether a notified thread's agent may start is the subagents' call, for every notifier.
  const notifier = createNotifier({
    transcripts,
    runs: runStore,
    log,
    bus,
    mayStart: async (threadId) => subagents.mayStart(threadId),
  });
  const watches = createWatchStore(db);
  const subagentStore = createSubagentStore(db);
  const subagents = createSubagents({
    subagents: subagentStore,
    threads: threadStore,
    transcripts,
    runs: runStore,
    log,
    bus,
    choosesModels: async (spaceId) => {
      const space = await spaceStore.find(spaceId);
      return !!space && (await tools.optionOn(space, SUBAGENTS_TOOLSET, CHOOSE_MODELS));
    },
    taskHandover: () => tasks.handover,
    modelsIn: async (orgId) => (await models.resolveModels(orgId)).models,
    notifier,
    watches,
  });
  const agentNameOf = async (spaceId: string) => {
    const space = await spaceStore.find(spaceId);
    return space ? await agentNameIn(settingStore, space) : DEFAULT_AGENT_NAME;
  };
  const callStore = createCallStore(db);
  const live = createLive({
    store: createLiveStore(db),
    bus,
    transact,
    ordered: sync.ordered,
  });
  const calls = createCalls({
    live,
    calls: callStore,
    threads: threadStore,
    transcripts,
    spaceStore,
    runs: runStore,
    log,
    bus,
    logger,
    tools: () => tools,
    narrow: async (thread, offered) => subagents.toolsOf(thread, offered),
    notifier,
    instanceId,
    keeper: sync.keeper,
  });
  const tasks = createTasks({
    tasks: createTaskStore(db),
    threads: threadStore,
    transcripts,
    access,
    orgOf: async (spaceId) => (await spaceStore.find(spaceId))?.orgId ?? null,
    subagents,
    log,
    bus,
    agentNameIn: agentNameOf,
    notifier,
    watches,
  });
  const triggerStore = createTriggerStore(db, cipher);
  // Timers and schedules, as one more instance on the database would tick them.
  const makeTriggers = () =>
    createTriggers({
      baseUrl: config.baseUrl,
      transact,
      sync,
      triggers: triggerStore,
      threads: threadStore,
      transcripts,
      access,
      subagents,
      log,
      bus,
      logger,
      agentNameIn: agentNameOf,
      notifier,
      ...(options.now && { now: options.now }),
    });
  const triggers = makeTriggers();
  // Previews need a browser, which servers without one go without.
  const artifacts = createArtifacts({
    store: createArtifactStore(db),
    bus,
    threads: threadStore,
    spaceStore,
    spaces,
    access,
    guests: guestStore,
    directory,
    appOrigin: new URL(config.baseUrl).origin,
    artifactOrigin: config.artifactOrigin,
    secret: config.authSecret,
    previewer: previewer ?? null,
  });
  // Whether the space uses any MCP server, which Mage's own MCP tools need.
  const usesServers = async (space: { id: string; orgId: string }) =>
    (await mcp.toolsetsInSpace(space)).length > 0;
  const tools = createTools({
    toolsets: [
      createRichReplies(),
      createSystemTools({
        threads: threadStore,
        transcripts,
        spaceStore,
        guests: guestStore,
        models,
        // The model that replies, opened as the worker opens it.
        open: (orgId, ref) => runModels.open(orgId, ref),
      }),
      skills.toolset(),
      createMcpTools(
        [
          createToolSearch(usesServers),
          // A server's resources follow its tools: listed only while one of them is on in the
          // space.
          ...mcp.resourceTools(async (space) => {
            const rules = await tools.rulesIn(space);
            return (toolId) => !rules(toolId).off;
          }),
        ],
        mcp.hasServers,
        usesServers,
      ),
      subagents.toolset(),
      calls.toolset(),
      tasks.toolset(),
      triggers.toolset(),
      artifacts.toolset(),
      ...(options.toolsets ?? []),
    ],
    scoped: {
      inSpace: async (space) => mcp.toolsetsInSpace(space),
      forOrgSettings: async (orgId) => mcp.toolsetsForOrgSettings(orgId),
      forSpaceSettings: async (space) => mcp.toolsetsForSpaceSettings(space),
      named: async (toolId) => mcp.named(toolId),
    },
    settings: toolSettings,
    policies: toolPolicyStore,
    directory,
    access,
    modelRef: async (orgId, ref) => models.canonicalRef(orgId, ref),
    callModel: async (call) =>
      call.background
        ? ((await runStore.find((await callStore.find(call.id))?.runId ?? ""))?.model ?? null)
        : ((await runStore.find(call.runId))?.model ?? null),
  });

  const runModels = opened(
    "model",
    ports.runModels ?? (config.fakeModels ? fakeRunModels(models) : models),
  );
  // A worker as a server process starts it, sharing these stores; one more than this instance's
  // stands for another instance's, under a name of its own.
  function makeWorker(more: Partial<RunWorkerOptions> = {}, instance = ulid()) {
    return createRunWorker({
      runs: runStore,
      threads: threadStore,
      transcripts,
      spaceStore,
      access,
      deltas: deltaStore,
      log,
      bus,
      transact,
      afterCommit: sync.afterCommit,
      instanceId: instance,
      sync,
      models: runModels,
      tools,
      guidance: async (space, offered, thread, now) => ({
        ...(await instructions.textsFor(space)),
        mcpServers: await mcp.instructionsIn(space, offered),
        skills: await skills.listFor(space, offered),
        agentName: await agentNameIn(settingStore, space),
        ...(await subagents.guidance(thread, await tools.guidanceIn(space, now))),
      }),
      narrow: async (thread, offered) => subagents.toolsOf(thread, offered),
      before: async (thread) => subagents.before(thread),
      ended: async (run) => subagents.ended(run),
      adopt: async (call) => calls.adopt(call),
      live,
      logger,
      traces: deps.traces,
      runsIn: async (space) => spaces.runsIn(space),
      hooks,
      ...options.worker,
      ...more,
    });
  }
  const worker = makeWorker({}, instanceId);

  const orgs = createOrgs({
    directory,
    invites: createOrgInviteStore(db),
    spaces,
    spaceStore,
    threads: threadStore,
    runs: runStore,
    settings: settingStore,
    hooks,
    baseUrl: config.baseUrl,
    teamOrgs: config.teamOrgs,
    operatorEmails: config.operatorEmails,
  });

  const titling = ports.titleModels ?? (config.fakeModels ? false : models);
  const titleModels = titling && opened("title model", titling);
  const threads = createThreads({
    spaces,
    spaceStore,
    access,
    guests: guestStore,
    threads: threadStore,
    transcripts,
    reads: readStore,
    runs: runStore,
    deltas: deltaStore,
    models,
    log,
    bus,
    notifier,
    tools,
    subagents,
    background: callStore,
    live,
    triggers,
    tasks,
    commands: createCommands({ skills, prompts: mcp }),
    ask: (threadId, branchId, rowId) => worker.requestAt(threadId, branchId, rowId),
    asides: createAsideStore(db),
    ...(deps.traces && {
      runTrace: (runId: string) => deps.traces!.traceparent(runId),
    }),
    // The stand-in model answers every request alike, so it names no threads.
    ...(titleModels && {
      titles: createTitles({ models: titleModels, threads: threadStore, log, logger }),
    }),
  });

  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    models,
    spaces,
    threads,
    tasks,
    triggers,
    orgs,
    groups: createGroups({ directory }),
    tools: createToolDecisions({
      tools,
      access,
      transcripts,
      spaceStore,
      runs: runStore,
      spaces,
      settings: toolSettings,
      policies: toolPolicyStore,
      log,
      bus,
      background: {
        find: async (callId) => calls.find(callId),
        proceed: async (threadId, callId, allow) => calls.proceed(threadId, callId, allow),
        room: async (threadId) => calls.room(threadId),
        move: async (threadId, callId) => worker.moveToBackground(threadId, callId),
        detach: async (threadId, call, append) => calls.detach(threadId, call, append),
        cancel: async (threadId, callId) => calls.cancel(threadId, callId),
      },
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
    guests: createGuests({
      access,
      guests: guestStore,
      directory,
      threads: threadStore,
      transact,
      bus,
      baseUrl: config.baseUrl,
    }),
    logger,
    signInOptions: { oidc: config.oidc && { name: config.oidc.name } },
    pingDatabase: options.pingDatabase ?? (() => pingDatabase(db)),
    ...(options.heartbeatMs !== undefined && { heartbeatMs: options.heartbeatMs }),
    ...(options.testRoutes && {
      testRoutes: options.testRoutes({
        db,
        threads: threadStore,
        guests: guestStore,
        reads: readStore,
        log,
      }),
    }),
    webRoot: deps.webRoot,
    shutdown: deps.shutdown,
    ...(deps.traceRelay && { traceRelay: deps.traceRelay }),
  });

  // Spaces kept in trash or archived for too long are deleted on start and then every hour, by one
  // instance at a time.
  const sweep = sync.ticker(
    "space-sweep",
    async () => {
      const deleted = await spaces.sweep();
      if (deleted > 0) logger.info({ deleted }, "deleted expired spaces");
    },
    60 * 60 * 1000,
    { singleton: true },
  );

  return {
    db,
    sync,
    app,
    auth,
    hooks,
    connections,
    models,
    spaceStore,
    threadStore,
    runStore,
    deltaStore,
    transact,
    log,
    bus,
    worker,
    makeWorker,
    spaces,
    threads,
    access,
    directory,
    settingStore,
    guestStore,
    readStore,
    toolSettings,
    toolPolicyStore,
    tools,
    subagents,
    subagentStore,
    tasks,
    calls,
    triggers,
    makeTriggers,
    triggerStore,
    callStore,
    live,
    mcp,
    mcpServerStore,
    instructions,
    skills,
    skillStore,
    artifacts,
    orgs,
    spaceSweep: sweep,

    // Begins the background work: what other instances send, runs and background calls a stopped
    // server left, the run worker, timers and schedules, and the sweep of expired spaces.
    async start() {
      // What other instances on the database write reaches this one's streams and worker.
      await sync.start();
      // Runs and background calls a stopped server left running are settled before anyone reads
      // them, those whose leases have run out; other instances on the database may hold the rest.
      await worker.recover();
      await calls.start();
      await worker.start();
      // Timers and schedules that came due while the server was down fire first.
      await triggers.start();
      await sweep.start();
    },

    // Stops the background work and lets runs and background calls go, for recovery here or
    // elsewhere.
    async stop() {
      await triggers.stop();
      await Promise.all([calls.stop(), worker.stop()]);
      await sync.stop();
    },
  };
}

// The stand-in model answers every thread, whatever model it names.
function fakeRunModels(models: Models): Pick<Models, "open" | "replyModel"> {
  const fakeGateway = createFakeGateway();
  const fakeModel = { ref: FAKE_MODEL_REF, name: "echo", status: "ok" as const };
  return {
    // Picked as for providers, so a model turned off gives way; with none, the stand-in.
    replyModel: async (space, own) =>
      (await models.replyModel(space, own)) ?? {
        chosen: fakeModel,
        used: fakeModel,
        effort: own.effort,
      },
    open: () =>
      Promise.resolve({
        stream: (request, signal) =>
          fakeGateway.stream(
            { access: "", accountId: null },
            { ...request, model: "echo" },
            signal,
          ),
      }),
  };
}

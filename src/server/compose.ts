// Builds every system of the server over one database, in the order they depend on each other,
// for the server process and for the tests alike. Tests hand in stand-ins for what reaches outside
// (model hosts' lists and replies, MCP and git hosts) through `ports`; the server hands in none.

import type { Hono } from "hono";
import { ulid } from "ulid";

import type { ArtifactPreviewer } from "@/server/artifacts/preview.ts";
import { createArtifacts } from "@/server/artifacts/service.ts";
import { createArtifactStore } from "@/server/artifacts/store.ts";
import { createLive } from "@/server/calls/live.ts";
import { createLiveStore } from "@/server/calls/live-store.ts";
import { type Calls, createCalls } from "@/server/calls/calls.ts";
import { createCallStore } from "@/server/calls/store.ts";
import { createQueue, type Queue } from "@/server/queue/queue.ts";
import { createQueueStore } from "@/server/queue/store.ts";
import { createPosts } from "@/server/queue/posts.ts";
import { createTasks } from "@/server/tasks/tasks.ts";
import { createTaskStore } from "@/server/tasks/store.ts";
import { createSubagentStore } from "@/server/subagents/store.ts";
import { createSubagents } from "@/server/subagents/subagents.ts";
import { createOAuthAttempts } from "@/server/oauth/attempts.ts";
import { createWatchStore } from "@/server/subagents/watches.ts";
import { createRichReplies } from "@/server/execution/rich-replies.ts";
import { createRunStore } from "@/server/execution/store.ts";
import { createExecution, type Execution } from "@/server/execution/execution.ts";
import type { RunWorkerOptions } from "@/server/execution/worker.ts";
import { createSystemTools } from "@/server/execution/system-tools.ts";
import { createToolPolicies } from "@/server/tools/policies.ts";
import { createToolPolicyStore } from "@/server/tools/policy-store.ts";
import { createMcpTools, createToolSearch } from "@/server/tools/search.ts";
import { createToolSettingStore } from "@/server/tools/setting-store.ts";
import { createThreadToolStore } from "@/server/tools/thread-tool-store.ts";
import {
  createToolDecisions,
  createTools,
  type Toolset,
  type UseTest,
} from "@/server/tools/registry.ts";
import { type Db, pingDatabase } from "@/server/db/db.ts";
import { createGuests } from "@/server/guests/service.ts";
import { createGuestStore } from "@/server/guests/store.ts";
import { createInstructions } from "@/server/instructions/service.ts";
import { createInstructionStore } from "@/server/instructions/store.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Config } from "@/server/kernel/config.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { type AfterCommit, createSync, type Listen } from "@/server/sync/sync.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { TraceRelay } from "@/server/kernel/trace-relay.ts";
import type { RunTraces } from "@/server/kernel/tracing.ts";
import { createMcpClient, mcpOAuthClientAt } from "@/server/mcp/client.ts";
import { createMcpServers } from "@/server/mcp/service.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/server/mcp/store.ts";
import { createModelChoiceStore } from "@/server/models/choice-store.ts";
import { createConnectionStore } from "@/server/models/connection-store.ts";
import type { Catalog } from "@/server/models/catalog.ts";
import { createConnections } from "@/server/models/connections.ts";
import { createCredentialStore } from "@/server/models/credential-store.ts";
import type { ModelGateway } from "@/server/models/gateway.ts";
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
import { createAsideStore, createAsides } from "@/server/threads/asides.ts";
import { createBranches } from "@/server/threads/branches.ts";
import type { Thread, ThreadAsk } from "@/server/threads/types.ts";
import { createThreadLog, type ThreadLog } from "@/server/threads/log.ts";
import { createActivity } from "@/server/views/activity.ts";
import { createLists } from "@/server/views/lists.ts";
import { createNeeds } from "@/server/views/needs.ts";
import { createThreadReadStore } from "@/server/views/read-store.ts";
import { createReads } from "@/server/views/reads.ts";
import type { Views } from "@/server/views/routes.ts";
import { createThreadViews } from "@/server/views/thread.ts";
import { createThreads } from "@/server/threads/threads.ts";
import { createCommands } from "@/server/threads/commands.ts";
import { createThreadStore } from "@/server/threads/store.ts";
import { createTranscripts } from "@/server/threads/transcripts.ts";
import { createTitles } from "@/server/threads/titles.ts";
import type { HostId } from "@/shared/hosts.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { CHOOSE_MODELS, SUBAGENTS_TOOLSET } from "@/shared/subagents.ts";

import { createSchedules } from "@/server/schedules/schedules.ts";
import { createScheduleStore } from "@/server/schedules/store.ts";
import { createWebhookStore } from "@/server/webhooks/store.ts";
import { createWebhooks } from "@/server/webhooks/webhooks.ts";

import { createApp } from "./app.ts";
import { createSetRule } from "./schedules-and-webhooks.ts";

// What the routes tests arrange data through are made from.
export interface SeedDeps {
  db: Db;
  threads: ReturnType<typeof createThreadStore>;
  guests: ReturnType<typeof createGuestStore>;
  reads: ReturnType<typeof createThreadReadStore>;
  log: ThreadLog;
  queue: Pick<Queue, "fromLog">;
  calls: Pick<Calls, "fromLog">;
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
    // Each host's model list and replies.
    catalogs?: Record<HostId, Catalog>;
    gateways?: Record<HostId, ModelGateway>;
    mcpFetch?: typeof fetch;
    gitFetch?: typeof fetch;
  };
  options?: {
    // Names this server instance among those sharing the database.
    instanceId?: string;
    // Whether threads are named by a model; the stand-in model never names them.
    titles?: boolean;
    now?: () => Date;
    worker?: Partial<Omit<RunWorkerOptions, "calls" | "queue">>;
    toolsets?: Toolset[];
    // What live output's steps that wait on a commit go through, for tests that hold them back.
    liveAfterCommit?: (afterCommit: AfterCommit) => AfterCommit;
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
  const { db, transact, instanceId } = sync;
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
    scim: config.scimToken ? { token: config.scimToken } : null,
  });

  const connectionStore = createConnectionStore(db);
  // Sign-ins under way, for MCP servers and model providers alike.
  const attempts = createOAuthAttempts({ db, cipher });
  const connections = createConnections({
    attempts,
    instanceId,
    ticker: sync.ticker,
    transact,
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
  const hosts = createHostAdapters(fetch);
  // Connections are checked against the stand-in's lists when replies come from it, but for
  // servers people run, whose lists are read where they say.
  const models = createModels({
    connections: connectionStore,
    choices: createModelChoiceStore(db),
    spaces: spaceStore,
    tokens: connections,
    catalogs:
      ports.catalogs ?? (config.fakeModels ? createFakeCatalogs(hosts.catalogs) : hosts.catalogs),
    settings: settingStore,
    gateways: ports.gateways ?? hosts.gateways,
    signals: sync.signals,
    logger,
  });
  const runStore = createRunStore(db);
  const deltaStore = createDeltaStore(db);
  const signals = sync.signals;
  const log = createThreadLog({ threads: threadStore, signals, transact, ordered: sync.ordered });
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
  // The tools each system registers below, in the order of the model's tools.
  const tools = createTools({
    settings: toolSettings,
    policies: toolPolicyStore,
    directory,
    access,
    threadTools: createThreadToolStore(db),
  });
  const mcpServerStore = createMcpServerStore(db);
  const mcp = createMcpServers({
    attempts,
    instanceId,
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
  const transcripts = createTranscripts(threadStore, signals, hooks, sync.inTransaction);
  // Every input to a thread's agent goes in through the queue; execution decides in the same write
  // what it starts.
  const queue = createQueue({
    inTransaction: sync.inTransaction,
    store: createQueueStore(db),
    log,
    threads: threadStore,
    spaceStore,
    access,
    signals,
  });
  const watches = createWatchStore(db);
  const agentNameOf = async (spaceId: string) => {
    const space = await spaceStore.find(spaceId);
    return space ? await agentNameIn(settingStore, space) : DEFAULT_AGENT_NAME;
  };
  const live = createLive({
    store: createLiveStore(db),
    signals,
    transact,
    afterCommit: options.liveAfterCommit?.(sync.afterCommit) ?? sync.afterCommit,
    ordered: sync.ordered,
  });
  const callStore = createCallStore(db);
  const subagentStore = createSubagentStore(db);
  const calls = createCalls({
    store: callStore,
    retired: async (thread) =>
      thread.parentThreadId && (await subagentStore.find(thread.id))?.archivedAt
        ? "its subagent is archived."
        : null,
    threads: threadStore,
    spaceStore,
    log,
    signals,
    queue,
    logger,
    afterCommit: sync.afterCommit,
    tools,
    live,
    instanceId,
    keeper: sync.keeper,
    transact,
    claimDue: sync.claimDue,
  });
  const scheduleStore = createScheduleStore(db);
  // Timers and schedules, as one more instance on the database would tick them.
  const makeSchedules = () =>
    createSchedules({
      store: scheduleStore,
      queue,
      signals,
      sync,
      logger,
      ...(options.now && { now: options.now }),
    });
  const schedules = makeSchedules();
  const webhooks = createWebhooks({
    store: createWebhookStore(db, cipher),
    queue,
    signals,
    transact,
    baseUrl: config.baseUrl,
    ...(options.now && { now: options.now }),
  });
  // What setting a schedule or a webhook must pass, across both kinds.
  const setRule = createSetRule({ schedules, webhooks });
  // Previews need a browser, which servers without one go without.
  const artifacts = createArtifacts({
    store: createArtifactStore(db),
    signals,
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
  const usesServers: UseTest = (_space, { added }) => added.inSpace.length > 0;

  const runModels = opened("model", config.fakeModels ? fakeRunModels(models) : models);
  // The agent's runs: started, stopped and ended in one place, offered and told what the other
  // systems contribute, and held back where the subagents' limits say.
  const execution: Execution = createExecution({
    runs: runStore,
    calls,
    queue,
    threads: threadStore,
    transcripts,
    spaceStore,
    deltas: deltaStore,
    log,
    signals,
    transact,
    afterCommit: sync.afterCommit,
    instanceId,
    sync,
    models: runModels,
    tools,
    logger,
    traces: deps.traces,
    runsIn: async (space) => spaces.runsIn(space),
    hooks,
    ...(options.worker && { overrides: options.worker }),
  });
  const subagents = createSubagents({
    subagents: subagentStore,
    threads: threadStore,
    access,
    modelRef: async (orgId, ref) => models.canonicalRef(orgId, ref),
    transcripts,
    runs: runStore,
    log,
    signals,
    choosesModels: async (spaceId) => {
      const space = await spaceStore.find(spaceId);
      return !!space && (await tools.optionOn(space, SUBAGENTS_TOOLSET, CHOOSE_MODELS));
    },
    calls,
    ticker: sync.ticker,
    modelsIn: async (orgId) => (await models.resolveModels(orgId)).models,
    queue,
    stop: async (target, by, opts) => execution.stop(target, by, opts),
    watches,
  });
  const tasks = createTasks({
    tasks: createTaskStore(db),
    threads: threadStore,
    transcripts,
    access,
    orgOf: async (spaceId) => (await spaceStore.find(spaceId))?.orgId ?? null,
    subagents,
    log,
    signals,
    agentNameIn: agentNameOf,
    queue,
    watches,
  });
  // A subagent started with tasks is given them, and shares its starter's list.
  subagents.extend(tasks.extension);
  // Mage's own toolsets, in the order of the model's tools, then what orgs and spaces add.
  tools.register(createRichReplies());
  tools.register(
    createSystemTools({
      threads: threadStore,
      transcripts,
      spaceStore,
      guests: guestStore,
      models,
      // The model that replies, opened as the worker opens it.
      open: (orgId, ref) => runModels.open(orgId, ref),
    }),
  );
  tools.register(skills.toolset());
  tools.register(
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
  );
  tools.register(subagents.toolset());
  tools.register(calls.toolset());
  tools.register(tasks.toolset());
  tools.register(schedules.toolset(setRule));
  tools.register(webhooks.toolset(setRule));
  tools.register(artifacts.toolset());
  for (const toolset of options.toolsets ?? []) tools.register(toolset);
  tools.register({
    readIn: async (space) => mcp.readIn(space),
    forOrgSettings: async (orgId) => mcp.toolsetsForOrgSettings(orgId),
    forSpaceSettings: async (space) => mcp.toolsetsForSpaceSettings(space),
    named: async (toolId) => mcp.named(toolId),
  });
  // A subagent is offered all but what only its starter has.
  tools.narrow(async (thread, offered) => subagents.toolsOf(thread, offered));
  // A job's card shows on whichever call it is.
  tools.presenter(async (reader, rows) => calls.present(reader, rows));
  // What each system tells the thread's agent, in this order; subagents last, as they change what
  // the toolsets say for a subagent.
  execution.contribute({ guidance: async (space) => instructions.textsFor(space) });
  execution.contribute({
    guidance: async (_space, offered, _thread, now) => ({
      mcpServers: mcp.instructionsIn(now.sets, offered),
    }),
  });
  execution.contribute({
    guidance: async (_space, offered, _thread, now) => ({ skills: skills.listFor(offered, now) }),
  });
  execution.contribute({
    guidance: async (space) => ({ agentName: await agentNameIn(settingStore, space) }),
  });
  execution.contribute({
    guidance: async (space, _offered, _thread, now) => ({
      toolsets: await tools.guidanceIn(space, now),
    }),
  });
  execution.contribute({
    guidance: async (_space, _offered, thread, _now, so) =>
      subagents.guidance(thread, so.toolsets ?? []),
    before: async (thread) => subagents.before(thread),
  });
  execution.gate(async (threadId) => subagents.mayStart(threadId));
  execution.onEnded(async (run, next) => subagents.ended(run, next));
  execution.onEndKept(async (run) => subagents.endKept(run));
  const { worker } = execution;
  // A worker as another server process starts it, sharing these stores, under a name of its own.
  const makeWorker = (more: Partial<RunWorkerOptions> = {}, instance = ulid()) =>
    execution.makeWorker(more, instance);

  const orgs = createOrgs({
    directory,
    invites: createOrgInviteStore(db),
    spaces,
    spaceStore,
    threads: threadStore,
    settings: settingStore,
    hooks,
    baseUrl: config.baseUrl,
    teamOrgs: config.teamOrgs,
    operatorEmails: config.operatorEmails,
  });

  const titleModels = (options.titles ?? !config.fakeModels) && opened("title model", models);
  // Whether the thread is a retired subagent's, which nobody posts in.
  const retired = async (thread: Thread) =>
    !!thread.parentThreadId && !!(await subagents.find(thread.id))?.archivedAt;
  const commands = createCommands({
    skills,
    prompts: mcp,
    access,
    spaces,
    spaceStore,
    asides: true,
  });
  // A person's posts, after the subagents and commands whose rules they follow.
  const posts = createPosts({
    queue,
    access,
    log,
    threads: threadStore,
    compactable: async (threadId) => execution.compactable(threadId),
    retired,
    expand: async (space, userId, command, text) => commands.expand(space, userId, command, text),
    // The stand-in model answers every request alike, so it names no threads.
    ...(titleModels && {
      titles: createTitles({ models: titleModels, threads: threadStore, log, logger }),
    }),
  });
  const reads = createReads({ store: readStore, signals });
  // The author has seen what they posted.
  posts.onPosted(async (post) => reads.posted(post));
  const branches = createBranches({
    threads: threadStore,
    transcripts,
    access,
    log,
    queue,
    execution,
    models,
    tools,
    retired,
    signals,
  });
  const ask: ThreadAsk = (threadId, branchId, rowId) => worker.requestAt(threadId, branchId, rowId);
  const asides = createAsides({
    store: createAsideStore(db),
    access,
    transcripts,
    branches,
    ask,
  });
  const threads = createThreads({
    spaces,
    access,
    threads: threadStore,
    runs: runStore,
    models,
    log,
    signals,
    queue,
    posts,
    branches,
    transcripts,
    calls,
    ask,
  });
  // What readers are shown: built from the systems above, and read by routes alone.
  const needs = createNeeds({ calls });
  const activity = createActivity({
    threads: threadStore,
    transcripts,
    tools,
    needs,
    reads,
    subagents,
    tasks,
  });
  const views: Views = {
    reads,
    activity,
    lists: createLists({
      spaces,
      spaceStore,
      access,
      guests: guestStore,
      threads: threadStore,
      runs: runStore,
      models,
      signals,
      needs,
      reads,
      subagents,
    }),
    thread: createThreadViews({
      access,
      threads: threadStore,
      deltas: deltaStore,
      models,
      signals,
      queue,
      transcripts,
      branches,
      retired,
      needs,
      reads,
      activity,
      tools,
      subagents,
      tasks,
      live,
      ...(deps.traces && {
        runTrace: (runId: string) => deps.traces!.traceparent(runId),
      }),
    }),
  };

  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections,
    models,
    spaces,
    threads,
    views,
    queue,
    posts,
    branches,
    asides,
    commands,
    execution,
    subagents,
    access,
    tasks,
    schedules,
    webhooks,
    orgs,
    groups: createGroups({ directory }),
    calls,
    tools: createToolDecisions({
      tools,
      spaces,
      settings: toolSettings,
      policies: toolPolicyStore,
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
      signals,
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
        queue,
        calls,
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
    signals,
    worker,
    makeWorker,
    spaces,
    threads,
    views,
    posts,
    branches,
    asides,
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
    queue,
    calls,
    execution,
    transcripts,
    schedules,
    makeSchedules,
    scheduleStore,
    webhooks,
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
      await schedules.start();
      await subagents.start();
      // Device sign-ins are asked about on every instance, whoever reads where they stand.
      await connections.start();
      await sweep.start();
    },

    // Stops the background work and lets runs and background calls go, for recovery here or
    // elsewhere.
    async stop() {
      await schedules.stop();
      await subagents.stop();
      await connections.stop();
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

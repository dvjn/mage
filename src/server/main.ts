// Composition root: starts the server when run; when imported, only exports the app.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { loadChromiumPreviewer } from "@/server/artifacts/preview.ts";
import { CONTENT_PREFIX, createArtifacts } from "@/server/artifacts/service.ts";
import { createArtifactStore } from "@/server/artifacts/store.ts";
import { createSubagentStore } from "@/server/agent/subagent-store.ts";
import { createSubagents } from "@/server/agent/subagents.ts";
import { CHOOSE_MODELS, SUBAGENTS_TOOLSET } from "@/shared/subagents.ts";
import { createRichReplies } from "@/server/agent/rich-replies.ts";
import { createRunStore } from "@/server/agent/run-store.ts";
import { createRunWorker, type RunWorker } from "@/server/agent/runs.ts";
import { createSystemTools } from "@/server/agent/system-tools.ts";
import { createToolPolicies } from "@/server/agent/tool-policies.ts";
import { createToolPolicyStore } from "@/server/agent/tool-policy-store.ts";
import { createMcpTools, createToolSearch } from "@/server/agent/tool-search.ts";
import { createToolSettingStore } from "@/server/agent/tool-setting-store.ts";
import { createToolDecisions, createTools } from "@/server/agent/tools.ts";
import { createTransact, openDatabase, pingDatabase } from "@/server/db/db.ts";
import { createGuests } from "@/server/guests/service.ts";
import { createGuestStore } from "@/server/guests/store.ts";
import { createInstructions } from "@/server/instructions/service.ts";
import { createInstructionStore } from "@/server/instructions/store.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { loadConfig } from "@/server/kernel/config.ts";
import { createEventBus } from "@/server/kernel/event-bus.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { createLogger, createPrettyDestination } from "@/server/kernel/logger.ts";
import { createTraceRelay } from "@/server/kernel/trace-relay.ts";
import { createRunTraces } from "@/server/kernel/tracing.ts";
import { createMcpClient, mcpOAuthClientAt } from "@/server/mcp/client.ts";
import { createMcpServers } from "@/server/mcp/service.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/server/mcp/store.ts";
import { createModelChoiceStore } from "@/server/models/choice-store.ts";
import { createConnectionStore } from "@/server/models/connection-store.ts";
import { createConnections } from "@/server/models/connections.ts";
import { createCredentialStore } from "@/server/models/credential-store.ts";
import { createHostAdapters } from "@/server/models/hosts.ts";
import {
  createFakeCatalogs,
  createFakeGateway,
  FAKE_MODEL_REF,
} from "@/server/models/hosts/fake-gateway.ts";
import { createClaudeOAuth } from "@/server/models/hosts/anthropic-claude.ts";
import { createCodexOAuth } from "@/server/models/hosts/openai-codex.ts";
import { createModels, type Models } from "@/server/models/service.ts";
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
import { createThreadAccess } from "@/server/spaces/thread-access.ts";
import { createDeltaStore } from "@/server/threads/delta-store.ts";
import { createAsideStore } from "@/server/threads/asides.ts";
import { createThreadLog } from "@/server/threads/log.ts";
import { createThreadReadStore } from "@/server/threads/read-store.ts";
import { createThreads } from "@/server/threads/service.ts";
import { createCommands } from "@/server/threads/commands.ts";
import { createThreadStore } from "@/server/threads/store.ts";
import { createTitles } from "@/server/threads/titles.ts";

import { createApp } from "./app.ts";

const config = loadConfig();
const logger = createLogger(
  config.logFormat === "pretty" ? await createPrettyDestination() : undefined,
);

// Tracing starts before anything is traced, and its SDK is loaded only when it is on.
const tracing = config.tracing
  ? (await import("@/server/kernel/tracing-sdk.ts")).startTracing(config.tracing)
  : null;
const runTraces = config.tracing ? createRunTraces() : undefined;

const db = openDatabase(config.databasePath);
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

// CREDENTIAL_KEY is key version 1.
const cipher = createCipher({ version: 1, key: config.credentialKey });
const connectionStore = createConnectionStore(db);
const connections = createConnections({
  connections: connectionStore,
  credentials: createCredentialStore(db, cipher),
  providers: {
    codex: { label: "ChatGPT", oauth: createCodexOAuth(fetch) },
    claude: { label: "Claude", oauth: createClaudeOAuth(fetch) },
  },
  logger,
});
const hosts = createHostAdapters(fetch);
// Connections are checked against the stand-in's lists when replies come from it, but for servers
// people run, whose lists are read where they say.
const catalogs = config.fakeModels ? createFakeCatalogs(hosts.catalogs) : hosts.catalogs;
const spaceStore = createSpaceStore(db);
const threadStore = createThreadStore(db);
const directory = createDirectory(db, auth);
const settingStore = createOrgSettingStore(db);
const models = createModels({
  connections: connectionStore,
  choices: createModelChoiceStore(db),
  spaces: spaceStore,
  tokens: connections,
  catalogs,
  settings: settingStore,
  gateways: hosts.gateways,
  logger,
});
const runStore = createRunStore(db);
const deltas = createDeltaStore(db);
const bus = createEventBus();
const transact = createTransact(db);
const log = createThreadLog({ threads: threadStore, bus, transact });
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
const mcp = createMcpServers({
  servers: createMcpServerStore(db),
  credentials: createMcpCredentialStore(db, cipher),
  client: createMcpClient({
    fetch,
    oauth: mcpOAuthClientAt(config.baseUrl),
    version: "0.0.0",
  }),
  spaces,
  settings: settingStore,
  logger,
  hooks,
});
const instructions = createInstructions({ store: createInstructionStore(db), spaces });
const skills = createSkills({
  skills: createSkillStore(db, cipher),
  git: createGitReader(),
  archives: createZipReader(),
  spaces,
  settings: settingStore,
  logger,
});
const subagents = createSubagents({
  subagents: createSubagentStore(db),
  threads: threadStore,
  runs: runStore,
  log,
  bus,
  choosesModels: (spaceId) => {
    const space = spaceStore.find(spaceId);
    return !!space && tools.optionOn(space, SUBAGENTS_TOOLSET, CHOOSE_MODELS);
  },
  modelsIn: async (orgId) => (await models.resolveModels(orgId)).models,
});
// Previews need a browser, which servers without one go without.
const artifacts = createArtifacts({
  store: createArtifactStore(db),
  threads: threadStore,
  spaceStore,
  spaces,
  access,
  guests: guestStore,
  directory,
  appOrigin: new URL(config.baseUrl).origin,
  artifactOrigin: config.artifactOrigin,
  secret: config.authSecret,
  previewer: await loadChromiumPreviewer(),
});
const tools = createTools({
  toolsets: [
    createRichReplies(),
    createSystemTools({
      threads: threadStore,
      spaceStore,
      guests: guestStore,
      models,
      // The model that replies, opened as the worker opens it.
      open: (orgId, ref) => runModels.open(orgId, ref),
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

// The stand-in model answers every thread, whatever model it names.
const fakeGateway = createFakeGateway();
const fakeModel = { ref: FAKE_MODEL_REF, name: "echo", status: "ok" as const };
const runModels: Pick<Models, "open" | "replyModel"> = config.fakeModels
  ? {
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
    }
  : models;
const worker = createRunWorker({
  runs: runStore,
  threads: threadStore,
  spaceStore,
  access,
  deltas,
  log,
  bus,
  transact,
  models: runModels,
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
  logger,
  traces: runTraces,
  runsIn: (space) => spaces.runsIn(space),
  hooks,
});

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

// Aborted on a stop signal, which ends the live event streams.
const shutdown = new AbortController();

const app = createApp({
  handleAuth: auth.handler,
  identity: createIdentity(auth, db),
  connections,
  models,
  spaces,
  threads: createThreads({
    agentNameIn: (space) => agentNameIn(settingStore, space),
    spaces,
    spaceStore,
    access,
    guests: guestStore,
    threads: threadStore,
    reads: createThreadReadStore(db),
    runs: runStore,
    deltas,
    models,
    log,
    bus,
    tools,
    subagents,
    commands: createCommands({ skills, prompts: mcp }),
    ask: (threadId, branchId, rowId) => worker.requestAt(threadId, branchId, rowId),
    asides: createAsideStore(db),
    ...(runTraces && { runTrace: (runId: string) => runTraces.traceparent(runId) }),
    // The stand-in model answers every request alike, so it names no threads.
    ...(!config.fakeModels && {
      titles: createTitles({ models, threads: threadStore, log, logger }),
    }),
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
    bus,
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
  pingDatabase: () => pingDatabase(db),
  webRoot: import.meta.main ? config.webRoot : undefined,
  shutdown: shutdown.signal,
  ...(config.tracing && {
    traceRelay: createTraceRelay({
      url: config.tracing.tracesUrl,
      headers: config.tracing.headers,
    }),
  }),
});

// One listener answers both: a request for an artifact's origin goes to the content app alone, and
// the app never answers on that origin nor serves content paths on its own.
const routed = {
  fetch: (request: Request, ...rest: unknown[]) => {
    if (config.artifactOrigin === null) return app.fetch(request, ...(rest as []));
    if (artifacts.servesHost(request)) return artifacts.content(request);
    if (new URL(request.url).pathname.startsWith(CONTENT_PREFIX)) {
      return new Response("Not found", { status: 404 });
    }
    return app.fetch(request, ...(rest as []));
  },
};

export default routed;

// The development server imports this module rather than running it, and evaluates it again after
// each change; the agent worker runs there too, one at a time.
const developing = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
if (import.meta.main || developing) {
  const shared = globalThis as {
    agentWorker?: RunWorker;
    spaceSweep?: ReturnType<typeof setInterval>;
  };
  await shared.agentWorker?.stop();
  // Runs a stopped server left running are settled before anyone reads them.
  worker.recover();
  worker.start();
  shared.agentWorker = worker;
  // Spaces kept in trash or archived for too long are deleted on start and then every hour.
  const sweep = () => {
    try {
      const deleted = spaces.sweep();
      if (deleted > 0) logger.info({ deleted }, "deleted expired spaces");
    } catch (err) {
      logger.error({ err }, "could not delete expired spaces");
    }
  };
  clearInterval(shared.spaceSweep);
  sweep();
  shared.spaceSweep = setInterval(sweep, 60 * 60 * 1000).unref();
}

// Where each port has its own hostname and no wildcard exists, a second listener answers only the
// artifacts' content app, so pages live on an origin of their own whatever runs the app. The development server evaluates this module again after each change,
// so one listener stays and hands requests to the newest content app.
if ((import.meta.main || developing) && config.artifactPort !== null) {
  const shared = globalThis as {
    artifactServer?: Server;
    artifactContent?: (request: Request) => Promise<Response> | Response;
  };
  shared.artifactContent = (request) => artifacts.content(request);
  shared.artifactServer ??= serve(
    { fetch: (request) => shared.artifactContent!(request), port: config.artifactPort },
    (info) => logger.info({ port: info.port, origin: config.artifactOrigin }, "serving artifacts"),
  ) as Server;
}

if (import.meta.main) {
  const server = serve({ fetch: routed.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port, baseUrl: config.baseUrl }, "listening");
  }) as Server;
  // On a stop signal the server takes no new connections, ends the live event streams and stops
  // its runs; connections still open after a few seconds are cut.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "stopping");
      shutdown.abort();
      const closed = new Promise((resolve) => server.close(resolve));
      // Ended streams leave their connections idle.
      setImmediate(() => server.closeIdleConnections());
      setTimeout(() => server.closeAllConnections(), 3000).unref();
      // Spans not yet sent go out before the process ends.
      void Promise.all([worker.stop(), closed])
        .then(() => tracing?.shutdown().catch(() => {}))
        .then(() => process.exit(0));
    });
  }
}

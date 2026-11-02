// Composition root: starts the server when run; when imported, only exports the app.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";

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
import { createFolders } from "@/server/folders/service.ts";
import { createFolderStore } from "@/server/folders/store.ts";
import { createGuests } from "@/server/guests/service.ts";
import { createGuestStore } from "@/server/guests/store.ts";
import { createInstructions } from "@/server/instructions/service.ts";
import { createInstructionStore } from "@/server/instructions/store.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { loadConfig } from "@/server/kernel/config.ts";
import { createEventBus } from "@/server/kernel/event-bus.ts";
import { createHooks } from "@/server/kernel/hooks.ts";
import { createLogger, createPrettyDestination } from "@/server/kernel/logger.ts";
import { createMcpClient } from "@/server/mcp/client.ts";
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
import { createSpaces } from "@/server/spaces/service.ts";
import { createSpaceStore } from "@/server/spaces/store.ts";
import { createThreadAccess } from "@/server/spaces/thread-access.ts";
import { createDeltaStore } from "@/server/threads/delta-store.ts";
import { createThreadLog } from "@/server/threads/log.ts";
import { createThreadReadStore } from "@/server/threads/read-store.ts";
import { createThreads } from "@/server/threads/service.ts";
import { createThreadStore } from "@/server/threads/store.ts";
import { createTitles } from "@/server/threads/titles.ts";

import { createApp } from "./app.ts";

const config = loadConfig();
const logger = createLogger(
  config.logFormat === "pretty" ? await createPrettyDestination() : undefined,
);

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
const folderStore = createFolderStore(db);
const folders = createFolders({ spaces, folders: folderStore });
const guestStore = createGuestStore(db);
const access = createThreadAccess({ spaces, threads: threadStore, guests: guestStore });
const toolSettings = createToolSettingStore(db);
const toolPolicyStore = createToolPolicyStore(db);
const mcp = createMcpServers({
  servers: createMcpServerStore(db),
  credentials: createMcpCredentialStore(db, cipher),
  client: createMcpClient({
    fetch,
    oauth: { clientName: "Mage", redirectUrl: `${config.baseUrl}/api/mcp/oauth/callback` },
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
const tools = createTools({
  toolsets: [
    createRichReplies(),
    createSystemTools({
      threads: threadStore,
      spaceStore,
      folders: folderStore,
      guests: guestStore,
      models,
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
  ],
  scoped: {
    inSpace: (space) => mcp.toolsetsInSpace(space),
    forOrgSettings: (orgId) => mcp.toolsetsForOrgSettings(orgId),
    forSpaceSettings: (space) => mcp.toolsetsForSpaceSettings(space),
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
  guidance: (space, offered) => ({
    ...instructions.textsFor(space),
    mcpServers: mcp.instructionsIn(space, offered),
    skills: skills.listFor(space, offered),
    toolsets: tools.guidanceIn(space),
  }),
  logger,
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
  folders,
  threads: createThreads({
    spaces,
    spaceStore,
    access,
    guests: guestStore,
    folders,
    threads: threadStore,
    reads: createThreadReadStore(db),
    runs: runStore,
    deltas,
    models,
    log,
    bus,
    tools,
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
  guests: createGuests({
    access,
    guests: guestStore,
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
});

export default app;

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

if (import.meta.main) {
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
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
      void Promise.all([worker.stop(), closed]).then(() => process.exit(0));
    });
  }
}

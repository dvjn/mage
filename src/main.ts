// Composition root: starts the server when run; when imported, only exports the app.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { createDirectory } from "@/adapters/directory.ts";
import { createTransact, openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createDeltaStore } from "@/adapters/deltas.ts";
import { createEventBus } from "@/adapters/event-bus.ts";
import { createFakeCatalogs, createFakeGateway, FAKE_MODEL_REF } from "@/adapters/fake-gateway.ts";
import { createFolderStore } from "@/adapters/folders.ts";
import { createGuestStore } from "@/adapters/guests.ts";
import { createLogger, createPrettyDestination } from "@/adapters/logger.ts";
import { createMcpClient } from "@/adapters/mcp-client.ts";
import { createMcpCredentialStore, createMcpServerStore } from "@/adapters/mcp-servers.ts";
import { createModelChoiceStore } from "@/adapters/model-choices.ts";
import { createHostAdapters } from "@/adapters/hosts.ts";
import { createCodexOAuth } from "@/adapters/openai-codex.ts";
import { createOrgInviteStore } from "@/adapters/org-invites.ts";
import { createOrgSettingStore } from "@/adapters/org-settings.ts";
import { createRunStore } from "@/adapters/runs.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createThreadReadStore } from "@/adapters/thread-reads.ts";
import { createThreadStore } from "@/adapters/threads.ts";
import { createToolSettingStore } from "@/adapters/tool-settings.ts";
import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";
import { createConnections } from "@/services/connections.ts";
import { createFolders } from "@/services/folders.ts";
import { createGroups } from "@/services/groups.ts";
import { createGuests } from "@/services/guests.ts";
import { createMcpServers } from "@/services/mcp-servers.ts";
import { createModels, type Models } from "@/services/models.ts";
import { createOrgs } from "@/services/orgs.ts";
import { createRunWorker, dropRefusedWaiting, type RunWorker } from "@/services/runs.ts";
import { createSpaces } from "@/services/spaces.ts";
import { createSystemTools } from "@/services/system-tools.ts";
import { createThreadAccess } from "@/services/thread-access.ts";
import { createThreadLog } from "@/services/thread-log.ts";
import { createThreads } from "@/services/threads.ts";
import { createTitles } from "@/services/titles.ts";
import { createToolDecisions, createTools } from "@/services/tools.ts";

const config = loadConfig();
const logger = createLogger(
  config.logFormat === "pretty" ? await createPrettyDestination() : undefined,
);

const db = openDatabase(config.databasePath);
const auth = createAuth({
  db,
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
// When people may have lost a role in an org's spaces, their waiting messages there are dropped.
function accessChanged(orgId: string) {
  dropRefusedWaiting({ threads: threadStore, spaceStore, runs: runStore, access, log, orgId });
}
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
const access = createThreadAccess({ spaces, threads: threadStore, guests: guestStore });
const toolSettings = createToolSettingStore(db);
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
});
const tools = createTools({
  toolsets: [
    createSystemTools({
      threads: threadStore,
      spaceStore,
      folders: folderStore,
      guests: guestStore,
      models,
    }),
  ],
  scoped: {
    inOrg: (orgId) => mcp.toolsetsInOrg(orgId),
    inSpace: (space) => mcp.toolsetsInSpace(space),
  },
  settings: toolSettings,
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
  logger,
});

const orgs = createOrgs({
  directory,
  invites: createOrgInviteStore(db),
  spaces,
  spaceStore,
  threads: threadStore,
  runs: runStore,
  settings: settingStore,
  accessChanged,
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
    log,
    bus,
  }),
  mcp,
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
  const shared = globalThis as { agentWorker?: RunWorker };
  await shared.agentWorker?.stop();
  // Runs a stopped server left running are settled before anyone reads them.
  worker.recover();
  worker.start();
  shared.agentWorker = worker;
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

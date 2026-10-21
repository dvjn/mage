// Composition root: starts the server when run; when imported, only exports the app.

import { serve } from "@hono/node-server";

import {
  createClaudeCatalog,
  createClaudeGateway,
  createClaudeOAuth,
} from "@/adapters/anthropic-claude.ts";
import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { createTransact, openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createDeltaStore } from "@/adapters/deltas.ts";
import { createEventBus } from "@/adapters/event-bus.ts";
import { createFakeGateway, FAKE_MODEL_REF } from "@/adapters/fake-gateway.ts";
import { createFolderStore } from "@/adapters/folders.ts";
import { createLogger, createPrettyDestination } from "@/adapters/logger.ts";
import {
  createCodexCatalog,
  createCodexGateway,
  createCodexOAuth,
} from "@/adapters/openai-codex.ts";
import { createOrgSettingStore } from "@/adapters/org-settings.ts";
import { createRunStore } from "@/adapters/runs.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createThreadStore } from "@/adapters/threads.ts";
import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";
import { createConnections } from "@/services/connections.ts";
import { createFolders } from "@/services/folders.ts";
import { createModels, type Models } from "@/services/models.ts";
import { createRunWorker, type RunWorker } from "@/services/runs.ts";
import { createSpaces } from "@/services/spaces.ts";
import { createThreadLog } from "@/services/thread-log.ts";
import { createThreads } from "@/services/threads.ts";

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
});

// CREDENTIAL_KEY is key version 1.
const cipher = createCipher({ version: 1, key: config.credentialKey });
const codex = createCodexOAuth(fetch);
const connectionStore = createConnectionStore(db);
const connections = createConnections({
  connections: connectionStore,
  credentials: createCredentialStore(db, cipher),
  attempts: createSignInAttemptStore(db),
  providers: {
    codex: { provider: "openai", label: "Codex", browser: codex, device: codex },
    claude: { provider: "anthropic", label: "Claude", browser: createClaudeOAuth(fetch) },
  },
  logger,
});
const models = createModels({
  connections: connectionStore,
  tokens: connections,
  catalogs: { codex: createCodexCatalog(fetch), claude: createClaudeCatalog(fetch) },
  settings: createOrgSettingStore(db),
  gateways: { codex: createCodexGateway(fetch), claude: createClaudeGateway(fetch) },
  logger,
});
const threadStore = createThreadStore(db);
const spaceStore = createSpaceStore(db);
const runStore = createRunStore(db);
const deltas = createDeltaStore(db);
const bus = createEventBus();
const transact = createTransact(db);
const log = createThreadLog({ threads: threadStore, bus, transact });
const spaces = createSpaces({ spaces: spaceStore, threads: threadStore });
const folders = createFolders({ spaces, folders: createFolderStore(db) });

// The stand-in model answers every thread, whatever model it names.
const fakeGateway = createFakeGateway();
const runModels: Pick<Models, "defaultModel" | "open"> = config.fakeModels
  ? {
      defaultModel: (orgId) => models.defaultModel(orgId) ?? FAKE_MODEL_REF,
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
  spaces,
  deltas,
  log,
  bus,
  transact,
  models: runModels,
  logger,
});

const app = createApp({
  handleAuth: auth.handler,
  identity: createIdentity(auth, db),
  connections,
  models,
  spaces,
  folders,
  threads: createThreads({
    spaces,
    folders,
    threads: threadStore,
    runs: runStore,
    deltas,
    models,
    log,
    bus,
  }),
  logger,
  pingDatabase: () => pingDatabase(db),
  webRoot: import.meta.main ? config.webRoot : undefined,
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
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void worker.stop().then(() => server.close(() => process.exit(0)));
    });
  }
}

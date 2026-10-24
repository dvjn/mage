// Composition root: starts the server when run; when imported, only exports the app.

import { serve } from "@hono/node-server";

import { createAnthropicKeyCatalog, createAnthropicKeyGateway } from "@/adapters/anthropic-api.ts";
import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { createDirectory } from "@/adapters/directory.ts";
import { createTransact, openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createDeltaStore } from "@/adapters/deltas.ts";
import { createEventBus } from "@/adapters/event-bus.ts";
import { createFakeCatalog, createFakeGateway, FAKE_MODEL_REF } from "@/adapters/fake-gateway.ts";
import { createFolderStore } from "@/adapters/folders.ts";
import { createGuestStore } from "@/adapters/guests.ts";
import { createLogger, createPrettyDestination } from "@/adapters/logger.ts";
import { createModelChoiceStore } from "@/adapters/model-choices.ts";
import {
  createCodexCatalog,
  createCodexGateway,
  createCodexOAuth,
} from "@/adapters/openai-codex.ts";
import { createOpenAIKeyCatalog, createOpenAIKeyGateway } from "@/adapters/openai-api.ts";
import { createOrgInviteStore } from "@/adapters/org-invites.ts";
import { createOrgSettingStore } from "@/adapters/org-settings.ts";
import { createRunStore } from "@/adapters/runs.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createThreadStore } from "@/adapters/threads.ts";
import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";
import { createConnections } from "@/services/connections.ts";
import { createFolders } from "@/services/folders.ts";
import { createGroups } from "@/services/groups.ts";
import { createGuests } from "@/services/guests.ts";
import { createModels, type Models } from "@/services/models.ts";
import { createOrgs } from "@/services/orgs.ts";
import { createRunWorker, dropRefusedWaiting, type RunWorker } from "@/services/runs.ts";
import { createSpaces } from "@/services/spaces.ts";
import { createThreadAccess } from "@/services/thread-access.ts";
import { createThreadLog } from "@/services/thread-log.ts";
import { createThreads } from "@/services/threads.ts";
import { createTitles } from "@/services/titles.ts";

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
  passwordSignIn: config.passwordSignIn,
  operatorEmails: config.operatorEmails,
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
const codex = createCodexOAuth(fetch);
const connectionStore = createConnectionStore(db);
const connections = createConnections({
  connections: connectionStore,
  credentials: createCredentialStore(db, cipher),
  attempts: createSignInAttemptStore(db),
  providers: {
    codex: { provider: "openai", label: "Codex", browser: codex, device: codex },
  },
  logger,
});
// API keys are checked against the stand-in's list when replies come from it.
const keyCatalogs = config.fakeModels
  ? { openai: createFakeCatalog(), anthropic: createFakeCatalog() }
  : { openai: createOpenAIKeyCatalog(fetch), anthropic: createAnthropicKeyCatalog(fetch) };
const spaceStore = createSpaceStore(db);
const threadStore = createThreadStore(db);
const directory = createDirectory(db, auth);
const settingStore = createOrgSettingStore(db);
const models = createModels({
  connections: connectionStore,
  choices: createModelChoiceStore(db),
  spaces: spaceStore,
  tokens: connections,
  catalogs: {
    codex: createCodexCatalog(fetch),
    ...keyCatalogs,
  },
  settings: settingStore,
  gateways: {
    codex: createCodexGateway(fetch),
    openai: createOpenAIKeyGateway(fetch),
    anthropic: createAnthropicKeyGateway(fetch),
  },
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
const folders = createFolders({ spaces, folders: createFolderStore(db) });
const guestStore = createGuestStore(db);
const access = createThreadAccess({ spaces, threads: threadStore, guests: guestStore });

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
    runs: runStore,
    deltas,
    models,
    log,
    bus,
    // The stand-in model answers every request alike, so it names no threads.
    ...(!config.fakeModels && {
      titles: createTitles({ models, threads: threadStore, log, logger }),
    }),
  }),
  orgs,
  groups: createGroups({ directory }),
  guests: createGuests({
    access,
    guests: guestStore,
    threads: threadStore,
    transact,
    baseUrl: config.baseUrl,
  }),
  logger,
  signInOptions: {
    password: config.passwordSignIn,
    oidc: config.oidc && { name: config.oidc.name },
  },
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

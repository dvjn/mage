// Composition root: starts the server when run; when imported, only exports the app.

import { serve } from "@hono/node-server";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createCodexOAuth } from "@/adapters/openai-codex.ts";
import { createSignInAttemptStore } from "@/adapters/sign-in-attempts.ts";
import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";
import { createConnections } from "@/services/connections.ts";

const config = loadConfig();
const logger = createLogger();

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
const connections = createConnections({
  connections: createConnectionStore(db),
  credentials: createCredentialStore(db, cipher),
  attempts: createSignInAttemptStore(db),
  providers: { codex: { provider: "openai", label: "Codex", browser: codex, device: codex } },
  logger,
});

const app = createApp({
  handleAuth: auth.handler,
  identity: createIdentity(auth, db),
  connections,
  logger,
  pingDatabase: () => pingDatabase(db),
  webRoot: import.meta.main ? config.webRoot : undefined,
});

export default app;

if (import.meta.main) {
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port, baseUrl: config.baseUrl }, "listening");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

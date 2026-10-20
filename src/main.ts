// Composition root: starts the server when run; when imported, only exports the app.

import { serve } from "@hono/node-server";

import { openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";

const config = loadConfig();
const logger = createLogger();

const db = openDatabase(config.databasePath);

const app = createApp({
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

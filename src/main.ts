// Composition root: starts the server when run; when imported, only exports the app.

import { serve } from "@hono/node-server";

import { loadConfig } from "@/config.ts";
import { createApp } from "@/http/app.ts";

const config = loadConfig();

const app = createApp({ webRoot: import.meta.main ? config.webRoot : undefined });

export default app;

if (import.meta.main) {
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`mage: listening on :${info.port} (${config.baseUrl})`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

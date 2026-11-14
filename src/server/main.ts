// Server entry: loads the config, opens the database, builds the systems and serves them; when
// imported, only exports the app.

import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { loadChromiumPreviewer } from "@/server/artifacts/preview.ts";
import { CONTENT_PREFIX } from "@/server/artifacts/service.ts";
import type { ComposeDeps, Systems } from "@/server/compose.ts";
import { createCipher } from "@/server/kernel/cipher.ts";
import { loadConfig } from "@/server/kernel/config.ts";
import { createLogger, createPrettyDestination } from "@/server/kernel/logger.ts";
import { createTraceRelay } from "@/server/kernel/trace-relay.ts";
import { createRunTraces } from "@/server/kernel/tracing.ts";

const config = loadConfig();
const logger = createLogger(
  config.logFormat === "pretty" ? await createPrettyDestination() : undefined,
);

// Tracing starts before anything is traced, and its SDK is loaded only when it is on.
const tracing = config.tracing
  ? (await import("@/server/kernel/tracing-sdk.ts")).startTracing(config.tracing)
  : null;

// Loaded once tracing has started, so the database driver they load is traced.
const { openDatabase } = await import("@/server/db/db.ts");
const { compose } = await import("@/server/compose.ts");

const database = await openDatabase(config.databaseUrl);
const testRoutes: ComposeDeps["options"] = config.testing
  ? await import("@/server/testing/seed.ts").then(({ createSeed, seedRoutes }) => ({
      testRoutes: (deps) => seedRoutes(createSeed(deps)),
    }))
  : {};

// Aborted on a stop signal, which ends the live event streams.
const shutdown = new AbortController();

const systems = compose({
  database,
  config,
  // CREDENTIAL_KEY is key version 1.
  cipher: createCipher({ version: 1, key: config.credentialKey }),
  logger,
  fetch,
  // Previews need a browser, which servers without one go without.
  previewer: await loadChromiumPreviewer(),
  ...(config.tracing && {
    traces: createRunTraces(),
    traceRelay: createTraceRelay({
      url: config.tracing.tracesUrl,
      headers: config.tracing.headers,
    }),
  }),
  webRoot: import.meta.main ? config.webRoot : undefined,
  shutdown: shutdown.signal,
  options: testRoutes,
});
const { app, artifacts } = systems;

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
// each change; the background work runs there too, from the newest evaluation only.
const developing = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
if (import.meta.main || developing) {
  const shared = globalThis as { mage?: { systems: Systems; close: () => Promise<void> } };
  const previous = shared.mage;
  shared.mage = { systems, close: database.close };
  await previous?.systems.stop();
  await previous?.close();
  await systems.start();
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
  // its runs and background calls, letting them go for recovery; connections still open after a
  // few seconds are cut.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "stopping");
      shutdown.abort();
      const closed = new Promise((resolve) => server.close(resolve));
      // Ended streams leave their connections idle.
      setImmediate(() => server.closeIdleConnections());
      setTimeout(() => server.closeAllConnections(), 3000).unref();
      // Spans not yet sent go out before the process ends.
      void Promise.all([systems.stop(), closed])
        .then(() => tracing?.shutdown().catch(() => {}))
        .then(() => process.exit(0));
    });
  }
}

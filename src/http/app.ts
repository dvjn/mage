// API routes under /api and, in production, the built web client.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { validator } from "hono/validator";

import type { Connection } from "@/ports/connections.ts";
import type { Identity, Principal } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";
import { type AttemptStatus, ConnectionError, type Connections } from "@/services/connections.ts";
import {
  type AttemptSummary,
  browserFinishSchema,
  type ConnectionSummary,
} from "@/shared/connections.ts";
import type { Me } from "@/shared/me.ts";

export interface AppOptions {
  // Answers every request under /api/auth.
  handleAuth: (request: Request) => Promise<Response>;
  // Tells who is signed in for each request under /api/v1.
  identity: Identity;
  // The signed-in user's connections, including signing in to make one.
  connections: Connections;
  logger: Logger;
  // Reports whether the database answers a query.
  pingDatabase: () => Promise<boolean>;
  // Directory holding the built web client. Unset in dev, where Vite serves it.
  webRoot?: string;
}

export type App = Hono<{ Variables: RequestIdVariables }>;

type ApiEnv = { Variables: { principal: Principal | null } };

// Set for every route behind the signed-in check.
function signedIn(principal: Principal | null): Principal {
  if (!principal) throw new Error("route reached without a principal");
  return principal;
}

function summary(connection: Connection): ConnectionSummary {
  const { id, provider, authKind, account, createdAt } = connection;
  return { id, provider, authKind, account, createdAt: createdAt.toISOString() };
}

function attemptSummary(attempt: AttemptStatus): AttemptSummary {
  return attempt.status === "connected"
    ? { status: "connected", connection: summary(attempt.connection) }
    : attempt;
}

const browserFinish = validator("json", (value, c) => {
  const parsed = browserFinishSchema.safeParse(value);
  if (!parsed.success) return c.json({ error: "callbackUrl is required" }, 400);
  return parsed.data;
});

// The typed API routes, mounted under /api.
function createApi(options: AppOptions) {
  const { identity, connections } = options;
  return (
    new Hono<ApiEnv>()
      .use("/v1/*", async (c, next) => {
        c.set("principal", await identity.resolve(c.req.raw.headers));
        await next();
      })
      .get("/health", async (c) => {
        const database = await options.pingDatabase();
        return c.json({ ok: database, database }, database ? 200 : 503);
      })
      .get("/v1/me", async (c) => {
        const { principal } = c.var;
        if (!principal) return c.json({ error: "unauthorized" }, 401);
        return c.json((await identity.profile(principal)) satisfies Me, 200);
      })
      // Connections are for the owner of a personal org for now.
      .use("/v1/connections/*", async (c, next) => {
        const { principal } = c.var;
        if (!principal) return c.json({ error: "unauthorized" }, 401);
        const { org, role } = await identity.profile(principal);
        if (org.kind !== "personal" || role !== "owner") {
          return c.json({ error: "Only the owner of a personal org can manage connections" }, 403);
        }
        await next();
      })
      .get("/v1/connections", (c) => {
        const list = connections.list(signedIn(c.var.principal));
        return c.json(list.map(summary), 200);
      })
      .post("/v1/connections/codex/device", async (c) => {
        return c.json(await connections.startDevice("codex", signedIn(c.var.principal)), 200);
      })
      .post("/v1/connections/codex/browser", (c) => {
        return c.json(connections.startBrowser("codex", signedIn(c.var.principal)), 200);
      })
      .post("/v1/connections/codex/browser/finish", browserFinish, async (c) => {
        const owner = signedIn(c.var.principal);
        const connection = await connections.finishBrowser("codex", owner, c.req.valid("json"));
        return c.json(summary(connection), 200);
      })
      .get("/v1/connections/codex/attempts/:id", (c) => {
        const owner = signedIn(c.var.principal);
        return c.json(attemptSummary(connections.attempt("codex", owner, c.req.param("id"))), 200);
      })
      .post("/v1/connections/codex/attempts/:id/cancel", (c) => {
        connections.cancel("codex", signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/connections/:id", (c) => {
        connections.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}

export type Api = ReturnType<typeof createApi>;

export function createApp(options: AppOptions): App {
  const { logger } = options;
  const app: App = new Hono();

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    logger.info(
      {
        reqId: c.var.requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof ConnectionError) return c.json({ error: err.message }, err.status);
    logger.error({ reqId: c.var.requestId, err }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  app.route("/api", createApi(options));
  app.on(["GET", "POST"], "/api/auth/*", (c) => options.handleAuth(c.req.raw));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (options.webRoot) {
    const indexHtml = serveStatic({ root: options.webRoot, path: "index.html" });
    app.use("*", serveStatic({ root: options.webRoot }));
    // Extensionless paths are client routes; a missing file with an extension is a 404.
    app.get("*", async (c, next) =>
      /\.[^/]*$/.test(c.req.path) ? c.notFound() : indexHtml(c, next),
    );
  }

  return app;
}

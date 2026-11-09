// API routes under /api and, in production, the built web client. With tracing on, each request
// is traced, continuing the trace the browser sent, and the web client's own spans are passed on.

import { serveStatic } from "@hono/node-server/serve-static";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId, type RequestIdVariables } from "hono/request-id";

import { artifactRoutes } from "@/server/artifacts/routes.ts";
import type { Artifacts } from "@/server/artifacts/service.ts";
import { toolRoutes } from "@/server/agent/routes.ts";
import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import { guestRoutes } from "@/server/guests/routes.ts";
import type { Guests } from "@/server/guests/service.ts";
import { instructionRoutes } from "@/server/instructions/routes.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { TraceRelay } from "@/server/kernel/trace-relay.ts";
import { mcpRoutes } from "@/server/mcp/routes.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import { ConnectionError, type Connections } from "@/server/models/connections.ts";
import { modelRoutes } from "@/server/models/routes.ts";
import type { Models } from "@/server/models/service.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Identity } from "@/server/orgs/identity.ts";
import { orgRoutes } from "@/server/orgs/routes.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import { skillRoutes } from "@/server/skills/routes.ts";
import type { Skills } from "@/server/skills/service.ts";
import { spaceRoutes } from "@/server/spaces/routes.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import { threadRoutes } from "@/server/threads/routes.ts";
import type { Threads } from "@/server/threads/service.ts";
import { ORG_NOT_FOUND } from "@/shared/orgs.ts";
import type { SignInOptions } from "@/shared/sign-in.ts";

import type { ApiEnv } from "./http.ts";

export interface AppOptions {
  // Answers every request under /api/auth.
  handleAuth: (request: Request) => Promise<Response>;
  // Tells who is signed in for each request under /api/v1.
  identity: Identity;
  // The signed-in user's connections, including signing in to make one and their proxies.
  connections: Connections;
  // The models the org's connections unlock, its default model and its title model.
  models: Models;
  // The spaces the signed-in user can see in their org.
  spaces: Spaces;
  // Threads in those spaces and the ones shared with the user, and their events.
  threads: Threads;
  // Invite links to threads and the guests they let in.
  guests: Guests;
  // Decisions on the agent's tool calls, and what orgs and spaces set their tools to.
  tools: ToolDecisions;
  // The access policies orgs and spaces keep for their tools.
  toolPolicies: ToolPolicies;
  // The MCP servers orgs and spaces add, and authorizing Mage with them.
  mcp: McpServers;
  // The instructions orgs and spaces give the agent.
  instructions: Instructions;
  // The skills orgs and spaces give the agent.
  skills: Skills;
  // The pages the agent publishes, who views them, and their sharing.
  artifacts: Artifacts;
  // The orgs people are in, their members and invites, and creating team orgs.
  orgs: Orgs;
  // A team org's groups, as a directory brings them.
  groups: Groups;
  logger: Logger;
  // How often a live event stream sends a comment to keep the connection open, and checks the
  // reader may still read the thread.
  heartbeatMs?: number;
  // Aborted when the server stops, which ends the live event streams.
  shutdown?: AbortSignal;
  // The ways to sign in this server offers, for the sign-in page.
  signInOptions: SignInOptions;
  // Reports whether the database answers a query.
  pingDatabase: () => Promise<boolean>;
  // Directory holding the built web client. Unset in dev, where Vite serves it.
  webRoot?: string;
  // Where the web client's spans go; unset while tracing is off.
  traceRelay?: TraceRelay;
}

export type App = Hono<{ Variables: RequestIdVariables }>;

// Where the web client sends its spans, and the most one batch of them may weigh.
const WEB_TRACES = "/api/web/traces";
const WEB_TRACES_LIMIT = 2 * 1024 * 1024;

// The header that names the org a request acts in; `?org=` names it where headers cannot be sent.
export const ORG_HEADER = "X-Mage-Org";

// Routes about the person rather than one of their orgs, which work whichever org is named.
const PERSONAL_ROUTES = [
  "/v1/orgs",
  "/v1/org-invites/",
  "/v1/locate",
  "/v1/shared-threads",
  "/v1/invites/",
];

// The typed API routes, mounted under /api.
function createApi(options: AppOptions) {
  const { identity } = options;
  return new Hono<ApiEnv>()
    .get("/sign-in-options", (c) => c.json(options.signInOptions, 200))
    .use("/v1/*", async (c, next) => {
      const named = c.req.header(ORG_HEADER) ?? c.req.query("org") ?? null;
      let account = await identity.resolve(c.req.raw.headers, named);
      if (!account) return c.json({ error: "unauthorized" }, 401);
      if (!account.principal && named) {
        // An org the person is not in is not found, except on routes about the person.
        const personal = PERSONAL_ROUTES.some((route) => c.req.path.startsWith(`/api${route}`));
        if (!personal) return c.json({ error: ORG_NOT_FOUND }, 404);
        account = await identity.resolve(c.req.raw.headers, null);
        if (!account) return c.json({ error: "unauthorized" }, 401);
      }
      if (!account.principal) return c.json({ error: ORG_NOT_FOUND }, 404);
      c.set("account", account);
      c.set("principal", account.principal);
      await next();
    })
    .get("/health", async (c) => {
      const database = await options.pingDatabase();
      return c.json({ ok: database, database }, database ? 200 : 503);
    })
    .route("/", orgRoutes({ ...options, tracing: !!options.traceRelay }))
    .route("/", modelRoutes(options))
    .route("/", spaceRoutes(options))
    .route("/", threadRoutes(options))
    .route("/", guestRoutes(options))
    .route("/", toolRoutes(options))
    .route("/", mcpRoutes(options))
    .route("/", instructionRoutes(options))
    .route("/", skillRoutes(options))
    .route("/", artifactRoutes(options));
}

export type Api = ReturnType<typeof createApi>;

export function createApp(options: AppOptions): App {
  const { logger } = options;
  const app: App = new Hono();

  if (options.traceRelay) {
    const traced = httpInstrumentationMiddleware();
    // The web client's spans arrive as requests too, and are not traced themselves.
    app.use((c, next) => (c.req.path === WEB_TRACES ? next() : traced(c, next)));
  }
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
    if (err instanceof ServiceError) {
      return c.json({ error: err.message, ...(err.reason && { reason: err.reason }) }, err.status);
    }
    if (err instanceof ConnectionError) return c.json({ error: err.message }, err.status);
    logger.error({ reqId: c.var.requestId, err }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  app.route("/api", createApi(options));
  const relay = options.traceRelay;
  if (relay) {
    // Only from someone signed in.
    app.post(
      WEB_TRACES,
      async (c, next) => {
        const account = await options.identity.resolve(c.req.raw.headers, null);
        if (!account) return c.json({ error: "unauthorized" }, 401);
        await next();
      },
      bodyLimit({
        maxSize: WEB_TRACES_LIMIT,
        onError: (c) => c.json({ error: "Too many spans at once" }, 413),
      }),
      (c) => relay(c.req.raw),
    );
  }
  app.on(["GET", "POST"], "/api/auth/*", (c) => options.handleAuth(c.req.raw));
  // A SCIM directory also replaces, patches and deletes what it provisioned.
  app.on(["PUT", "PATCH", "DELETE"], "/api/auth/scim/v2/*", (c) => options.handleAuth(c.req.raw));
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

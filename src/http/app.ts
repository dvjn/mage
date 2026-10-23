// API routes under /api and, in production, the built web client.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { validator } from "hono/validator";
import type * as z from "zod";

import type { Connection } from "@/ports/connections.ts";
import type { Folder } from "@/ports/folders.ts";
import type { Space, SpaceRole } from "@/ports/spaces.ts";
import type { Identity, Principal } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";
import { type AttemptStatus, ConnectionError, type Connections } from "@/services/connections.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { ConnectionModel, Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { Threads } from "@/services/threads.ts";
import {
  apiKeyInputSchema,
  type AttemptSummary,
  browserFinishSchema,
  connectionLabelSchema,
  type ConnectionSummary,
  proxyInputSchema,
  type ProxySummary,
} from "@/shared/connections.ts";
import { type FolderSummary, folderNameSchema } from "@/shared/folders.ts";
import { acceptInviteSchema, newInviteSchema } from "@/shared/guests.ts";
import type { Me } from "@/shared/me.ts";
import {
  type ConnectionModels,
  connectionModelsChangeSchema,
  type DefaultEffort,
  defaultEffortSchema,
  type DefaultModel,
  type ModelListSummary,
  setDefaultModelSchema,
  setTitleModelSchema,
  type TitleModel,
} from "@/shared/models.ts";
import { spaceDefaultsSchema, type SpaceSummary, spaceNameSchema } from "@/shared/spaces.ts";
import {
  messageInputSchema,
  newThreadSchema,
  pendingChangeSchema,
  retrySchema,
  threadSearchSchema,
  threadUpdateSchema,
} from "@/shared/threads.ts";

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
  // The folders that arrange those spaces' threads.
  folders: Folders;
  // Threads in those spaces and the ones shared with the user, and their events.
  threads: Threads;
  // Invite links to threads and the guests they let in.
  guests: Guests;
  logger: Logger;
  // How often a live event stream sends a comment to keep the connection open, and checks the
  // reader may still read the thread.
  heartbeatMs?: number;
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

function summary(connection: Connection, proxy: ProxySummary | null = null): ConnectionSummary {
  const { id, provider, authKind, account, label, createdAt } = connection;
  return { id, provider, authKind, account, label, proxy, createdAt: createdAt.toISOString() };
}

function connectionModelsBody(list: {
  autoEnable: boolean;
  models: (ConnectionModel & { orgDefault: boolean })[];
  spacesUsingOff?: { id: string; name: string }[];
}): ConnectionModels {
  return {
    ...list,
    models: list.models.map(({ firstSeenAt, ...model }) => ({
      ...model,
      firstSeenAt: firstSeenAt.toISOString(),
    })),
  };
}

function spaceSummary(space: Space & { role: SpaceRole }): SpaceSummary {
  const { id, kind, name, primary, role, defaultModel, defaultEffort, createdAt } = space;
  return {
    id,
    kind,
    name,
    primary,
    role,
    defaultModel,
    defaultEffort,
    createdAt: createdAt.toISOString(),
  };
}

function folderSummary(folder: Folder): FolderSummary {
  const { id, spaceId, name, createdAt, updatedAt } = folder;
  return {
    id,
    spaceId,
    name,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
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

// A JSON body that must match the schema; otherwise 400 with the error given.
function jsonBody<T extends z.ZodType>(schema: T, error: string) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return c.json({ error }, 400);
    return parsed.data as z.output<T>;
  });
}

const setDefaultModel = jsonBody(setDefaultModelSchema, "ref is required");
const setTitleModel = jsonBody(setTitleModelSchema, "ref must be a model ref or null");
const spaceName = jsonBody(spaceNameSchema, "A name of 1 to 80 characters is required");
const setDefaultEffort = jsonBody(defaultEffortSchema, "effort is low, medium, high or null");
const spaceDefaults = jsonBody(
  spaceDefaultsSchema,
  "Give a model ref or null, or an effort of low, medium, high or null",
);
const newThread = jsonBody(
  newThreadSchema,
  "text must be a non-empty string, folderId an id, model a ref, effort low, medium or high",
);
const folderName = jsonBody(folderNameSchema, "A name of 1 to 80 characters is required");
const threadUpdate = jsonBody(threadUpdateSchema, "Give a title, a model or a folder");
const message = jsonBody(messageInputSchema, "text is required; mode is steer, queue or interrupt");
const pendingChange = jsonBody(pendingChangeSchema, "Give a text, or a mode of steer or queue");
const retry = jsonBody(retrySchema, "runId is required");
const newInvite = jsonBody(newInviteSchema, "accessFor is 1h, 1d, 7d or never");
const acceptInvite = jsonBody(acceptInviteSchema, "token is required");

// An API key body, refused with what is wrong with it.
// An API key body with its proxy, if any, every header given a value; refused with what is wrong.
const apiKeyInput = validator("json", (value, c) => {
  const parsed = apiKeyInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error = issue?.path[0] === "key" ? issue.message : "Give a provider, a label and a key";
    return c.json({ error }, 400);
  }
  const { proxy: rawProxy, ...input } = parsed.data;
  if (rawProxy === undefined || rawProxy === null) return { ...input, proxy: null };
  const proxy = proxyInputSchema.safeParse(rawProxy);
  if (!proxy.success) {
    const issue = proxy.error.issues[0];
    const error =
      issue?.path[0] === "baseUrl" ? "The base URL must be an http or https URL" : issue?.message;
    return c.json({ error: error ?? "Give a base URL and headers" }, 400);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(proxy.data.headers)) {
    if (headerValue === null) return c.json({ error: `Give a value for ${name}` }, 400);
    headers[name] = headerValue;
  }
  const empty = !proxy.data.baseUrl && Object.keys(headers).length === 0;
  return { ...input, proxy: empty ? null : { baseUrl: proxy.data.baseUrl, headers } };
});

const connectionModelsChange = jsonBody(
  connectionModelsChangeSchema,
  "Give autoEnable, or set with model ids and enabled",
);

const connectionLabel = jsonBody(connectionLabelSchema, "label must be at most 80 characters");

// A proxy body, refused with what is wrong with it.
const proxyInput = validator("json", (value, c) => {
  const parsed = proxyInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error =
      issue?.path[0] === "baseUrl" ? "The base URL must be an http or https URL" : issue?.message;
    return c.json({ error: error ?? "Give a base URL and headers" }, 400);
  }
  return parsed.data;
});

// `?q=` with the text to find in thread titles.
const threadSearch = validator("query", (value: { q?: string }, c) => {
  const parsed = threadSearchSchema.safeParse(value);
  if (!parsed.success) return c.json({ error: "q must be 1 to 200 characters" }, 400);
  return parsed.data;
});

// `?refresh=1` reads the lists again instead of from the cache.
const refreshQuery = validator("query", (value: { refresh?: string }) => ({
  refresh: value.refresh === "1",
}));

// Owners and admins change what applies to the whole org.
function requireAdmin(principal: Principal) {
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new ServiceError(403, "Only an owner or admin can change this");
  }
}

// Also how often a stream checks its reader may still read the thread.
const HEARTBEAT_MS = 15_000;

// Where a live event stream resumes: after the Last-Event-ID a reconnecting browser sends, or
// `?after=`, or from the start.
const eventCursor = validator("query", (value: { after?: string }, c) => {
  const raw = c.req.header("Last-Event-ID") ?? value.after ?? "0";
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) {
    return c.json({ error: "The cursor must be a seq" }, 400);
  }
  return { after };
});

// The typed API routes, mounted under /api.
function createApi(options: AppOptions) {
  const { identity, connections, models, spaces, folders, threads, guests } = options;
  return (
    new Hono<ApiEnv>()
      .use("/v1/*", async (c, next) => {
        const principal = await identity.resolve(c.req.raw.headers);
        if (!principal) return c.json({ error: "unauthorized" }, 401);
        c.set("principal", principal);
        await next();
      })
      .get("/health", async (c) => {
        const database = await options.pingDatabase();
        return c.json({ ok: database, database }, database ? 200 : 503);
      })
      .get("/v1/me", async (c) => {
        return c.json((await identity.profile(signedIn(c.var.principal))) satisfies Me, 200);
      })
      .get("/v1/models", refreshQuery, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const list = await models.resolveModels(orgId, c.req.valid("query"));
        return c.json(list satisfies ModelListSummary, 200);
      })
      .get("/v1/settings/default-model", (c) => {
        const ref = models.defaultModel(signedIn(c.var.principal).orgId);
        return c.json({ ref } satisfies DefaultModel, 200);
      })
      .put("/v1/settings/default-model", setDefaultModel, async (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { ref } = c.req.valid("json");
        await models.setDefaultModel(principal.orgId, ref);
        return c.json({ ref } satisfies DefaultModel, 200);
      })
      .get("/v1/settings/default-effort", (c) => {
        const effort = models.defaultEffort(signedIn(c.var.principal).orgId);
        return c.json({ effort } satisfies DefaultEffort, 200);
      })
      .put("/v1/settings/default-effort", setDefaultEffort, (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { effort } = c.req.valid("json");
        models.setDefaultEffort(principal.orgId, effort);
        return c.json({ effort } satisfies DefaultEffort, 200);
      })
      .get("/v1/settings/title-model", async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const ref = models.chosenTitleModel(orgId);
        const automatic = await models.automaticTitleModel(orgId);
        return c.json({ ref, automatic } satisfies TitleModel, 200);
      })
      .put("/v1/settings/title-model", setTitleModel, async (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { ref } = c.req.valid("json");
        await models.setTitleModel(principal.orgId, ref);
        const automatic = await models.automaticTitleModel(principal.orgId);
        return c.json({ ref, automatic } satisfies TitleModel, 200);
      })
      .get("/v1/spaces", (c) => {
        return c.json(spaces.list(signedIn(c.var.principal)).map(spaceSummary), 200);
      })
      .post("/v1/spaces", spaceName, (c) => {
        const space = spaces.create(signedIn(c.var.principal), c.req.valid("json").name);
        return c.json(spaceSummary(space), 200);
      })
      .patch("/v1/spaces/:id", spaceName, (c) => {
        const { name } = c.req.valid("json");
        const space = spaces.rename(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(spaceSummary(space), 200);
      })
      .patch("/v1/spaces/:id/defaults", spaceDefaults, async (c) => {
        const changes = c.req.valid("json");
        const space = await spaces.setDefaults(
          signedIn(c.var.principal),
          c.req.param("id"),
          changes,
        );
        return c.json(spaceSummary(space), 200);
      })
      .delete("/v1/spaces/:id", (c) => {
        spaces.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/spaces/:id/folders", (c) => {
        const list = folders.list(signedIn(c.var.principal), c.req.param("id"));
        return c.json(list.map(folderSummary), 200);
      })
      .post("/v1/spaces/:id/folders", folderName, (c) => {
        const { name } = c.req.valid("json");
        const folder = folders.create(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(folderSummary(folder), 200);
      })
      .patch("/v1/folders/:id", folderName, (c) => {
        const { name } = c.req.valid("json");
        const folder = folders.rename(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(folderSummary(folder), 200);
      })
      .delete("/v1/folders/:id", (c) => {
        folders.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/spaces/:id/threads", (c) => {
        return c.json(threads.list(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/spaces/:id/threads", newThread, async (c) => {
        const input = c.req.valid("json");
        const thread = await threads.create(signedIn(c.var.principal), c.req.param("id"), input);
        return c.json(thread, 200);
      })
      .get("/v1/shared-threads", (c) => {
        return c.json(threads.shared(signedIn(c.var.principal)), 200);
      })
      .post("/v1/invites/accept", acceptInvite, (c) => {
        const { token } = c.req.valid("json");
        return c.json(guests.accept(signedIn(c.var.principal), token), 200);
      })
      .get("/v1/threads/search", threadSearch, (c) => {
        const { q } = c.req.valid("query");
        return c.json(threads.search(signedIn(c.var.principal), q), 200);
      })
      .get("/v1/threads/:id", async (c) => {
        return c.json(await threads.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/threads/:id", threadUpdate, async (c) => {
        const changes = c.req.valid("json");
        const thread = await threads.update(signedIn(c.var.principal), c.req.param("id"), changes);
        return c.json(thread, 200);
      })
      .delete("/v1/threads/:id", (c) => {
        threads.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/threads/:id/events", eventCursor, (c) => {
        const principal = signedIn(c.var.principal);
        const id = c.req.param("id");
        // Answers 404 before the stream starts.
        threads.visible(principal, id);
        const { after } = c.req.valid("query");
        return streamSSE(c, async (stream) => {
          // One write at a time, in order.
          let writing = Promise.resolve();
          function write(send: () => Promise<void>) {
            writing = writing.then(send, send);
            return writing;
          }
          // Events carry their seq as the id a reconnecting browser resumes after; reply pieces
          // carry none, and are sent again from the start of each reply on reconnecting.
          const unsubscribe = threads.follow(principal, id, after, (item) => {
            void write(() =>
              item.kind === "event"
                ? stream.writeSSE({
                    id: String(item.event.seq),
                    event: "thread-event",
                    data: JSON.stringify(item.event),
                  })
                : stream.writeSSE({ event: "message-delta", data: JSON.stringify(item.delta) }),
            );
          });
          stream.onAbort(unsubscribe);
          while (!stream.aborted) {
            await stream.sleep(options.heartbeatMs ?? HEARTBEAT_MS);
            if (stream.aborted) break;
            // Whoever may no longer read the thread, as a guest whose access ended or a member who
            // left its space, is told so, and the stream ends.
            if (!threads.readable(principal, id)) {
              unsubscribe();
              await write(() => stream.writeSSE({ event: "access-ended", data: "{}" }));
              break;
            }
            await write(() => stream.write(": heartbeat\n\n").then(() => {}));
          }
        });
      })
      .post("/v1/threads/:id/messages", message, (c) => {
        const { text, mode } = c.req.valid("json");
        const principal = signedIn(c.var.principal);
        return c.json(threads.postMessage(principal, c.req.param("id"), text, mode), 202);
      })
      .patch("/v1/threads/:id/messages/:messageId", pendingChange, (c) => {
        const { id, messageId } = c.req.param();
        const change = c.req.valid("json");
        return c.json(threads.changeMessage(signedIn(c.var.principal), id, messageId, change), 200);
      })
      .delete("/v1/threads/:id/messages/:messageId", (c) => {
        const { id, messageId } = c.req.param();
        return c.json(threads.withdrawMessage(signedIn(c.var.principal), id, messageId), 200);
      })
      .post("/v1/threads/:id/stop", (c) => {
        threads.stop(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 202);
      })
      .post("/v1/threads/:id/retry", retry, (c) => {
        const { runId } = c.req.valid("json");
        return c.json(threads.retry(signedIn(c.var.principal), c.req.param("id"), runId), 202);
      })
      .post("/v1/threads/:id/invites", newInvite, (c) => {
        const { accessFor } = c.req.valid("json");
        return c.json(guests.invite(signedIn(c.var.principal), c.req.param("id"), accessFor), 200);
      })
      .get("/v1/threads/:id/people", (c) => {
        return c.json(guests.people(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .delete("/v1/threads/:id/invites/:inviteId", (c) => {
        const { id, inviteId } = c.req.param();
        guests.revokeInvite(signedIn(c.var.principal), id, inviteId);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/threads/:id/guests/:userId", (c) => {
        const { id, userId } = c.req.param();
        guests.revokeGuest(signedIn(c.var.principal), id, userId);
        return c.json({ ok: true }, 200);
      })
      // Connections are for the owner of a personal org for now.
      .use("/v1/connections/*", async (c, next) => {
        const { org, role } = await identity.profile(signedIn(c.var.principal));
        if (org.kind !== "personal" || role !== "owner") {
          return c.json({ error: "Only the owner of a personal org can manage connections" }, 403);
        }
        await next();
      })
      .get("/v1/connections", (c) => {
        const owner = signedIn(c.var.principal);
        const list = connections.list(owner);
        return c.json(
          list.map((connection) => summary(connection, connections.proxyOf(owner, connection.id))),
          200,
        );
      })
      .patch("/v1/connections/:id/proxy", proxyInput, (c) => {
        const owner = signedIn(c.var.principal);
        const id = c.req.param("id");
        connections.setProxy(owner, id, c.req.valid("json"));
        models.invalidate(id);
        const connection = connections.list(owner).find((found) => found.id === id);
        if (!connection) throw new ConnectionError(404, "Connection not found");
        return c.json(summary(connection, connections.proxyOf(owner, id)), 200);
      })
      .post("/v1/connections/api-keys", apiKeyInput, async (c) => {
        const owner = signedIn(c.var.principal);
        const connection = await models.addApiKey(owner, c.req.valid("json"));
        return c.json(summary(connection, connections.proxyOf(owner, connection.id)), 200);
      })
      .get("/v1/connections/:id/models", refreshQuery, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const list = await models.connectionModels(orgId, c.req.param("id"), c.req.valid("query"));
        return c.json(connectionModelsBody(list), 200);
      })
      .patch("/v1/connections/:id/models", connectionModelsChange, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const result = await models.setConnectionModels(
          orgId,
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json(connectionModelsBody(result), 200);
      })
      .patch("/v1/connections/:id/label", connectionLabel, (c) => {
        const owner = signedIn(c.var.principal);
        const { label } = c.req.valid("json");
        const connection = connections.rename(owner, c.req.param("id"), label);
        return c.json(summary(connection, connections.proxyOf(owner, connection.id)), 200);
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
      .post("/v1/connections/claude/browser", (c) => {
        return c.json(connections.startBrowser("claude", signedIn(c.var.principal)), 200);
      })
      .post("/v1/connections/claude/browser/finish", browserFinish, async (c) => {
        const owner = signedIn(c.var.principal);
        const connection = await connections.finishBrowser("claude", owner, c.req.valid("json"));
        return c.json(summary(connection), 200);
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
    if (err instanceof ServiceError) {
      return c.json({ error: err.message, ...(err.reason && { reason: err.reason }) }, err.status);
    }
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

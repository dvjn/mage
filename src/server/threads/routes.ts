import { setTimeout as sleep } from "node:timers/promises";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";

import { type ApiEnv, signedIn, jsonBody, queryOf } from "@/server/http.ts";
import { pageParams } from "@/shared/paging.ts";
import { threadPageQuerySchema } from "@/shared/thread-status.ts";
import {
  messageInputSchema,
  newThreadSchema,
  pendingChangeSchema,
  retrySchema,
  threadMoveSchema,
  threadReadSchema,
  threadUpdateSchema,
} from "@/shared/threads/requests.ts";
import { rowsQuerySchema } from "@/shared/threads/rows.ts";
import { threadSearchSchema } from "@/shared/threads/search.ts";

import type { Threads } from "./service.ts";

const newThread = jsonBody(
  newThreadSchema,
  "text must be a non-empty string, model a ref, effort low, medium or high",
);

const threadUpdate = jsonBody(threadUpdateSchema, "Give a title, a model or an effort");

const threadMove = jsonBody(threadMoveSchema, "Give a space");

const message = jsonBody(
  messageInputSchema,
  "text is required; mode is steer, queue or interrupt; command a name and args",
);

const pendingChange = jsonBody(pendingChangeSchema, "Give a text, or a mode of steer or queue");

const retry = jsonBody(retrySchema, "runId is required");

const threadRead = jsonBody(threadReadSchema, "seq is required");

const threadPageQuery = queryOf(threadPageQuerySchema);

// `?before=` with the place of the first row the page has, and `?limit=` with how many to read, or
// `?at=` with the id of a row the page reaches back to.
const rowsQuery = validator(
  "query",
  (value: { before?: string; limit?: string; at?: string }, c) => {
    const parsed = rowsQuerySchema.safeParse(value);
    if (!parsed.success) return c.json({ error: "before must be a place, limit at most 100" }, 400);
    return parsed.data;
  },
);

// `?q=` with the text to find in thread titles.
const threadSearch = validator("query", (value: { q?: string }, c) => {
  const parsed = threadSearchSchema.safeParse(value);
  if (!parsed.success) return c.json({ error: "q must be at most 200 characters" }, 400);
  return parsed.data;
});

// Also how often a stream checks its reader may still read the thread.
const HEARTBEAT_MS = 15_000;

// Waits until a stream's next heartbeat, or until the server stops.
function heartbeat({
  heartbeatMs = HEARTBEAT_MS,
  shutdown,
}: {
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  return sleep(heartbeatMs, undefined, { signal: shutdown }).catch(() => {});
}

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

export function threadRoutes(options: {
  threads: Threads;
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  const { threads } = options;
  return new Hono<ApiEnv>()
    .get("/v1/spaces/:id/threads", (c) => {
      return c.json(threads.list(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/spaces/:id/threads/sidebar", (c) => {
      return c.json(threads.sidebar(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/spaces/:id/threads/page", threadPageQuery, (c) => {
      const { show, ...query } = c.req.valid("query");
      const params = { ...pageParams(query), ...(show && { show }) };
      return c.json(threads.listPage(signedIn(c.var.principal), c.req.param("id"), params), 200);
    })
    .post("/v1/spaces/:id/threads", newThread, async (c) => {
      const input = c.req.valid("json");
      const thread = await threads.create(signedIn(c.var.principal), c.req.param("id"), input);
      return c.json(thread, 200);
    })
    .get("/v1/shared-threads", (c) => {
      return c.json(threads.shared(signedIn(c.var.principal)), 200);
    })
    .get("/v1/shared-threads/page", threadPageQuery, (c) => {
      const { show, ...query } = c.req.valid("query");
      const params = { ...pageParams(query), ...(show && { show }) };
      return c.json(threads.sharedPage(signedIn(c.var.principal), params), 200);
    })
    .get("/v1/threads/search", threadSearch, (c) => {
      const { q } = c.req.valid("query");
      return c.json(threads.search(signedIn(c.var.principal), q), 200);
    })
    .get("/v1/threads/:id", async (c) => {
      return c.json(await threads.get(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/threads/:id/rows", rowsQuery, (c) => {
      const { before, limit, at } = c.req.valid("query");
      const principal = signedIn(c.var.principal);
      return c.json(threads.rows(principal, c.req.param("id"), before, limit, at), 200);
    })
    .patch("/v1/threads/:id", threadUpdate, async (c) => {
      const changes = c.req.valid("json");
      const thread = await threads.update(signedIn(c.var.principal), c.req.param("id"), changes);
      return c.json(thread, 200);
    })
    .post("/v1/threads/:id/move", threadMove, (c) => {
      const { spaceId } = c.req.valid("json");
      return c.json(threads.move(signedIn(c.var.principal), c.req.param("id"), spaceId), 200);
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
        // Rows carry the seq of the newest event they reach as the id a reconnecting browser
        // resumes after; reply pieces carry none, and are sent again from the start of each reply
        // on reconnecting.
        const unsubscribe = threads.follow(principal, id, after, (item) => {
          void write(() =>
            item.kind === "rows"
              ? stream.writeSSE({
                  id: String(item.update.seq),
                  event: "rows",
                  data: JSON.stringify(item.update),
                })
              : item.kind === "thread"
                ? stream.writeSSE({ event: "thread", data: JSON.stringify(item.head) })
                : stream.writeSSE({ event: "message-delta", data: JSON.stringify(item.delta) }),
          );
        });
        stream.onAbort(unsubscribe);
        while (!stream.aborted && !options.shutdown?.aborted) {
          await heartbeat(options);
          if (stream.aborted || options.shutdown?.aborted) break;
          // Whoever may no longer read the thread, as a guest whose access ended or a member who
          // left its space, is told so, and the stream ends.
          if (!threads.readable(principal, id)) {
            unsubscribe();
            await write(() => stream.writeSSE({ event: "access-ended", data: "{}" }));
            break;
          }
          await write(() => stream.write(": heartbeat\n\n").then(() => {}));
        }
        // The server is stopping.
        if (!stream.aborted && options.shutdown?.aborted) unsubscribe();
      });
    })
    .put("/v1/threads/:id/read", threadRead, (c) => {
      const { seq } = c.req.valid("json");
      return c.json(threads.markRead(signedIn(c.var.principal), c.req.param("id"), seq), 200);
    })
    .get("/v1/inbox/events", (c) => {
      const principal = signedIn(c.var.principal);
      return streamSSE(c, async (stream) => {
        // One write at a time, in order.
        let writing = Promise.resolve();
        function write(send: () => Promise<void>) {
          writing = writing.then(send, send);
          return writing;
        }
        const inbox = threads.inbox(principal, (item) => {
          void write(() =>
            item.kind === "thread"
              ? stream.writeSSE({
                  event: "thread",
                  data: JSON.stringify({ thread: item.thread, shared: item.shared }),
                })
              : item.kind === "read"
                ? stream.writeSSE({
                    event: "thread-read",
                    data: JSON.stringify({ threadId: item.threadId, seq: item.seq }),
                  })
                : stream.writeSSE({
                    event: "thread-gone",
                    data: JSON.stringify({ threadId: item.threadId }),
                  }),
          );
        });
        stream.onAbort(() => inbox.stop());
        while (!stream.aborted && !options.shutdown?.aborted) {
          await heartbeat(options);
          if (stream.aborted || options.shutdown?.aborted) break;
          // Threads the reader can no longer read, as a guest whose access ended, are gone.
          inbox.recheck();
          await write(() => stream.write(": heartbeat\n\n").then(() => {}));
        }
        inbox.stop();
      });
    })
    .get("/v1/threads/:id/commands", (c) => {
      return c.json(threads.commands(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/threads/:id/messages", message, async (c) => {
      const { text, mode, command } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const id = c.req.param("id");
      const posted = command
        ? await threads.postCommand(principal, id, text, mode, command)
        : threads.postMessage(principal, id, text, mode);
      return c.json(posted, 202);
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
    .post("/v1/threads/:id/unarchive", (c) => {
      threads.unarchive(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/retry", retry, (c) => {
      const { runId } = c.req.valid("json");
      return c.json(threads.retry(signedIn(c.var.principal), c.req.param("id"), runId), 202);
    });
}

// What a reader is shown, as routes: thread lists, the sidebar, search and the shared threads; a
// thread with its rows and its tray; the live streams of a thread and of the reader's lists; and
// how far the reader has seen a thread.

import { setTimeout as sleep } from "node:timers/promises";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validator } from "hono/validator";

import type { ThreadAccess } from "@/server/access/access.ts";
import { type ApiEnv, jsonBody, queryOf, signedIn } from "@/server/http.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { activitySeenSchema } from "@/shared/jobs.ts";
import { pageParams } from "@/shared/paging.ts";
import type { STREAMS } from "@/shared/streams.ts";
import { threadPageQuerySchema } from "@/shared/thread-status.ts";
import { threadReadSchema } from "@/shared/threads/requests.ts";
import { rowsQuerySchema } from "@/shared/threads/rows.ts";
import { threadSearchSchema } from "@/shared/threads/search.ts";

import type { Activity } from "./activity.ts";
import type { Lists } from "./lists.ts";
import type { Reads } from "./reads.ts";
import type { ThreadFollowItem, ThreadViews } from "./thread.ts";

// The read models routes serve.
export interface Views {
  thread: ThreadViews;
  lists: Lists;
  activity: Activity;
  reads: Reads;
}

// A followed thread's item as the message the stream sends. Every kind is handled, so a new one
// fails to compile until it is.
export function feedMessage(item: ThreadFollowItem): {
  id?: string;
  event: keyof typeof STREAMS.thread.events;
  data: string;
} {
  switch (item.kind) {
    case "rows":
      return {
        id: String(item.update.seq),
        event: "rows",
        data: JSON.stringify(item.update),
      };
    case "thread":
      return { event: "thread", data: JSON.stringify(item.head) };
    case "tasks":
      return { event: "tasks", data: JSON.stringify(item.list) };
    case "activity":
      return { event: "activity", data: JSON.stringify(item.list) };
    case "delta":
      return { event: "message-delta", data: JSON.stringify(item.delta) };
    case "live":
      return { event: "tool-output", data: JSON.stringify(item.live) };
    default: {
      const unknown: never = item;
      throw new Error(`unhandled thread feed item: ${JSON.stringify(unknown)}`);
    }
  }
}

const seenInput = jsonBody(activitySeenSchema, "Give a kind");

// `?branch=` with the id of the thread's branch to read, its current one when not given.
const branchQuery = validator("query", (value: { branch?: string }) => ({
  branch: value.branch || undefined,
}));

const threadRead = jsonBody(threadReadSchema, "seq is required");

const threadPageQuery = queryOf(threadPageQuerySchema);

// `?before=` with the place of the first row the page has, and `?limit=` with how many to read, or
// `?at=` with the id of a row the page reaches back to.
const rowsQuery = validator(
  "query",
  (
    value: { before?: string; limit?: string; at?: string; branch?: string; unreadFrom?: string },
    c,
  ) => {
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

// Also how often a stream reads its thread again without a hint.
const HEARTBEAT_MS = 15_000;
// Every how many beats a stream reads everything it shows again, not only the rows.
const FULL_EVERY = 4;

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

export function viewRoutes(options: {
  views?: Views;
  access?: Pick<ThreadAccess, "require">;
  logger?: Logger;
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  const { views, access } = options;

  return (
    new Hono<ApiEnv>()
      .get("/v1/spaces/:id/threads", async (c) => {
        return c.json(
          await views!.lists.inSpace(signedIn(c.var.principal), c.req.param("id")),
          200,
        );
      })
      .get("/v1/spaces/:id/threads/sidebar", async (c) => {
        return c.json(
          await views!.lists.sidebar(signedIn(c.var.principal), c.req.param("id")),
          200,
        );
      })
      .get("/v1/spaces/:id/threads/page", threadPageQuery, async (c) => {
        const { show, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(show && { show }) };
        return c.json(
          await views!.lists.page(signedIn(c.var.principal), c.req.param("id"), params),
          200,
        );
      })
      .get("/v1/shared-threads", async (c) => {
        return c.json(await views!.lists.shared(signedIn(c.var.principal)), 200);
      })
      .get("/v1/shared-threads/page", threadPageQuery, async (c) => {
        const { show, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(show && { show }) };
        return c.json(await views!.lists.sharedPage(signedIn(c.var.principal), params), 200);
      })
      .get("/v1/threads/search", threadSearch, async (c) => {
        const { q } = c.req.valid("query");
        return c.json(await views!.lists.search(signedIn(c.var.principal), q), 200);
      })
      // Before a thread's own routes, whose id would take the word.
      .get("/v1/threads/feed", (c) => {
        const principal = signedIn(c.var.principal);
        return streamSSE(c, async (stream) => {
          // One write at a time, in order.
          let writing = Promise.resolve();
          function write(send: () => Promise<void>) {
            writing = writing.then(send, send);
            return writing;
          }
          const feed = await views!.lists.feed(principal, (item) => {
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
          stream.onAbort(() => feed.stop());
          while (!stream.aborted && !options.shutdown?.aborted) {
            await heartbeat(options);
            if (stream.aborted || options.shutdown?.aborted) break;
            // Threads the reader can no longer read, as a guest whose access ended, are gone.
            await feed.recheck();
            await write(() => stream.write(": heartbeat\n\n").then(() => {}));
          }
          feed.stop();
        });
      })
      .get("/v1/threads/:id", branchQuery, async (c) => {
        const { branch } = c.req.valid("query");
        const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"));
        return c.json(await views!.thread.detail(reader, branch), 200);
      })
      .get("/v1/threads/:id/rows", rowsQuery, async (c) => {
        const { before, limit, at, branch, unreadFrom } = c.req.valid("query");
        const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"));
        const page = { before, limit, at, branchId: branch, unreadFrom };
        return c.json(await views!.thread.rows(reader, page), 200);
      })
      .get("/v1/threads/:id/activity", async (c) => {
        const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"));
        return c.json(await views!.activity.of(reader), 200);
      })
      .post("/v1/threads/:id/activity/seen", seenInput, async (c) => {
        const { kind } = c.req.valid("json");
        const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"));
        return c.json(await views!.activity.seen(reader, kind), 200);
      })
      .get("/v1/threads/:id/events", eventCursor, async (c) => {
        const principal = signedIn(c.var.principal);
        const id = c.req.param("id");
        // Answers 404 before the stream starts.
        await access!.require(principal, id);
        const { after } = c.req.valid("query");
        return streamSSE(c, async (stream) => {
          // One write at a time, in order.
          let writing = Promise.resolve();
          // A write that fails is dropped, so that one bad item cannot take the server down.
          function write(send: () => Promise<void>) {
            writing = writing.then(send, send).catch((err: unknown) => {
              options.logger?.error({ err, threadId: id }, "thread event stream write failed");
            });
            return writing;
          }
          // Rows carry the seq of the newest event they reach as the id a reconnecting browser
          // resumes after; reply pieces carry none, and are sent again from the start of each reply
          // on reconnecting.
          const ended = () => write(() => stream.writeSSE({ event: "access-ended", data: "{}" }));
          // Ends the stream once a delivery's reader may no longer read the thread.
          const over = new AbortController();
          // The reader may have lost the thread since the request was answered.
          const followed = await views!.thread
            .follow(principal, id, after, (item) => {
              if (item === "ended") {
                void ended();
                over.abort();
                return;
              }
              void write(() => stream.writeSSE(feedMessage(item)));
            })
            .catch((err: unknown) => {
              if (err instanceof ServiceError) return null;
              throw err;
            });
          if (!followed) {
            await ended();
            return;
          }
          stream.onAbort(() => followed.stop());
          // The reader may have gone while what was stored was read for them.
          if (stream.aborted) followed.stop();
          const stopping = options.shutdown ? [options.shutdown, over.signal] : [over.signal];
          let beats = 0;
          try {
            while (!stream.aborted && !options.shutdown?.aborted && !over.signal.aborted) {
              await heartbeat({ ...options, shutdown: AbortSignal.any(stopping) });
              if (stream.aborted || options.shutdown?.aborted || over.signal.aborted) break;
              // Read again without a hint, as a hint may be lost: the rows every beat, the rest
              // every fourth. Whoever may no longer read the thread, as a guest whose access ended
              // or a member who left its space, is told so, and the stream ends.
              beats += 1;
              await followed.recheck(beats % FULL_EVERY === 0);
              if (over.signal.aborted) break;
              await write(() => stream.write(": heartbeat\n\n").then(() => {}));
            }
          } catch (err) {
            // A read that failed, as of a database that went away, closes the stream untold, so
            // the browser connects again and resumes from the last rows it was sent.
            followed.stop();
            options.logger?.error({ err, threadId: id }, "thread event stream read failed");
          }
          await writing;
          // The server is stopping.
          if (!stream.aborted && options.shutdown?.aborted) followed.stop();
        });
      })
      .put("/v1/threads/:id/read", threadRead, async (c) => {
        const { seq } = c.req.valid("json");
        const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"));
        return c.json(await views!.reads.mark(reader, seq), 200);
      })
  );
}

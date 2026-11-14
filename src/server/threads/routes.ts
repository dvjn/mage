import { setTimeout as sleep } from "node:timers/promises";

import { type Context, Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { validator } from "hono/validator";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { type ApiEnv, signedIn, jsonBody, queryOf } from "@/server/http.ts";
import { backgroundSeenSchema } from "@/shared/calls.ts";
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
import {
  asideFollowUpSchema,
  type AsideStreamItem,
  branchActionSchema,
  forkSchema,
  newAsideSchema,
} from "@/shared/threads/history.ts";
import { rowsQuerySchema } from "@/shared/threads/rows.ts";
import { threadSearchSchema } from "@/shared/threads/search.ts";
import type { STREAMS } from "@/shared/streams.ts";

import type { Asking, ThreadFollowItem, Threads } from "./service.ts";

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
    case "background":
      return { event: "background", data: JSON.stringify(item.list) };
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

const newThread = jsonBody(
  newThreadSchema,
  "text must be a non-empty string, model a ref, effort low, medium or high, command a name and args",
);

const threadUpdate = jsonBody(threadUpdateSchema, "Give a title, a model or an effort");

const seenInput = jsonBody(backgroundSeenSchema, "Give a kind");
const threadMove = jsonBody(threadMoveSchema, "Give a space");

const message = jsonBody(
  messageInputSchema,
  "text is required; mode is steer, queue or interrupt; command a name and args",
);

const pendingChange = jsonBody(pendingChangeSchema, "Give a text, or a mode of steer or queue");

const retry = jsonBody(retrySchema, "runId is required");

const branchAction = jsonBody(
  branchActionSchema,
  "action is retry, edit or restore, with a rowId; edit takes a text, retry a model",
);

const fork = jsonBody(forkSchema, "rowId is required");

const newAside = jsonBody(newAsideSchema, "rowId and text are required");

const asideFollowUp = jsonBody(asideFollowUpSchema, "text is required");

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

// The side question as asked, then each piece of its answer as it is written, then the side
// question answered, as JSON lines. The answer stops once the asker goes or the server stops.
function answering(c: Context, asking: Asking, shutdown?: AbortSignal) {
  c.header("Content-Type", "application/x-ndjson");
  return stream(c, async (out) => {
    const gone = new AbortController();
    out.onAbort(() => gone.abort());
    const signal = shutdown ? AbortSignal.any([gone.signal, shutdown]) : gone.signal;
    // One write at a time, in order.
    let writing = Promise.resolve();
    const send = (item: AsideStreamItem) => {
      writing = writing
        .then(() => out.write(`${JSON.stringify(item)}\n`))
        .then(
          () => {},
          () => {},
        );
      return writing;
    };
    void send({ type: "aside", aside: asking.aside });
    const answered = await asking.answer((text) => void send({ type: "delta", text }), signal);
    await send({ type: "aside", aside: answered });
  });
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
  logger?: Logger;
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  const { threads } = options;
  return new Hono<ApiEnv>()
    .get("/v1/spaces/:id/threads", async (c) => {
      return c.json(await threads.list(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/spaces/:id/threads/sidebar", async (c) => {
      return c.json(await threads.sidebar(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/spaces/:id/threads/page", threadPageQuery, async (c) => {
      const { show, ...query } = c.req.valid("query");
      const params = { ...pageParams(query), ...(show && { show }) };
      return c.json(
        await threads.listPage(signedIn(c.var.principal), c.req.param("id"), params),
        200,
      );
    })
    .post("/v1/spaces/:id/threads", newThread, async (c) => {
      const input = c.req.valid("json");
      const thread = await threads.create(signedIn(c.var.principal), c.req.param("id"), input);
      return c.json(thread, 200);
    })
    .get("/v1/spaces/:id/commands", async (c) => {
      return c.json(await threads.spaceCommands(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/shared-threads", async (c) => {
      return c.json(await threads.shared(signedIn(c.var.principal)), 200);
    })
    .get("/v1/shared-threads/page", threadPageQuery, async (c) => {
      const { show, ...query } = c.req.valid("query");
      const params = { ...pageParams(query), ...(show && { show }) };
      return c.json(await threads.sharedPage(signedIn(c.var.principal), params), 200);
    })
    .get("/v1/threads/search", threadSearch, async (c) => {
      const { q } = c.req.valid("query");
      return c.json(await threads.search(signedIn(c.var.principal), q), 200);
    })
    .get("/v1/threads/:id", branchQuery, async (c) => {
      const { branch } = c.req.valid("query");
      return c.json(await threads.get(signedIn(c.var.principal), c.req.param("id"), branch), 200);
    })
    .get("/v1/threads/:id/rows", rowsQuery, async (c) => {
      const { before, limit, at, branch, unreadFrom } = c.req.valid("query");
      const principal = signedIn(c.var.principal);
      return c.json(
        await threads.rows(principal, c.req.param("id"), before, limit, at, branch, unreadFrom),
        200,
      );
    })
    .get("/v1/tool-results/:id", async (c) => {
      return c.json(await threads.result(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/threads/:id/rows/:rowId/branch", async (c) => {
      const { id, rowId } = c.req.param();
      return c.json(await threads.branchOf(signedIn(c.var.principal), id, rowId), 200);
    })
    .post("/v1/threads/:id/history", branchAction, async (c) => {
      const action = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      return c.json(await threads.act(principal, c.req.param("id"), action), 200);
    })
    .post("/v1/threads/:id/fork", fork, async (c) => {
      const input = c.req.valid("json");
      return c.json(await threads.fork(signedIn(c.var.principal), c.req.param("id"), input), 200);
    })
    .get("/v1/threads/:id/asides", async (c) => {
      return c.json(await threads.asides(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/threads/:id/asides", newAside, async (c) => {
      const input = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const asking = await threads.askAside(principal, c.req.param("id"), input);
      return answering(c, asking, options.shutdown);
    })
    .post("/v1/threads/:id/asides/:asideId/messages", asideFollowUp, async (c) => {
      const { id, asideId } = c.req.param();
      const { text } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const asking = await threads.followUpAside(principal, id, asideId, text);
      return answering(c, asking, options.shutdown);
    })
    .post("/v1/threads/:id/asides/:asideId/stop", async (c) => {
      const { id, asideId } = c.req.param();
      await threads.stopAside(signedIn(c.var.principal), id, asideId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/summary-thread", fork, async (c) => {
      const principal = signedIn(c.var.principal);
      const input = c.req.valid("json");
      return c.json(await threads.fromSummary(principal, c.req.param("id"), input), 200);
    })
    .patch("/v1/threads/:id", threadUpdate, async (c) => {
      const changes = c.req.valid("json");
      const thread = await threads.update(signedIn(c.var.principal), c.req.param("id"), changes);
      return c.json(thread, 200);
    })
    .post("/v1/threads/:id/move", threadMove, async (c) => {
      const { spaceId } = c.req.valid("json");
      return c.json(await threads.move(signedIn(c.var.principal), c.req.param("id"), spaceId), 200);
    })
    .delete("/v1/threads/:id", async (c) => {
      await threads.remove(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 200);
    })
    .get("/v1/threads/:id/background", async (c) => {
      return c.json(
        await threads.backgroundList(signedIn(c.var.principal), c.req.param("id")),
        200,
      );
    })
    .post("/v1/threads/:id/background/seen", seenInput, async (c) => {
      const { kind } = c.req.valid("json");
      return c.json(
        await threads.seeBackground(signedIn(c.var.principal), c.req.param("id"), kind),
        200,
      );
    })
    .get("/v1/threads/:id/events", eventCursor, async (c) => {
      const principal = signedIn(c.var.principal);
      const id = c.req.param("id");
      // Answers 404 before the stream starts.
      await threads.visible(principal, id);
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
        // The reader may have lost the thread since the request was answered.
        const unsubscribe = await threads
          .follow(principal, id, after, (item) => {
            void write(() => stream.writeSSE(feedMessage(item)));
          })
          .catch((err: unknown) => {
            if (err instanceof ServiceError) return null;
            throw err;
          });
        if (!unsubscribe) {
          await ended();
          return;
        }
        stream.onAbort(unsubscribe);
        // The reader may have gone while what was stored was read for them.
        if (stream.aborted) unsubscribe();
        while (!stream.aborted && !options.shutdown?.aborted) {
          await heartbeat(options);
          if (stream.aborted || options.shutdown?.aborted) break;
          // Whoever may no longer read the thread, as a guest whose access ended or a member who
          // left its space, is told so, and the stream ends.
          if (!(await threads.readable(principal, id))) {
            unsubscribe();
            await ended();
            break;
          }
          await write(() => stream.write(": heartbeat\n\n").then(() => {}));
        }
        // The server is stopping.
        if (!stream.aborted && options.shutdown?.aborted) unsubscribe();
      });
    })
    .put("/v1/threads/:id/read", threadRead, async (c) => {
      const { seq } = c.req.valid("json");
      return c.json(await threads.markRead(signedIn(c.var.principal), c.req.param("id"), seq), 200);
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
        const inbox = await threads.inbox(principal, (item) => {
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
          await inbox.recheck();
          await write(() => stream.write(": heartbeat\n\n").then(() => {}));
        }
        inbox.stop();
      });
    })
    .get("/v1/threads/:id/commands", async (c) => {
      return c.json(await threads.commands(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/threads/:id/messages", message, async (c) => {
      const { text, mode, command } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const id = c.req.param("id");
      const posted = command
        ? await threads.postCommand(principal, id, text, mode, command)
        : await threads.postMessage(principal, id, text, mode);
      return c.json(posted, 202);
    })
    .patch("/v1/threads/:id/messages/:messageId", pendingChange, async (c) => {
      const { id, messageId } = c.req.param();
      const change = c.req.valid("json");
      return c.json(
        await threads.changeMessage(signedIn(c.var.principal), id, messageId, change),
        200,
      );
    })
    .delete("/v1/threads/:id/messages/:messageId", async (c) => {
      const { id, messageId } = c.req.param();
      return c.json(await threads.withdrawMessage(signedIn(c.var.principal), id, messageId), 200);
    })
    .post("/v1/threads/:id/stop", async (c) => {
      await threads.stop(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 202);
    })
    .post("/v1/threads/:id/unarchive", async (c) => {
      await threads.unarchive(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/retry", retry, async (c) => {
      const { runId } = c.req.valid("json");
      return c.json(await threads.retry(signedIn(c.var.principal), c.req.param("id"), runId), 202);
    });
}

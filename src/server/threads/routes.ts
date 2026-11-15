import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";

import type { Logger } from "@/server/kernel/logger.ts";
import type { ThreadAccess } from "@/server/access/access.ts";
import type { Queue } from "@/server/queue/queue.ts";
import type { Posts } from "@/server/queue/posts.ts";
import type { Execution } from "@/server/execution/execution.ts";
import type { Subagents } from "@/server/subagents/subagents.ts";
import { type ApiEnv, signedIn, jsonBody } from "@/server/http.ts";
import {
  messageInputSchema,
  newThreadSchema,
  pendingChangeSchema,
  retrySchema,
  threadMoveSchema,
  threadUpdateSchema,
} from "@/shared/threads/requests.ts";
import {
  asideFollowUpSchema,
  type AsideStreamItem,
  branchActionSchema,
  forkSchema,
  newAsideSchema,
} from "@/shared/threads/history.ts";

import type { Asides } from "./asides.ts";
import type { Branches } from "./branches.ts";
import type { Commands } from "./commands.ts";
import type { Threads } from "./threads.ts";
import type { Asking } from "./types.ts";

const newThread = jsonBody(
  newThreadSchema,
  "text must be a non-empty string, model a ref, effort low, medium or high, command a name and args",
);

const threadUpdate = jsonBody(threadUpdateSchema, "Give a title, a model or an effort");

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

export function threadRoutes(options: {
  threads: Threads;
  access?: Pick<ThreadAccess, "require">;
  queue?: Pick<Queue, "change" | "withdraw">;
  posts?: Pick<Posts, "message" | "command">;
  execution?: Pick<Execution, "stopBy" | "retry">;
  branches?: Pick<Branches, "act" | "branchOf">;
  asides?: Pick<Asides, "of" | "ask" | "followUp" | "stop">;
  commands?: Pick<Commands, "inThread" | "inSpace">;
  subagents?: Pick<Subagents, "unarchive">;
  logger?: Logger;
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  const { threads, access, queue, posts, execution, branches, asides, commands, subagents } =
    options;
  return new Hono<ApiEnv>()
    .post("/v1/spaces/:id/threads", newThread, async (c) => {
      const input = c.req.valid("json");
      const thread = await threads.create(signedIn(c.var.principal), c.req.param("id"), input);
      return c.json(thread, 200);
    })
    .get("/v1/spaces/:id/commands", async (c) => {
      return c.json(await commands!.inSpace(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/tool-results/:id", async (c) => {
      return c.json(await threads.result(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/threads/:id/rows/:rowId/branch", async (c) => {
      const { id, rowId } = c.req.param();
      return c.json(await branches!.branchOf(signedIn(c.var.principal), id, rowId), 200);
    })
    .post("/v1/threads/:id/history", branchAction, async (c) => {
      const action = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      return c.json(await branches!.act(principal, c.req.param("id"), action), 200);
    })
    .post("/v1/threads/:id/fork", fork, async (c) => {
      const input = c.req.valid("json");
      return c.json(await threads.fork(signedIn(c.var.principal), c.req.param("id"), input), 200);
    })
    .get("/v1/threads/:id/asides", async (c) => {
      return c.json(await asides!.of(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/threads/:id/asides", newAside, async (c) => {
      const input = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const asking = await asides!.ask(principal, c.req.param("id"), input);
      return answering(c, asking, options.shutdown);
    })
    .post("/v1/threads/:id/asides/:asideId/messages", asideFollowUp, async (c) => {
      const { id, asideId } = c.req.param();
      const { text } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const asking = await asides!.followUp(principal, id, asideId, text);
      return answering(c, asking, options.shutdown);
    })
    .post("/v1/threads/:id/asides/:asideId/stop", async (c) => {
      const { id, asideId } = c.req.param();
      await asides!.stop(signedIn(c.var.principal), id, asideId);
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
    .get("/v1/threads/:id/commands", async (c) => {
      return c.json(await commands!.inThread(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/threads/:id/messages", message, async (c) => {
      const { text, mode, command } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      const id = c.req.param("id");
      const posted = command
        ? await posts!.command(principal, id, text, mode, command)
        : await posts!.message(await access!.require(principal, id, "post"), text, mode);
      return c.json(posted, 202);
    })
    .patch("/v1/threads/:id/messages/:messageId", pendingChange, async (c) => {
      const { id, messageId } = c.req.param();
      const { text, mode } = c.req.valid("json");
      const reader = await access!.require(signedIn(c.var.principal), id, "post");
      const change = { ...(text !== undefined && { text }), ...(mode && { delivery: mode }) };
      return c.json(await queue!.change(reader, messageId, change), 200);
    })
    .delete("/v1/threads/:id/messages/:messageId", async (c) => {
      const { id, messageId } = c.req.param();
      const reader = await access!.require(signedIn(c.var.principal), id, "post");
      return c.json(await queue!.withdraw(reader, messageId), 200);
    })
    .post("/v1/threads/:id/stop", async (c) => {
      const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"), "post");
      await execution!.stopBy(reader);
      return c.json({ ok: true }, 202);
    })
    .post("/v1/threads/:id/unarchive", async (c) => {
      const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"), "post");
      await subagents!.unarchive(reader.thread.id);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/retry", retry, async (c) => {
      const { runId } = c.req.valid("json");
      const reader = await access!.require(signedIn(c.var.principal), c.req.param("id"), "post");
      return c.json((await execution!.retry(reader, runId)).event, 202);
    });
}

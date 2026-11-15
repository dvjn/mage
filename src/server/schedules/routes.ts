// The routes people reach a thread's wake-up timers and schedules through, signed in: a page of
// what one fired, and pausing, resuming and deleting it.

import { Hono } from "hono";
import * as z from "zod";

import type { ThreadAccess } from "@/server/access/access.ts";
import { type ApiEnv, queryOf, signedIn } from "@/server/http.ts";

import type { Schedules } from "./schedules.ts";

const historyQuery = queryOf(z.object({ offset: z.coerce.number().int().min(0).optional() }));

export function scheduleRoutes(options: {
  schedules: Pick<Schedules, "history" | "pause" | "resume" | "remove">;
  access: Pick<ThreadAccess, "require">;
}) {
  const { schedules, access } = options;
  return new Hono<ApiEnv>()
    .get("/v1/threads/:id/schedules/:scheduleId/history", historyQuery, async (c) => {
      const { id, scheduleId } = c.req.param();
      const { offset = 0 } = c.req.valid("query");
      const reader = await access.require(signedIn(c.var.principal), id, "read");
      return c.json(await schedules.history(reader, scheduleId, offset), 200);
    })
    .post("/v1/threads/:id/schedules/:scheduleId/pause", async (c) => {
      const { id, scheduleId } = c.req.param();
      await schedules.pause(
        await access.require(signedIn(c.var.principal), id, "post"),
        scheduleId,
      );
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/schedules/:scheduleId/resume", async (c) => {
      const { id, scheduleId } = c.req.param();
      await schedules.resume(
        await access.require(signedIn(c.var.principal), id, "post"),
        scheduleId,
      );
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/schedules/:scheduleId", async (c) => {
      const { id, scheduleId } = c.req.param();
      await schedules.remove(
        await access.require(signedIn(c.var.principal), id, "post"),
        scheduleId,
      );
      return c.json({ ok: true }, 200);
    });
}

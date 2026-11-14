import { Hono } from "hono";
import * as z from "zod";

import { type ApiEnv, jsonBody, queryOf, signedIn } from "@/server/http.ts";
import { taskAddInputSchema, taskChangeInputSchema } from "@/shared/tasks.ts";

import type { Tasks } from "./tasks.ts";

// The archived tasks, not the list, with archived=1.
const listQuery = queryOf(z.object({ archived: z.literal("1").optional() }));

const taskAdd = jsonBody(taskAddInputSchema, "title is required");

const taskChange = jsonBody(
  taskChangeInputSchema,
  "Give a title, a status of todo, doing or done, or an assignee",
);

export function taskRoutes(options: { tasks: Tasks }) {
  const { tasks } = options;
  return new Hono<ApiEnv>()
    .get("/v1/threads/:id/tasks", listQuery, async (c) => {
      const archived = c.req.valid("query").archived === "1";
      return c.json(
        await tasks.listFor(signedIn(c.var.principal), c.req.param("id"), archived),
        200,
      );
    })
    .post("/v1/threads/:id/tasks", taskAdd, async (c) => {
      await tasks.add(signedIn(c.var.principal), c.req.param("id"), c.req.valid("json").title);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/tasks/archive-done", async (c) => {
      const archived = await tasks.archiveDone(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ archived }, 200);
    })
    .patch("/v1/threads/:id/tasks/:taskId", taskChange, async (c) => {
      const { id, taskId } = c.req.param();
      await tasks.change(signedIn(c.var.principal), id, taskId, c.req.valid("json"));
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/tasks/:taskId", async (c) => {
      const { id, taskId } = c.req.param();
      await tasks.remove(signedIn(c.var.principal), id, taskId);
      return c.json({ ok: true }, 200);
    });
}

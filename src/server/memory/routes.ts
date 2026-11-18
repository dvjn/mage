import { Hono } from "hono";

import { type ApiEnv, signedIn } from "@/server/http.ts";

import type { Memory } from "./memory.ts";

export function memoryRoutes(options: { memory: Pick<Memory, "inSpace" | "forget"> }) {
  const { memory } = options;
  return new Hono<ApiEnv>()
    .get("/v1/spaces/:id/memory", async (c) => {
      return c.json(await memory.inSpace(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .delete("/v1/spaces/:id/memory/:entryId", async (c) => {
      const principal = signedIn(c.var.principal);
      await memory.forget(principal, c.req.param("id"), c.req.param("entryId"));
      return c.body(null, 204);
    });
}

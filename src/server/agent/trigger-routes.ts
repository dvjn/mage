import { Hono } from "hono";
import * as z from "zod";

import { type ApiEnv, jsonBody, queryOf, signedIn } from "@/server/http.ts";
import { hookSecretInputSchema } from "@/shared/triggers.ts";

import type { Triggers } from "./triggers.ts";

const historyQuery = queryOf(z.object({ offset: z.coerce.number().int().min(0).optional() }));
const hookSecret = jsonBody(hookSecretInputSchema, "secret is required, or null to clear it");

export function triggerRoutes(options: { triggers: Triggers }) {
  const { triggers } = options;
  return new Hono<ApiEnv>()
    .get("/v1/threads/:id/triggers/:triggerId/history", historyQuery, async (c) => {
      const { id, triggerId } = c.req.param();
      const { offset = 0 } = c.req.valid("query");
      return c.json(await triggers.history(signedIn(c.var.principal), id, triggerId, offset), 200);
    })
    .post("/v1/threads/:id/triggers/:triggerId/pause", async (c) => {
      const { id, triggerId } = c.req.param();
      await triggers.pause(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/triggers/:triggerId/resume", async (c) => {
      const { id, triggerId } = c.req.param();
      await triggers.resume(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/triggers/:triggerId/secret", hookSecret, async (c) => {
      const { id, triggerId } = c.req.param();
      await triggers.setSecret(
        signedIn(c.var.principal),
        id,
        triggerId,
        c.req.valid("json").secret,
      );
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/triggers/:triggerId", async (c) => {
      const { id, triggerId } = c.req.param();
      await triggers.delete(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    });
}

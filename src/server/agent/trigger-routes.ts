import { Hono } from "hono";
import { type ApiEnv, jsonBody, signedIn } from "@/server/http.ts";
import { hookSecretInputSchema } from "@/shared/triggers.ts";

import type { Triggers } from "./triggers.ts";

const hookSecret = jsonBody(hookSecretInputSchema, "secret is required, or null to clear it");

export function triggerRoutes(options: { triggers: Triggers }) {
  const { triggers } = options;
  return new Hono<ApiEnv>()
    .post("/v1/threads/:id/triggers/:triggerId/pause", (c) => {
      const { id, triggerId } = c.req.param();
      triggers.pause(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/triggers/:triggerId/resume", (c) => {
      const { id, triggerId } = c.req.param();
      triggers.resume(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/triggers/:triggerId/secret", hookSecret, (c) => {
      const { id, triggerId } = c.req.param();
      triggers.setSecret(signedIn(c.var.principal), id, triggerId, c.req.valid("json").secret);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/triggers/:triggerId", (c) => {
      const { id, triggerId } = c.req.param();
      triggers.delete(signedIn(c.var.principal), id, triggerId);
      return c.json({ ok: true }, 200);
    });
}

// The routes people reach a thread's webhooks through, signed in: a page of what one took, pausing,
// resuming and deleting it, and its signing secret and delivery header; and, outside the signed-in
// API, the address outside services post to.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";

import type { ThreadAccess } from "@/server/access/access.ts";
import { type ApiEnv, jsonBody, queryOf, signedIn } from "@/server/http.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import {
  HOOK_BODY_LIMIT,
  HOOK_SIGNATURE_HEADER,
  hookDeliveryHeaderInputSchema,
  hookSecretInputSchema,
} from "@/shared/webhooks.ts";

import type { Webhooks } from "./webhooks.ts";

const historyQuery = queryOf(z.object({ offset: z.coerce.number().int().min(0).optional() }));
const hookSecret = jsonBody(hookSecretInputSchema, "secret is required, or null to clear it");
const deliveryHeader = jsonBody(
  hookDeliveryHeaderInputSchema,
  "header is required, or null to clear it",
);

export function webhookRoutes(options: {
  webhooks: Pick<
    Webhooks,
    "history" | "pause" | "resume" | "remove" | "setSecret" | "setDeliveryHeader"
  >;
  access: Pick<ThreadAccess, "require">;
}) {
  const { webhooks, access } = options;
  // The reader of the thread, for an action people take on one of its webhooks.
  const reader = async (principal: Principal | null, threadId: string, action: "read" | "post") =>
    access.require(signedIn(principal), threadId, action);
  return new Hono<ApiEnv>()
    .get("/v1/threads/:id/webhooks/:webhookId/history", historyQuery, async (c) => {
      const { id, webhookId } = c.req.param();
      const { offset = 0 } = c.req.valid("query");
      const found = await reader(c.var.principal, id, "read");
      return c.json(await webhooks.history(found, webhookId, offset), 200);
    })
    .post("/v1/threads/:id/webhooks/:webhookId/pause", async (c) => {
      const { id, webhookId } = c.req.param();
      await webhooks.pause(await reader(c.var.principal, id, "post"), webhookId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/webhooks/:webhookId/resume", async (c) => {
      const { id, webhookId } = c.req.param();
      await webhooks.resume(await reader(c.var.principal, id, "post"), webhookId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/webhooks/:webhookId/secret", hookSecret, async (c) => {
      const { id, webhookId } = c.req.param();
      const found = await reader(c.var.principal, id, "post");
      await webhooks.setSecret(found, webhookId, c.req.valid("json").secret);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/webhooks/:webhookId/delivery-header", deliveryHeader, async (c) => {
      const { id, webhookId } = c.req.param();
      const found = await reader(c.var.principal, id, "post");
      await webhooks.setDeliveryHeader(found, webhookId, c.req.valid("json").header);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/webhooks/:webhookId", async (c) => {
      const { id, webhookId } = c.req.param();
      await webhooks.remove(await reader(c.var.principal, id, "post"), webhookId);
      return c.json({ ok: true }, 200);
    });
}

// Where outside services post to a webhook: open to anyone who has its address, so outside the
// signed-in API. The body is taken as it comes, up to a size cap, with the headers it came with.
export function hookRoutes(options: { webhooks: Pick<Webhooks, "deliver"> }) {
  return new Hono().post(
    "/hooks/:token",
    bodyLimit({
      maxSize: HOOK_BODY_LIMIT,
      onError: (c) => c.json({ error: "Too large" }, 413),
    }),
    async (c) => {
      await options.webhooks.deliver(c.req.param("token"), {
        body: new Uint8Array(await c.req.arrayBuffer()),
        contentType: c.req.header("content-type") ?? null,
        signature: c.req.header(HOOK_SIGNATURE_HEADER) ?? null,
        headers: c.req.raw.headers,
      });
      return c.json({ ok: true }, 200);
    },
  );
}

// Where outside services post to a webhook: open to anyone who has its address, so outside the
// signed-in API. The body is taken as it comes, up to a size cap, and checked against the
// webhook's signing secret, when it has one.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { HOOK_BODY_LIMIT, HOOK_SIGNATURE_HEADER } from "@/shared/triggers.ts";

import type { Triggers } from "./triggers.ts";

export function hookRoutes(options: { triggers: Pick<Triggers, "deliver"> }) {
  return new Hono().post(
    "/hooks/:token",
    bodyLimit({
      maxSize: HOOK_BODY_LIMIT,
      onError: (c) => c.json({ error: "Too large" }, 413),
    }),
    async (c) => {
      await options.triggers.deliver(c.req.param("token"), {
        body: new Uint8Array(await c.req.arrayBuffer()),
        contentType: c.req.header("content-type") ?? null,
        signature: c.req.header(HOOK_SIGNATURE_HEADER) ?? null,
      });
      return c.json({ ok: true }, 200);
    },
  );
}

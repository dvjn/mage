import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody } from "@/server/http.ts";
import { acceptInviteSchema, newInviteSchema } from "@/shared/guests.ts";

import type { Guests } from "./service.ts";

const newInvite = jsonBody(newInviteSchema, "accessFor is 1h, 1d, 7d or never");

const acceptInvite = jsonBody(acceptInviteSchema, "token is required");

export function guestRoutes(options: { guests: Guests }) {
  const { guests } = options;
  return new Hono<ApiEnv>()
    .post("/v1/invites/accept", acceptInvite, (c) => {
      const { token } = c.req.valid("json");
      return c.json(guests.accept(signedIn(c.var.principal), token), 200);
    })
    .post("/v1/threads/:id/invites", newInvite, (c) => {
      const { accessFor } = c.req.valid("json");
      return c.json(guests.invite(signedIn(c.var.principal), c.req.param("id"), accessFor), 200);
    })
    .get("/v1/threads/:id/people", (c) => {
      return c.json(guests.people(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .delete("/v1/threads/:id/invites/:inviteId", (c) => {
      const { id, inviteId } = c.req.param();
      guests.revokeInvite(signedIn(c.var.principal), id, inviteId);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/guests/:userId", (c) => {
      const { id, userId } = c.req.param();
      guests.revokeGuest(signedIn(c.var.principal), id, userId);
      return c.json({ ok: true }, 200);
    });
}

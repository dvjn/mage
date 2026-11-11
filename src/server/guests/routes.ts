import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody, queryOf } from "@/server/http.ts";
import {
  acceptInviteSchema,
  guestRoleChangeSchema,
  newGroupGuestSchema,
  newGuestSchema,
  newInviteSchema,
  orgAccessChangeSchema,
} from "@/shared/guests.ts";
import { pageParams, pageQuerySchema } from "@/shared/paging.ts";

import type { Guests } from "./service.ts";

const newInvite = jsonBody(
  newInviteSchema,
  "accessFor is 1h, 1d, 7d or never, and role is view or message",
);

const roleChange = jsonBody(guestRoleChangeSchema, "role is view or message");

const orgAccessChange = jsonBody(orgAccessChangeSchema, "orgAccess is none, view or message");

const acceptInvite = jsonBody(acceptInviteSchema, "token is required");

const newGuest = jsonBody(
  newGuestSchema,
  "userId and accessFor (1h, 1d, 7d or never) are required, and role is view or message",
);

const newGroupGuest = jsonBody(
  newGroupGuestSchema,
  "groupId and accessFor (1h, 1d, 7d or never) are required, and role is view or message",
);

const candidateQuery = queryOf(pageQuerySchema);

export function guestRoutes(options: { guests: Guests }) {
  const { guests } = options;
  return new Hono<ApiEnv>()
    .post("/v1/invites/accept", acceptInvite, (c) => {
      const { token } = c.req.valid("json");
      return c.json(guests.accept(signedIn(c.var.principal), token), 200);
    })
    .post("/v1/threads/:id/invites", newInvite, (c) => {
      const { accessFor, role } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      return c.json(guests.invite(principal, c.req.param("id"), accessFor, role), 200);
    })
    .get("/v1/threads/:id/people", (c) => {
      return c.json(guests.people(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/threads/:id/guest-candidates", candidateQuery, (c) => {
      const params = pageParams(c.req.valid("query"));
      return c.json(guests.candidates(signedIn(c.var.principal), c.req.param("id"), params), 200);
    })
    .post("/v1/threads/:id/guests", newGuest, (c) => {
      const { userId, accessFor, role } = c.req.valid("json");
      guests.add(signedIn(c.var.principal), c.req.param("id"), userId, accessFor, role);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/group-guests", newGroupGuest, (c) => {
      const { groupId, accessFor, role } = c.req.valid("json");
      guests.addGroup(signedIn(c.var.principal), c.req.param("id"), groupId, accessFor, role);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/group-guests/:groupId/role", roleChange, (c) => {
      const { id, groupId } = c.req.param();
      guests.setGroupRole(signedIn(c.var.principal), id, groupId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/group-guests/:groupId", (c) => {
      const { id, groupId } = c.req.param();
      guests.revokeGroup(signedIn(c.var.principal), id, groupId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/org-access", orgAccessChange, (c) => {
      const { orgAccess } = c.req.valid("json");
      guests.setOrgAccess(signedIn(c.var.principal), c.req.param("id"), orgAccess);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/guests/:userId/role", roleChange, (c) => {
      const { id, userId } = c.req.param();
      guests.setGuestRole(signedIn(c.var.principal), id, userId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/invites/:inviteId/role", roleChange, (c) => {
      const { id, inviteId } = c.req.param();
      guests.setInviteRole(signedIn(c.var.principal), id, inviteId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
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

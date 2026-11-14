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
    .post("/v1/invites/accept", acceptInvite, async (c) => {
      const { token } = c.req.valid("json");
      return c.json(await guests.accept(signedIn(c.var.principal), token), 200);
    })
    .post("/v1/threads/:id/invites", newInvite, async (c) => {
      const { accessFor, role } = c.req.valid("json");
      const principal = signedIn(c.var.principal);
      return c.json(await guests.invite(principal, c.req.param("id"), accessFor, role), 200);
    })
    .get("/v1/threads/:id/people", async (c) => {
      return c.json(await guests.people(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/threads/:id/guest-candidates", candidateQuery, async (c) => {
      const params = pageParams(c.req.valid("query"));
      return c.json(
        await guests.candidates(signedIn(c.var.principal), c.req.param("id"), params),
        200,
      );
    })
    .post("/v1/threads/:id/guests", newGuest, async (c) => {
      const { userId, accessFor, role } = c.req.valid("json");
      await guests.add(signedIn(c.var.principal), c.req.param("id"), userId, accessFor, role);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/group-guests", newGroupGuest, async (c) => {
      const { groupId, accessFor, role } = c.req.valid("json");
      await guests.addGroup(signedIn(c.var.principal), c.req.param("id"), groupId, accessFor, role);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/group-guests/:groupId/role", roleChange, async (c) => {
      const { id, groupId } = c.req.param();
      await guests.setGroupRole(signedIn(c.var.principal), id, groupId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/group-guests/:groupId", async (c) => {
      const { id, groupId } = c.req.param();
      await guests.revokeGroup(signedIn(c.var.principal), id, groupId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/org-access", orgAccessChange, async (c) => {
      const { orgAccess } = c.req.valid("json");
      await guests.setOrgAccess(signedIn(c.var.principal), c.req.param("id"), orgAccess);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/guests/:userId/role", roleChange, async (c) => {
      const { id, userId } = c.req.param();
      await guests.setGuestRole(signedIn(c.var.principal), id, userId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/threads/:id/invites/:inviteId/role", roleChange, async (c) => {
      const { id, inviteId } = c.req.param();
      await guests.setInviteRole(signedIn(c.var.principal), id, inviteId, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/invites/:inviteId", async (c) => {
      const { id, inviteId } = c.req.param();
      await guests.revokeInvite(signedIn(c.var.principal), id, inviteId);
      return c.json({ ok: true }, 200);
    })
    .delete("/v1/threads/:id/guests/:userId", async (c) => {
      const { id, userId } = c.req.param();
      await guests.revokeGuest(signedIn(c.var.principal), id, userId);
      return c.json({ ok: true }, 200);
    });
}

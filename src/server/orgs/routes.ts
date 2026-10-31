import { Hono } from "hono";
import { validator } from "hono/validator";

import { type ApiEnv, signedIn, jsonBody, queryOf } from "@/server/http.ts";
import type { Me } from "@/shared/me.ts";
import {
  acceptOrgInviteSchema,
  memberFilterSchema,
  newGroupLinkSchema,
  newOrgInviteSchema,
  newOrgMemberSchema,
  peopleFilterSchema,
  orgNameSchema,
  setOrgRoleSchema,
  teamSettingsChangeSchema,
} from "@/shared/orgs.ts";
import { pageParams, pageQuerySchema } from "@/shared/paging.ts";

import type { Identity, SignedIn } from "./identity.ts";
import type { Groups } from "./groups.ts";
import type { Orgs } from "./service.ts";

// Set for every route behind the signed-in check.
function accountOf(account: SignedIn | null) {
  if (!account) throw new Error("route reached without an account");
  return { userId: account.userId, email: account.email };
}

const orgName = jsonBody(orgNameSchema, "A name of 1 to 80 characters is required");

const newOrgInvite = jsonBody(newOrgInviteSchema, "Give an email address and a role");

const setOrgRole = jsonBody(setOrgRoleSchema, "role is owner or member");

const newOrgMember = jsonBody(newOrgMemberSchema, "Give a directory person's id and a role");

const newGroupLink = jsonBody(newGroupLinkSchema, "Give a directory group's id and a role");

const acceptOrgInvite = jsonBody(acceptOrgInviteSchema, "token is required");

const teamSettingsChange = jsonBody(teamSettingsChangeSchema, "Give spaceCreation or memberSpaces");

// `?space=` or `?thread=` to find the org of.
const placeQuery = validator("query", (value: { space?: string; thread?: string }) => ({
  space: typeof value.space === "string" ? value.space : undefined,
  thread: typeof value.thread === "string" ? value.thread : undefined,
}));

const pageQuery = queryOf(pageQuerySchema);

const memberQuery = queryOf(memberFilterSchema);

const peopleQuery = queryOf(peopleFilterSchema);

export function orgRoutes(options: { identity: Identity; orgs: Orgs; groups: Groups }) {
  const { identity, orgs, groups } = options;
  return (
    new Hono<ApiEnv>()
      // What an org invite link offers; signed out, the whole email it is for.
      .get("/org-invites/:token", async (c) => {
        const account = await identity.resolve(c.req.raw.headers, null);
        return c.json(orgs.preview(c.req.param("token"), account && accountOf(account)), 200);
      })
      .get("/v1/me", async (c) => {
        return c.json((await identity.profile(signedIn(c.var.principal))) satisfies Me, 200);
      })
      .get("/v1/orgs", (c) => {
        return c.json(orgs.list(accountOf(c.var.account)), 200);
      })
      .post("/v1/orgs", orgName, async (c) => {
        return c.json(await orgs.create(accountOf(c.var.account), c.req.valid("json").name), 200);
      })
      .get("/v1/locate", placeQuery, (c) => {
        const orgId = orgs.locate(accountOf(c.var.account), c.req.valid("query"));
        if (!orgId) return c.json({ error: "Not found" }, 404);
        return c.json({ orgId }, 200);
      })
      .post("/v1/org-invites/accept", acceptOrgInvite, async (c) => {
        const { token } = c.req.valid("json");
        return c.json(await orgs.accept(accountOf(c.var.account), token), 200);
      })
      .patch("/v1/org", orgName, (c) => {
        orgs.rename(signedIn(c.var.principal), c.req.valid("json").name);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org", (c) => {
        orgs.delete(signedIn(c.var.principal));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/members", memberQuery, (c) => {
        const { role, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(role && { role }) };
        return c.json(orgs.members(signedIn(c.var.principal), params), 200);
      })
      .get("/v1/org/members/:userId", (c) => {
        return c.json(orgs.member(signedIn(c.var.principal), c.req.param("userId")), 200);
      })
      .get("/v1/org/members/:userId/groups", pageQuery, (c) => {
        const params = pageParams(c.req.valid("query"));
        const page = orgs.groupsOf(signedIn(c.var.principal), c.req.param("userId"), params);
        return c.json(
          {
            ...page,
            items: page.items.map((group) => ({
              id: group.id,
              name: group.name,
              source: group.source,
              role: group.role,
              memberCount: group.memberCount,
              createdAt: group.createdAt.toISOString(),
            })),
          },
          200,
        );
      })
      .get("/v1/org/people", peopleQuery, (c) => {
        const { role, status, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(role && { role }), ...(status && { status }) };
        return c.json(orgs.people(signedIn(c.var.principal), params), 200);
      })
      .patch("/v1/org/members/:userId", setOrgRole, (c) => {
        const { role } = c.req.valid("json");
        orgs.setRole(signedIn(c.var.principal), c.req.param("userId"), role);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org/members/:userId", (c) => {
        orgs.removeMember(signedIn(c.var.principal), c.req.param("userId"));
        return c.json({ ok: true }, 200);
      })
      .post("/v1/org/members", newOrgMember, (c) => {
        const { userId, role } = c.req.valid("json");
        orgs.addMember(signedIn(c.var.principal), userId, role);
        return c.json({ ok: true }, 200);
      })
      .post("/v1/org/groups", newGroupLink, (c) => {
        const { groupId, role } = c.req.valid("json");
        orgs.linkGroup(signedIn(c.var.principal), groupId, role);
        return c.json({ ok: true }, 200);
      })
      .patch("/v1/org/groups/:id", setOrgRole, (c) => {
        orgs.setGroupRole(signedIn(c.var.principal), c.req.param("id"), c.req.valid("json").role);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org/groups/:id", (c) => {
        orgs.unlinkGroup(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/directory/people", pageQuery, (c) => {
        const page = orgs.directoryPeople(
          signedIn(c.var.principal),
          pageParams(c.req.valid("query")),
        );
        return c.json(
          {
            ...page,
            items: page.items.map(({ id, name, email, role }) => ({
              userId: id,
              name,
              email,
              role,
            })),
          },
          200,
        );
      })
      .get("/v1/directory/groups", pageQuery, (c) => {
        const page = orgs.directoryGroups(
          signedIn(c.var.principal),
          pageParams(c.req.valid("query")),
        );
        return c.json(
          {
            ...page,
            items: page.items.map(({ id, name, memberCount, role }) => ({
              id,
              name,
              memberCount,
              role,
            })),
          },
          200,
        );
      })
      .post("/v1/org/invites", newOrgInvite, (c) => {
        const { email, role } = c.req.valid("json");
        return c.json(orgs.invite(signedIn(c.var.principal), email, role), 200);
      })
      .delete("/v1/org/invites/:id", (c) => {
        orgs.revokeInvite(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/settings", (c) => {
        return c.json(orgs.settings(signedIn(c.var.principal)), 200);
      })
      .patch("/v1/org/settings", teamSettingsChange, (c) => {
        return c.json(orgs.setSettings(signedIn(c.var.principal), c.req.valid("json")), 200);
      })
      .get("/v1/org/groups", pageQuery, (c) => {
        return c.json(
          groups.list(signedIn(c.var.principal), pageParams(c.req.valid("query"))),
          200,
        );
      })
      .get("/v1/org/groups/:id", (c) => {
        return c.json(groups.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .get("/v1/org/groups/:id/members", pageQuery, (c) => {
        const params = pageParams(c.req.valid("query"));
        return c.json(groups.members(signedIn(c.var.principal), c.req.param("id"), params), 200);
      })
  );
}

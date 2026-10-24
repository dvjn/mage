import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";
import type { OrgPerson } from "@/shared/orgs.ts";
import type { Page } from "@/shared/paging.ts";

import { SCIM_TOKEN, setup } from "./workspace.ts";

type Workspace = ReturnType<typeof setup>;

// Ada's team org "Analytical Engines".
async function teamOrg() {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const res = await workspace.api("POST", "/orgs", ada.cookie, { name: "Analytical Engines" });
  const { orgId } = (await res.json()) as { orgId: string };
  return { ...workspace, ada: { ...ada, orgId }, orgId };
}

function scimRequest(workspace: Workspace, path: string, token?: string) {
  return workspace.app.request(`/api/auth/scim/v2${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function userIdOf(workspace: Workspace, email: string) {
  return workspace.directory.userByEmail(email)?.id as string;
}

async function people(workspace: Awaited<ReturnType<typeof teamOrg>>) {
  const res = await workspace.api(
    "GET",
    "/org/people",
    workspace.ada.cookie,
    undefined,
    workspace.orgId,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as Page<OrgPerson>).items;
}

function link(workspace: Awaited<ReturnType<typeof teamOrg>>, groupId: string, role: string) {
  const { api, ada, orgId } = workspace;
  return api("POST", "/org/groups", ada.cookie, { groupId, role }, orgId);
}

describe("the SCIM service", () => {
  it("answers only the directory's token", async () => {
    const workspace = setup();
    expect((await scimRequest(workspace, "/Users")).status).toBe(401);
    expect((await scimRequest(workspace, "/Users", "x".repeat(40))).status).toBe(401);
    const config = await scimRequest(workspace, "/ServiceProviderConfig", SCIM_TOKEN);
    expect(config.status).toBe(200);
    expect(config.headers.get("content-type")).toContain("application/scim+json");
  });

  it("provisions a person the directory can find again", async () => {
    const workspace = setup();
    const id = await workspace.scim.createUser({
      name: "Grace Hopper",
      email: "grace@example.com",
    });
    const res = await scimRequest(
      workspace,
      `/Users?filter=${encodeURIComponent('userName eq "grace@example.com"')}`,
      SCIM_TOKEN,
    );
    const found = (await res.json()) as { Resources: { id: string }[] };
    expect(found.Resources.map((user) => user.id)).toEqual([id]);
    expect(workspace.directory.userByEmail("grace@example.com")).toMatchObject({
      name: "Grace Hopper",
      source: "scim",
    });
  });

  it("links the account someone already has by their email", async () => {
    const workspace = setup();
    const grace = await workspace.signUp("Grace Hopper", "grace@example.com");
    await workspace.scim.createUser({ name: "Grace B. Hopper", email: "Grace@Example.com" });
    expect(workspace.directory.user(grace.userId)).toMatchObject({
      name: "Grace B. Hopper",
      source: "scim",
    });
  });
});

describe("org access from the directory", () => {
  it("makes a linked group's people members, with the highest of their roles", async () => {
    const workspace = await teamOrg();
    const { scim, api, ada, orgId, directory } = workspace;
    const grace = await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    const hedy = await scim.createUser({ name: "Hedy Lamarr", email: "hedy@example.com" });
    const looms = await scim.createGroup("Looms", [grace]);
    const graceId = userIdOf(workspace, "grace@example.com");
    const hedyId = userIdOf(workspace, "hedy@example.com");

    expect(directory.roleIn(orgId, graceId)).toBeNull();
    expect((await link(workspace, looms, "member")).status).toBe(200);
    expect((await link(workspace, looms, "member")).status).toBe(409);
    expect(directory.roleIn(orgId, graceId)).toBe("member");
    // Joining through a group gives them their own space, as an invite does.
    expect(
      workspace.db
        .select()
        .from(schema.space)
        .where(eq(schema.space.createdBy, graceId))
        .all()
        .some((space) => space.organizationId === orgId),
    ).toBe(true);

    await scim.addMembers(looms, [hedy]);
    expect(directory.roleIn(orgId, hedyId)).toBe("member");
    // A role of her own and the group's: the higher counts.
    expect(
      (await api("PATCH", `/org/members/${graceId}`, ada.cookie, { role: "owner" }, orgId)).status,
    ).toBe(200);
    expect(directory.roleIn(orgId, graceId)).toBe("owner");
    expect(
      (await api("PATCH", `/org/groups/${looms}`, ada.cookie, { role: "owner" }, orgId)).status,
    ).toBe(200);
    expect(directory.roleIn(orgId, hedyId)).toBe("owner");
    await api("PATCH", `/org/groups/${looms}`, ada.cookie, { role: "member" }, orgId);
    expect(directory.roleIn(orgId, hedyId)).toBe("member");

    const rows = await people(workspace);
    expect(rows.map((row) => [row.kind, "name" in row ? row.name : row.email])).toEqual([
      ["group", "Looms"],
      ["member", "Ada Lovelace"],
      ["member", "Grace Hopper"],
      ["member", "Hedy Lamarr"],
    ]);
    expect(rows.find((row) => row.kind === "group")).toMatchObject({ memberCount: 2 });
    expect(rows.find((row) => "name" in row && row.name === "Hedy Lamarr")).toMatchObject({
      directRole: null,
      viaGroup: "Looms",
      source: "scim",
    });

    // Removing someone in only through the group is refused; removing Grace's own role keeps her.
    expect(
      (await api("DELETE", `/org/members/${hedyId}`, ada.cookie, undefined, orgId)).status,
    ).toBe(409);
    expect(
      (await api("DELETE", `/org/members/${graceId}`, ada.cookie, undefined, orgId)).status,
    ).toBe(200);
    expect(directory.roleIn(orgId, graceId)).toBe("member");
  });

  it("takes out people who leave the group, as former members, and lets them back in", async () => {
    const workspace = await teamOrg();
    const { scim, orgId, directory } = workspace;
    const grace = await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    const looms = await scim.createGroup("Looms", [grace]);
    await link(workspace, looms, "member");
    const graceId = userIdOf(workspace, "grace@example.com");

    await scim.removeMembers(looms, [grace]);
    expect(directory.roleIn(orgId, graceId)).toBeNull();
    expect(directory.formerMembers(orgId, [graceId])).toEqual([graceId]);

    await scim.addMembers(looms, [grace]);
    expect(directory.roleIn(orgId, graceId)).toBe("member");
    expect(directory.formerMembers(orgId, [graceId])).toEqual([]);

    // Unlinking the group, or the directory deleting it, takes them out too.
    expect(
      (
        await workspace.api(
          "DELETE",
          `/org/groups/${looms}`,
          workspace.ada.cookie,
          undefined,
          orgId,
        )
      ).status,
    ).toBe(200);
    expect(directory.roleIn(orgId, graceId)).toBeNull();
    await link(workspace, looms, "member");
    expect(directory.roleIn(orgId, graceId)).toBe("member");
    await scim.deleteGroup(looms);
    expect(directory.roleIn(orgId, graceId)).toBeNull();
    expect(workspace.db.select().from(schema.orgGroup).all()).toEqual([]);
  });

  it("drops a group's roles in spaces when it is unlinked", async () => {
    const workspace = await teamOrg();
    const { scim, api, ada, orgId, db } = workspace;
    const grace = await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    const looms = await scim.createGroup("Looms", [grace]);
    await link(workspace, looms, "member");
    const space = (await (
      await api("POST", "/spaces", ada.cookie, { name: "Loom room" }, orgId)
    ).json()) as {
      id: string;
    };
    const grant = { kind: "group", id: looms, role: "viewer" };
    expect((await api("PUT", `/spaces/${space.id}/members`, ada.cookie, grant, orgId)).status).toBe(
      200,
    );
    await api("DELETE", `/org/groups/${looms}`, ada.cookie, undefined, orgId);
    expect(
      db.select().from(schema.spaceMember).where(eq(schema.spaceMember.subjectId, looms)).all(),
    ).toEqual([]);
    expect((await api("PUT", `/spaces/${space.id}/members`, ada.cookie, grant, orgId)).status).toBe(
      404,
    );
  });

  it("turns off someone the directory deactivates: no sessions, no sign-in, no own roles", async () => {
    const workspace = await teamOrg();
    const { scim, api, ada, orgId, directory, app } = workspace;
    const grace = await workspace.signUp("Grace Hopper", "grace@example.com");
    const graceScim = await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    expect(
      (
        await api(
          "POST",
          "/org/members",
          ada.cookie,
          { userId: grace.userId, role: "member" },
          orgId,
        )
      ).status,
    ).toBe(200);
    expect(directory.roleIn(orgId, grace.userId)).toBe("member");

    await scim.setActive(graceScim, false);
    expect((await api("GET", "/spaces", grace.cookie)).status).toBe(401);
    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:4783" },
      body: JSON.stringify({ email: "grace@example.com", password: "correct horse battery" }),
    });
    expect(signIn.status).toBe(403);
    expect(directory.roleIn(orgId, grace.userId)).toBeNull();
    expect(directory.formerMembers(orgId, [grace.userId])).toEqual([grace.userId]);
    // Her name stays for what she wrote.
    expect(directory.user(grace.userId)?.name).toBe("Grace Hopper");

    // Turned on again, she signs in, but her own role must be given again.
    await scim.setActive(graceScim, true);
    expect(directory.roleIn(orgId, grace.userId)).toBeNull();
    const again = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:4783" },
      body: JSON.stringify({ email: "grace@example.com", password: "correct horse battery" }),
    });
    expect(again.status).toBe(200);
  });

  it("keeps the last owner in their own right through a deactivation, and deletion", async () => {
    const workspace = await teamOrg();
    const { scim, orgId, directory, ada } = workspace;
    const adaScim = await scim.createUser({ name: "Ada Lovelace", email: "ada@example.com" });
    await scim.setActive(adaScim, false);
    expect(directory.roleIn(orgId, ada.userId)).toBe("owner");
    await scim.deleteUser(adaScim);
    expect(directory.roleIn(orgId, ada.userId)).toBe("owner");
    const signIn = await workspace.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:4783" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    expect(signIn.status).toBe(403);
  });

  it("offers owners the directory's people and groups, and no one else's accounts", async () => {
    const workspace = await teamOrg();
    const { scim, api, ada, orgId } = workspace;
    await workspace.signUp("Joan Clarke", "joan@example.com");
    await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    const looms = await scim.createGroup("Looms");
    await link(workspace, looms, "owner");

    const found = (await (
      await api("GET", "/directory/people", ada.cookie, undefined, orgId)
    ).json()) as Page<{ name: string; role: string | null }>;
    expect(found.items).toEqual([expect.objectContaining({ name: "Grace Hopper", role: null })]);
    const groups = (await (
      await api("GET", "/directory/groups", ada.cookie, undefined, orgId)
    ).json()) as Page<{ name: string; role: string | null }>;
    expect(groups.items).toEqual([
      expect.objectContaining({ name: "Looms", role: "owner", memberCount: 0 }),
    ]);
    const joan = userIdOf(workspace, "joan@example.com");
    expect(
      (await api("POST", "/org/members", ada.cookie, { userId: joan, role: "member" }, orgId))
        .status,
    ).toBe(404);
  });
});

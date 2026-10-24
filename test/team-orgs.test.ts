import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";
import type { OrgMember, OrgPerson } from "@/shared/orgs.ts";
import type { Page } from "@/shared/paging.ts";
import { FIRST_SPACE_NAME, type SpaceMembers, spaceNameFor } from "@/shared/spaces.ts";
import type { ThreadDetail } from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { type SpaceBody, setup } from "./workspace.ts";

type Workspace = ReturnType<typeof setup>;
type Person = { userId: string; orgId: string; cookie: string };

// Ada's team org "Analytical Engines" with its General space.
async function teamOrg(workspace: Workspace = setup()) {
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const res = await workspace.api("POST", "/orgs", ada.cookie, { name: "Analytical Engines" });
  expect(res.status).toBe(200);
  const { orgId, spaceId: generalId } = (await res.json()) as { orgId: string; spaceId: string };
  return { ...workspace, ada: { ...ada, orgId }, orgId, generalId };
}

// An invite link's token, made by `by` for the email.
async function inviteToken(
  workspace: Workspace,
  by: Person,
  email: string,
  role: "owner" | "member" = "member",
) {
  const res = await workspace.api("POST", "/org/invites", by.cookie, { email, role }, by.orgId);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return url.split("/join/")[1]!;
}

function accept(workspace: Workspace, who: { cookie: string }, token: string) {
  return workspace.api("POST", "/org-invites/accept", who.cookie, { token });
}

// Ada's team org with Grace in it as a member.
async function withGrace() {
  const workspace = await teamOrg();
  const signedUp = await workspace.signUp("Grace Hopper", "grace@example.com");
  const token = await inviteToken(workspace, workspace.ada, "grace@example.com");
  expect((await accept(workspace, signedUp, token)).status).toBe(200);
  return { ...workspace, grace: { ...signedUp, orgId: workspace.orgId } };
}

async function spacesOf(workspace: Workspace, who: Person) {
  const res = await workspace.api("GET", "/spaces", who.cookie, undefined, who.orgId);
  expect(res.status).toBe(200);
  return (await res.json()) as SpaceBody[];
}

async function newSpace(workspace: Workspace, who: Person, name: string) {
  const res = await workspace.api("POST", "/spaces", who.cookie, { name }, who.orgId);
  expect(res.status).toBe(200);
  return (await res.json()) as SpaceBody;
}

function setMember(
  workspace: Workspace,
  who: Person,
  spaceId: string,
  body: { kind: "user" | "group"; id: string; role: string | null },
) {
  return workspace.api("PUT", `/spaces/${spaceId}/members`, who.cookie, body, who.orgId);
}

// The person's id at the directory, provisioning them first if it has not brought them yet.
async function inDirectory(workspace: Workspace, userId: string) {
  const known = workspace.db
    .select({ id: schema.scimUser.id })
    .from(schema.scimUser)
    .where(eq(schema.scimUser.userId, userId))
    .get();
  if (known) return known.id;
  const user = workspace.directory.user(userId);
  if (!user) throw new Error("no user");
  return workspace.scim.createUser({ name: user.name, email: user.email });
}

// A group the directory brings with the members, linked to the org with the member role.
async function newGroup(workspace: Workspace, who: Person, name: string, members: string[]) {
  const ids = [];
  for (const userId of members) ids.push(await inDirectory(workspace, userId));
  const groupId = await workspace.scim.createGroup(name, ids);
  const res = await workspace.api(
    "POST",
    "/org/groups",
    who.cookie,
    { groupId, role: "member" },
    who.orgId,
  );
  expect(res.status).toBe(200);
  return groupId;
}

describe("team orgs", () => {
  it("makes its creator the owner, with a General space open to everyone and their own space", async () => {
    const { api, ada, orgId, generalId } = await teamOrg();

    const orgs = (await (await api("GET", "/orgs", ada.cookie)).json()) as {
      orgs: { name: string; kind: string; role: string }[];
      canCreate: boolean;
    };
    expect(orgs).toEqual({
      orgs: [
        expect.objectContaining({ name: "Ada Lovelace", kind: "personal", role: "owner" }),
        expect.objectContaining({
          id: orgId,
          name: "Analytical Engines",
          kind: "team",
          role: "owner",
        }),
      ],
      canCreate: true,
    });
    const res = await api("GET", "/spaces", ada.cookie, undefined, orgId);
    expect(await res.json()).toEqual([
      expect.objectContaining({ name: "Ada Lovelace's Space", kind: "personal", primary: true }),
      expect.objectContaining({
        id: generalId,
        name: "General",
        kind: "shared",
        everyoneRole: "messager",
        role: "owner",
      }),
    ]);
  });

  it("is only for operators when the server says so", async () => {
    const workspace = setup({}, { teamOrgs: "operator", operatorEmails: ["ada@example.com"] });
    const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
    const grace = await workspace.signUp("Grace Hopper", "grace@example.com");

    const refused = await workspace.api("POST", "/orgs", grace.cookie, { name: "Looms" });
    expect(refused.status).toBe(403);
    expect(await (await workspace.api("GET", "/orgs", grace.cookie)).json()).toMatchObject({
      canCreate: false,
    });
    expect((await workspace.api("POST", "/orgs", ada.cookie, { name: "Engines" })).status).toBe(
      200,
    );
  });
});

describe("the org a request acts in", () => {
  it("is the one the header names, else the one used last", async () => {
    const { api, ada, orgId, generalId } = await teamOrg();

    const personal = (await (await api("GET", "/me", ada.cookie)).json()) as {
      org: { kind: string };
    };
    expect(personal.org.kind).toBe("personal");
    const team = await api("GET", "/me", ada.cookie, undefined, orgId);
    expect(await team.json()).toMatchObject({ org: { id: orgId, kind: "team" }, role: "owner" });
    // The org named last is the one a request without a header acts in.
    const fallback = (await (await api("GET", "/spaces", ada.cookie)).json()) as SpaceBody[];
    expect(fallback.map((space) => space.id)).toContain(generalId);
  });

  it("is not found when the person is not in it, except for routes about the person", async () => {
    const { api, orgId, signUp } = await teamOrg();
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");

    expect((await api("GET", "/spaces", hedy.cookie, undefined, orgId)).status).toBe(404);
    expect((await api("GET", "/me", hedy.cookie, undefined, orgId)).status).toBe(404);
    expect((await api("GET", "/orgs", hedy.cookie, undefined, orgId)).status).toBe(200);
  });

  it("tells which of the person's orgs a space or thread is in", async () => {
    const { api, ada, orgId, generalId, signUp } = await teamOrg();
    const thread = (await (
      await api("POST", `/spaces/${generalId}/threads`, ada.cookie, { text: "// hi" }, orgId)
    ).json()) as { id: string };
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");

    expect(await (await api("GET", `/locate?space=${generalId}`, ada.cookie)).json()).toEqual({
      orgId,
    });
    expect(await (await api("GET", `/locate?thread=${thread.id}`, ada.cookie)).json()).toEqual({
      orgId,
    });
    expect((await api("GET", `/locate?space=${generalId}`, hedy.cookie)).status).toBe(404);
  });
});

describe("org invites", () => {
  it("lets in only the account with the invite's email, once", async () => {
    const workspace = await teamOrg();
    const { app, ada, signUp, generalId } = workspace;
    const token = await inviteToken(workspace, ada, "Grace@Example.com");
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");

    const preview = await app.request(`/api/org-invites/${token}`);
    expect(await preview.json()).toMatchObject({
      orgName: "Analytical Engines",
      inviterName: "Ada Lovelace",
      email: "grace@example.com",
      status: "ok",
    });
    const wrong = await accept(workspace, hedy, token);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({
      error: "This invite is for g***@example.com",
      reason: "wrong_account",
    });
    const joined = await accept(workspace, grace, token);
    expect(await joined.json()).toEqual({ orgId: workspace.orgId, spaceId: generalId });
    const spaces = await spacesOf(workspace, { ...grace, orgId: workspace.orgId });
    expect(spaces).toEqual([
      expect.objectContaining({ name: "Grace Hopper's Space", kind: "personal", role: "owner" }),
      expect.objectContaining({ id: generalId, role: "messager" }),
    ]);
    // Used once; Grace opening it again just goes to the org.
    expect((await accept(workspace, grace, token)).status).toBe(200);
    const again = await inviteToken(workspace, ada, "hedy@example.com");
    expect((await accept(workspace, hedy, again)).status).toBe(200);
  });

  it("refuses an expired or revoked link and inviting a current member", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, db, signUp } = workspace;
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");

    const member = await api(
      "POST",
      "/org/invites",
      ada.cookie,
      { email: "grace@example.com", role: "member" },
      ada.orgId,
    );
    expect(member.status).toBe(409);
    const expired = await inviteToken(workspace, ada, "hedy@example.com");
    db.update(schema.orgInvite)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    expect(await (await accept(workspace, hedy, expired)).json()).toMatchObject({
      reason: "expired",
    });
    await inviteToken(workspace, ada, "hedy@example.com");
    const list = (await (
      await api("GET", "/org/people?status=invited", ada.cookie, undefined, ada.orgId)
    ).json()) as Page<OrgPerson>;
    const pending = list.items[0]!;
    if (pending.kind !== "invite") throw new Error("expected an invite");
    expect(
      (await api("DELETE", `/org/invites/${pending.id}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(200);
    // Members see the members, but not the invites.
    const seen = (await (
      await api("GET", "/org/members", grace.cookie, undefined, grace.orgId)
    ).json()) as Page<OrgMember>;
    expect(seen.items.map((m) => m.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);
    const asMember = (await (
      await api("GET", "/org/people", grace.cookie, undefined, grace.orgId)
    ).json()) as Page<OrgPerson>;
    expect(asMember.items.map((person) => person.kind)).toEqual(["member", "member"]);
    expect(
      (
        await api(
          "POST",
          "/org/invites",
          grace.cookie,
          { email: "x@example.com", role: "member" },
          grace.orgId,
        )
      ).status,
    ).toBe(403);
  });

  it("lets a former member join again as the same person", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, generalId } = workspace;
    await api(
      "POST",
      `/spaces/${generalId}/threads`,
      grace.cookie,
      { text: "// hello" },
      grace.orgId,
    );
    expect(
      (await api("DELETE", `/org/members/${grace.userId}`, ada.cookie, undefined, ada.orgId))
        .status,
    ).toBe(200);
    const threads = (await (
      await api("GET", `/spaces/${generalId}/threads`, ada.cookie, undefined, ada.orgId)
    ).json()) as { id: string }[];
    const thread = (await (
      await api("GET", `/threads/${threads[0]!.id}`, ada.cookie, undefined, ada.orgId)
    ).json()) as ThreadDetail;
    expect(thread.events[0]?.actor).toEqual({
      kind: "user",
      userId: grace.userId,
      name: "Grace Hopper",
      former: true,
    });

    const token = await inviteToken(workspace, ada, "grace@example.com");
    expect((await accept(workspace, grace, token)).status).toBe(200);
    const after = (await (
      await api("GET", `/threads/${threads[0]!.id}`, ada.cookie, undefined, ada.orgId)
    ).json()) as ThreadDetail;
    expect(after.events[0]?.actor).toEqual({
      kind: "user",
      userId: grace.userId,
      name: "Grace Hopper",
    });
  });
});

describe("org members", () => {
  it("keeps at least one owner", async () => {
    const { api, ada, grace } = await withGrace();

    expect(
      (await api("PATCH", `/org/members/${ada.userId}`, ada.cookie, { role: "member" }, ada.orgId))
        .status,
    ).toBe(409);
    expect(
      (await api("DELETE", `/org/members/${ada.userId}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(409);
    expect(
      (await api("PATCH", `/org/members/${grace.userId}`, ada.cookie, { role: "owner" }, ada.orgId))
        .status,
    ).toBe(200);
    expect(
      (await api("PATCH", `/org/members/${ada.userId}`, ada.cookie, { role: "member" }, ada.orgId))
        .status,
    ).toBe(200);
  });

  it("removing a member takes away their space roles and waiting messages", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, db, generalId, orgId, spaceStore } = workspace;
    const engines = await newSpace(workspace, ada, "Engines");
    expect(
      (
        await setMember(workspace, ada, engines.id, {
          kind: "user",
          id: grace.userId,
          role: "messager",
        })
      ).status,
    ).toBe(200);
    // Ada's thread is busy replying; Grace's message waits for it.
    const thread = (await (
      await api("POST", `/spaces/${generalId}/threads`, ada.cookie, { text: "Start" }, orgId)
    ).json()) as { id: string };
    expect(
      (
        await api(
          "POST",
          `/threads/${thread.id}/messages`,
          grace.cookie,
          { text: "Wait for me", mode: "queue" },
          orgId,
        )
      ).status,
    ).toBe(202);

    expect(
      (await api("DELETE", `/org/members/${grace.userId}`, ada.cookie, undefined, orgId)).status,
    ).toBe(200);

    expect(
      db
        .select()
        .from(schema.spaceMember)
        .all()
        .filter(
          (row) => row.subjectId === grace.userId && spaceStore.find(row.spaceId)?.orgId === orgId,
        ),
    ).toEqual([]);
    const detail = (await (
      await api("GET", `/threads/${thread.id}`, ada.cookie, undefined, orgId)
    ).json()) as ThreadDetail;
    expect(transcriptOf(detail.events).pending).toEqual([]);
    expect(detail.events.map((event) => event.type)).toContain("message.dropped");
    expect((await api("GET", "/spaces", grace.cookie, undefined, orgId)).status).toBe(404);
  });
});

describe("roles in a team org's spaces", () => {
  it("takes the highest of a person's own role, their groups' and everyone's", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, generalId } = workspace;
    const engines = await newSpace(workspace, ada, "Engines");
    const roleOf = async (spaceId: string) =>
      (await spacesOf(workspace, grace)).find((space) => space.id === spaceId)?.role ?? null;

    expect(await roleOf(engines.id)).toBeNull();
    expect(await roleOf(generalId)).toBe("messager");
    const looms = await newGroup(workspace, ada, "Looms", [grace.userId]);
    await setMember(workspace, ada, engines.id, { kind: "group", id: looms, role: "viewer" });
    expect(await roleOf(engines.id)).toBe("viewer");
    await setMember(workspace, ada, engines.id, {
      kind: "user",
      id: grace.userId,
      role: "messager",
    });
    expect(await roleOf(engines.id)).toBe("messager");
    await setMember(workspace, ada, engines.id, { kind: "group", id: looms, role: "owner" });
    expect(await roleOf(engines.id)).toBe("owner");
    await api("PUT", `/spaces/${generalId}/everyone`, ada.cookie, { role: "viewer" }, ada.orgId);
    expect(await roleOf(generalId)).toBe("viewer");
    await api("PUT", `/spaces/${generalId}/everyone`, ada.cookie, { role: null }, ada.orgId);
    expect(await roleOf(generalId)).toBeNull();

    const members = (await (
      await api("GET", `/spaces/${engines.id}/members`, ada.cookie, undefined, ada.orgId)
    ).json()) as SpaceMembers;
    expect(members.grants.items).toEqual([
      expect.objectContaining({
        name: "Ada Lovelace",
        role: "owner",
        effective: "owner",
        via: null,
      }),
      expect.objectContaining({
        name: "Grace Hopper",
        role: "messager",
        effective: "owner",
        via: "Looms",
        coveredBy: [{ name: "Looms", role: "owner" }],
      }),
      expect.objectContaining({ kind: "group", name: "Looms", role: "owner", memberCount: 1 }),
    ]);
  });

  it("lets org owners manage shared spaces they are not in, but read them only once they add themselves", async () => {
    const workspace = await withGrace();
    const { api, ada, grace } = workspace;
    const secret = await newSpace(workspace, grace, "Secret");
    const thread = (await (
      await api(
        "POST",
        `/spaces/${secret.id}/threads`,
        grace.cookie,
        { text: "// plans" },
        grace.orgId,
      )
    ).json()) as { id: string };

    expect((await spacesOf(workspace, ada)).find((space) => space.id === secret.id)).toMatchObject({
      role: null,
      manage: true,
    });
    expect(
      (await api("GET", `/spaces/${secret.id}/members`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(200);
    expect(
      (await api("PATCH", `/spaces/${secret.id}`, ada.cookie, { name: "Plans" }, ada.orgId)).status,
    ).toBe(200);
    expect(
      (await api("GET", `/spaces/${secret.id}/threads`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(403);
    expect(
      (await api("GET", `/threads/${thread.id}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(404);
    // Grace's own space stays hers alone.
    const graces = (await spacesOf(workspace, grace)).find((space) => space.kind === "personal")!;
    expect((await spacesOf(workspace, ada)).map((space) => space.id)).not.toContain(graces.id);

    expect(
      (
        await api(
          "PUT",
          `/spaces/${secret.id}/members`,
          ada.cookie,
          { kind: "user", id: ada.userId, role: "viewer" },
          ada.orgId,
        )
      ).status,
    ).toBe(200);
    expect(
      (await api("GET", `/threads/${thread.id}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(200);
  });

  it("follows the org's setting for who may make spaces", async () => {
    const workspace = await withGrace();
    const { api, ada, grace } = workspace;

    expect(
      (await api("PATCH", "/org/settings", grace.cookie, { spaceCreation: "owners" }, grace.orgId))
        .status,
    ).toBe(403);
    expect(
      (await api("PATCH", "/org/settings", ada.cookie, { spaceCreation: "owners" }, ada.orgId))
        .status,
    ).toBe(200);
    expect((await api("POST", "/spaces", grace.cookie, { name: "Mine" }, grace.orgId)).status).toBe(
      403,
    );
    expect((await api("POST", "/spaces", ada.cookie, { name: "Ours" }, ada.orgId)).status).toBe(
      200,
    );
  });

  it("gives no member a space of their own when the org turns that off", async () => {
    const workspace = await teamOrg();
    const { api, ada, signUp } = workspace;
    await api("PATCH", "/org/settings", ada.cookie, { memberSpaces: false }, ada.orgId);
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const token = await inviteToken(workspace, ada, "grace@example.com");
    await accept(workspace, grace, token);

    const spaces = await spacesOf(workspace, { ...grace, orgId: workspace.orgId });
    expect(spaces.map((space) => space.name)).toEqual(["General"]);
  });

  it("refuses roles in a private space", async () => {
    const workspace = await withGrace();
    const mine = (await spacesOf(workspace, workspace.ada)).find(
      (space) => space.kind === "personal",
    )!;

    const res = await setMember(workspace, workspace.ada, mine.id, {
      kind: "user",
      id: workspace.grace.userId,
      role: "viewer",
    });
    expect(res.status).toBe(409);
  });
});

describe("renaming and deleting a team org", () => {
  it("lets owners rename it", async () => {
    const { api, ada, grace } = await withGrace();

    expect((await api("PATCH", "/org", grace.cookie, { name: "Mine" }, grace.orgId)).status).toBe(
      403,
    );
    expect((await api("PATCH", "/org", ada.cookie, { name: "Engines" }, ada.orgId)).status).toBe(
      200,
    );
    expect(
      await (await api("GET", "/me", grace.cookie, undefined, grace.orgId)).json(),
    ).toMatchObject({ org: { name: "Engines" } });
  });

  it("deletes everything in it and leaves other orgs be", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, db, generalId, orgId, signUp } = workspace;
    const { orgs } = (await (await api("GET", "/orgs", ada.cookie)).json()) as {
      orgs: { id: string; kind: string }[];
    };
    const own = orgs.find((org) => org.kind === "personal")!.id;
    const [personal] = await spacesOf(workspace, { ...ada, orgId: own });
    await api("POST", `/spaces/${personal!.id}/threads`, ada.cookie, { text: "// mine" }, own);
    await newGroup(workspace, ada, "Looms", [grace.userId]);
    const thread = (await (
      await api("POST", `/spaces/${generalId}/threads`, ada.cookie, { text: "Hello" }, orgId)
    ).json()) as { id: string };
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
    await api("POST", `/threads/${thread.id}/invites`, ada.cookie, { accessFor: "1d" }, orgId);
    await inviteToken(workspace, ada, "joan@example.com");
    db.insert(schema.connection)
      .values({
        id: "c1",
        organizationId: orgId,
        provider: "openai",
        authKind: "api_key",
        account: "sk-…1",
      })
      .run();
    void hedy;

    expect((await api("DELETE", "/org", grace.cookie, undefined, orgId)).status).toBe(403);
    expect((await api("DELETE", "/org", ada.cookie, undefined, orgId)).status).toBe(200);

    expect(
      db
        .select()
        .from(schema.organization)
        .all()
        .map((org) => org.kind),
    ).toEqual(["personal", "personal", "personal"]);
    for (const table of [
      schema.orgGroup,
      schema.orgInvite,
      schema.threadInvite,
      schema.connection,
    ]) {
      expect(db.select().from(table).all()).toEqual([]);
    }
    expect(
      db
        .select()
        .from(schema.space)
        .all()
        .every((space) => space.organizationId !== orgId),
    ).toBe(true);
    expect(
      db
        .select()
        .from(schema.member)
        .all()
        .every((m) => m.organizationId !== orgId),
    ).toBe(true);
    expect(
      db
        .select()
        .from(schema.thread)
        .all()
        .map((t) => t.title),
    ).toEqual(["// mine"]);
    // Ada and Grace go on in their own orgs.
    expect((await api("GET", "/spaces", ada.cookie)).status).toBe(200);
    expect((await api("GET", "/spaces", grace.cookie, undefined, orgId)).status).toBe(404);
  });

  it("refuses to delete a personal org", async () => {
    const { api, signUp } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");

    expect((await api("DELETE", "/org", ada.cookie)).status).toBe(403);
  });
});

describe("the org's spaces for its owners", () => {
  it("lists every space, private ones with their person, and only to owners", async () => {
    const workspace = await withGrace();
    const { api, ada, grace } = workspace;
    await newSpace(workspace, grace, "Compilers");

    const res = await api("GET", "/org/spaces", ada.cookie, undefined, ada.orgId);
    const list = (await res.json()) as Page<SpaceBody & { ownerName: string }>;
    expect(
      list.items.map((space) => [space.name, space.kind, space.ownerName, space.role]),
    ).toEqual([
      ["Ada Lovelace's Space", "personal", "Ada Lovelace", "owner"],
      ["Compilers", "shared", "Grace Hopper", null],
      ["General", "shared", "Ada Lovelace", "owner"],
      ["Grace Hopper's Space", "personal", "Grace Hopper", null],
    ]);
    expect((await api("GET", "/org/spaces", grace.cookie, undefined, grace.orgId)).status).toBe(
      403,
    );
  });

  it("replaces an unused invite when the same email is invited again", async () => {
    const workspace = await teamOrg();
    const first = await inviteToken(workspace, workspace.ada, "grace@example.com");
    await inviteToken(workspace, workspace.ada, "Grace@example.com");
    const grace = await workspace.signUp("Grace Hopper", "grace@example.com");

    const list = (await (
      await workspace.api(
        "GET",
        "/org/people?status=invited",
        workspace.ada.cookie,
        undefined,
        workspace.orgId,
      )
    ).json()) as Page<OrgPerson>;
    expect(list.total).toBe(1);
    expect(await (await accept(workspace, grace, first)).json()).toMatchObject({
      reason: "revoked",
    });
  });
});

describe("naming spaces", () => {
  it("names a member's first space for its person, to them and to everyone else", async () => {
    const workspace = await withGrace();
    const { api, ada, grace, db } = workspace;

    const own = (await spacesOf(workspace, grace)).find((space) => space.kind === "personal");
    expect(own?.name).toBe("Grace Hopper's Space");
    const all = (
      (await (
        await api("GET", "/org/spaces", ada.cookie, undefined, ada.orgId)
      ).json()) as Page<SpaceBody>
    ).items;
    expect(all.filter((space) => space.kind === "personal").map((space) => space.name)).toEqual([
      "Ada Lovelace's Space",
      "Grace Hopper's Space",
    ]);
    // The name follows the person's.
    db.update(schema.user)
      .set({ name: "Grace B. Hopper" })
      .where(eq(schema.user.id, grace.userId))
      .run();
    const renamed = (await spacesOf(workspace, grace)).find((space) => space.kind === "personal");
    expect(renamed?.name).toBe("Grace B. Hopper's Space");
  });

  it("names only an untouched first space for its person", () => {
    const first = { name: FIRST_SPACE_NAME, kind: "personal" as const, primary: true };
    expect(spaceNameFor(first, "Grace Hopper")).toBe("Grace Hopper's Space");
    expect(spaceNameFor({ ...first, name: "Notes" }, "Grace Hopper")).toBe("Notes");
    expect(spaceNameFor({ ...first, kind: "shared" }, "Grace Hopper")).toBe(FIRST_SPACE_NAME);
  });
});

describe("the org's people", () => {
  it("lists invites not yet used before the members, for owners, and says why a role is locked", async () => {
    const workspace = await withGrace();
    const { ada } = workspace;
    await inviteToken(workspace, ada, "joan@example.com", "owner");

    const res = await workspace.api("GET", "/org/people", ada.cookie, undefined, ada.orgId);
    const people = (await res.json()) as Page<OrgPerson>;
    expect(
      people.items.map((person) =>
        person.kind === "invite"
          ? ["invite", person.email, person.role]
          : person.kind === "group"
            ? ["group", person.name, person.role]
            : ["member", person.name, person.locked],
      ),
    ).toEqual([
      ["invite", "joan@example.com", "owner"],
      ["member", "Ada Lovelace", "self"],
      ["member", "Grace Hopper", null],
    ]);
    const owners = (await (
      await workspace.api(
        "GET",
        "/org/people?role=owner&status=member",
        ada.cookie,
        undefined,
        ada.orgId,
      )
    ).json()) as Page<OrgPerson>;
    expect(owners.total).toBe(1);
  });
});

describe("long lists", () => {
  // Ada's org with 7 more members, named so they sort as Member 01, Member 02…
  async function crowded() {
    const workspace = await withGrace();
    const { db, ada, directory } = workspace;
    for (let n = 1; n <= 7; n += 1) {
      const id = `member-${n}`;
      db.insert(schema.user)
        .values({ id, name: `Member ${String(n).padStart(2, "0")}`, email: `m${n}@example.com` })
        .run();
      await directory.addMember(ada.orgId, id, n % 2 ? "member" : "owner");
    }
    return workspace;
  }

  async function page(workspace: Workspace, who: Person, path: string) {
    const res = await workspace.api("GET", path, who.cookie, undefined, who.orgId);
    expect(res.status).toBe(200);
    return (await res.json()) as Page<{ name: string }>;
  }

  it("pages the members by name with a stable cursor and the total", async () => {
    const workspace = await crowded();
    const { ada, db } = workspace;

    const first = await page(workspace, ada, "/org/members?limit=4");
    expect(first.total).toBe(9);
    expect(first.items.map((m) => m.name)).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
      "Member 01",
      "Member 02",
    ]);
    // Someone sorting before the cursor joins meanwhile; the next page goes on where it left off.
    db.insert(schema.user).values({ id: "early", name: "Aaron", email: "a@example.com" }).run();
    await workspace.directory.addMember(ada.orgId, "early", "member");
    const second = await page(
      workspace,
      ada,
      `/org/members?limit=4&cursor=${(first as { nextCursor: string }).nextCursor}`,
    );
    expect(second.items.map((m) => m.name)).toEqual([
      "Member 03",
      "Member 04",
      "Member 05",
      "Member 06",
    ]);
    expect(second.total).toBe(10);
  });

  it("searches the members by name or email and narrows them to a role", async () => {
    const workspace = await crowded();
    const { ada } = workspace;

    expect((await page(workspace, ada, "/org/members?q=GRACE")).items.map((m) => m.name)).toEqual([
      "Grace Hopper",
    ]);
    expect((await page(workspace, ada, "/org/members?q=m3%40")).items.map((m) => m.name)).toEqual([
      "Member 03",
    ]);
    const owners = await page(workspace, ada, "/org/members?role=owner");
    expect(owners.total).toBe(4);
    expect(owners.items.map((m) => m.name)).toEqual([
      "Ada Lovelace",
      "Member 02",
      "Member 04",
      "Member 06",
    ]);
    // A % is text, not a wildcard.
    expect((await page(workspace, ada, "/org/members?q=%25")).total).toBe(0);
  });

  it("searches, narrows and pages the org's spaces", async () => {
    const workspace = await withGrace();
    const { ada, api, generalId } = workspace;
    for (const name of ["Alpha", "Beta", "Gamma"]) await newSpace(workspace, ada, name);
    await api("PUT", `/spaces/${generalId}/everyone`, ada.cookie, { role: "viewer" }, ada.orgId);

    const shared = await page(workspace, ada, "/org/spaces?kind=shared&limit=2");
    expect(shared.total).toBe(4);
    expect(shared.items.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    const rest = await page(
      workspace,
      ada,
      `/org/spaces?kind=shared&limit=2&cursor=${(shared as { nextCursor: string }).nextCursor}`,
    );
    expect(rest.items.map((s) => s.name)).toEqual(["Gamma", "General"]);
    expect((rest as { nextCursor: string | null }).nextCursor).toBeNull();
    expect(
      (await page(workspace, ada, "/org/spaces?everyone=viewer")).items.map((s) => s.name),
    ).toEqual(["General"]);
    expect((await page(workspace, ada, "/org/spaces?everyone=none")).total).toBe(3);
    // A person's first space is found by the name everyone sees.
    expect((await page(workspace, ada, "/org/spaces?q=hopper")).items.map((s) => s.name)).toEqual([
      "Grace Hopper's Space",
    ]);
  });
});

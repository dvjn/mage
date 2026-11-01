import { describe, expect, it, onTestFinished } from "vite-plus/test";

import type { Page } from "@/shared/paging.ts";
import { type OrgSpace, TRASH_DAYS, type TrashedSpaceSummary } from "@/shared/spaces.ts";

import { ARCHIVE_DAYS } from "@/server/spaces/service.ts";
import { type SpaceBody, type ThreadBody, setup } from "@/server/testing/workspace.ts";

type Workspace = ReturnType<typeof setup>;
type Person = { userId: string; orgId: string; cookie: string };

// Ada's team org with its General space, and Grace in it as a member.
async function teamOrg() {
  const workspace = setup();
  workspace.org.defaultModel = "codex/gpt-big";
  const { api, signUp } = workspace;
  const signedUpAda = await signUp("Ada Lovelace", "ada@example.com");
  const res = await api("POST", "/orgs", signedUpAda.cookie, { name: "Analytical Engines" });
  const { orgId, spaceId: generalId } = (await res.json()) as { orgId: string; spaceId: string };
  const ada = { ...signedUpAda, orgId };
  const grace = { ...(await signUp("Grace Hopper", "grace@example.com")), orgId };
  await invite(workspace, ada, grace, "grace@example.com");
  return { ...workspace, ada, grace, orgId, generalId };
}

async function invite(workspace: Workspace, by: Person, who: { cookie: string }, email: string) {
  const res = await workspace.api(
    "POST",
    "/org/invites",
    by.cookie,
    { email, role: "member" },
    by.orgId,
  );
  const { url } = (await res.json()) as { url: string };
  const token = url.split("/join/")[1]!;
  const joined = await workspace.api("POST", "/org-invites/accept", who.cookie, { token });
  expect(joined.status).toBe(200);
}

async function allow(workspace: Workspace, who: Person, memberSpaces: boolean) {
  const res = await workspace.api(
    "PATCH",
    "/org/settings",
    who.cookie,
    { memberSpaces },
    who.orgId,
  );
  expect(res.status).toBe(200);
}

function createMine(workspace: Workspace, who: Person) {
  return workspace.api("POST", "/spaces/mine", who.cookie, undefined, who.orgId);
}

async function spacesOf(workspace: Workspace, who: Person) {
  return (await (
    await workspace.api("GET", "/spaces", who.cookie, undefined, who.orgId)
  ).json()) as (SpaceBody & { archived: boolean })[];
}

async function threadIn(workspace: Workspace, who: Person, spaceId: string, text: string) {
  const res = await workspace.api(
    "POST",
    `/spaces/${spaceId}/threads`,
    who.cookie,
    { text },
    who.orgId,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ThreadBody;
}

function post(workspace: Workspace, who: Person, threadId: string, text: string) {
  return workspace.api("POST", `/threads/${threadId}/messages`, who.cookie, { text }, who.orgId);
}

// Grace's own space with one thread in it, while the org allows them.
async function graceWithSpace() {
  const workspace = await teamOrg();
  await allow(workspace, workspace.ada, true);
  const res = await createMine(workspace, workspace.grace);
  expect(res.status).toBe(200);
  const mine = (await res.json()) as SpaceBody;
  const thread = await threadIn(workspace, workspace.grace, mine.id, "// notes");
  return { ...workspace, mine, thread };
}

describe("personal spaces in team orgs", () => {
  it("start off in a new team org, and none is made on creating or joining it", async () => {
    const workspace = await teamOrg();
    const { api, ada, grace } = workspace;

    const settings = await api("GET", "/org/settings", ada.cookie, undefined, ada.orgId);
    expect(await settings.json()).toMatchObject({ memberSpaces: false });
    expect((await spacesOf(workspace, ada)).map((space) => space.name)).toEqual(["General"]);
    expect((await spacesOf(workspace, grace)).map((space) => space.name)).toEqual(["General"]);
  });

  it("are made by each member once, only while the org allows them", async () => {
    const workspace = await teamOrg();
    const { ada, grace } = workspace;

    expect((await createMine(workspace, grace)).status).toBe(403);
    await allow(workspace, ada, true);
    const made = await createMine(workspace, grace);
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({
      name: "Personal Space",
      kind: "personal",
      role: "owner",
      archived: false,
    });
    expect((await createMine(workspace, grace)).status).toBe(409);
    // A personal org has its own space already.
    expect((await createMine(workspace, { ...grace, orgId: "" })).status).toBe(409);
    // Only Grace sees hers.
    expect((await spacesOf(workspace, ada)).map((space) => space.name)).toEqual(["General"]);
  });

  it("are archived while the org turns them off: read-only to their person, hidden from search, and restored when turned on", async () => {
    const workspace = await graceWithSpace();
    const { api, ada, grace, mine, thread } = workspace;

    await allow(workspace, ada, false);
    const listed = (await spacesOf(workspace, grace)).find((space) => space.id === mine.id);
    expect(listed).toMatchObject({ archived: true, role: "owner", manage: false });
    const detail = await api("GET", `/threads/${thread.id}`, grace.cookie, undefined, grace.orgId);
    expect(await detail.json()).toMatchObject({ archived: true });
    const refused = await post(workspace, grace, thread.id, "more");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "This space is archived" });
    expect(
      (await api("POST", `/spaces/${mine.id}/threads`, grace.cookie, {}, grace.orgId)).status,
    ).toBe(403);
    expect(
      (await api("PATCH", `/threads/${thread.id}`, grace.cookie, { title: "x" }, grace.orgId))
        .status,
    ).toBe(403);
    const search = await api("GET", "/threads/search?q=", grace.cookie, undefined, grace.orgId);
    expect(((await search.json()) as { id: string }[]).map((found) => found.id)).not.toContain(
      thread.id,
    );
    // Nothing about the space was changed, so it is all back once allowed again.
    await allow(workspace, ada, true);
    expect((await spacesOf(workspace, grace)).find((space) => space.id === mine.id)).toMatchObject({
      archived: false,
      manage: true,
    });
    expect((await post(workspace, grace, thread.id, "more")).status).toBe(202);
    const again = await api("GET", "/threads/search?q=", grace.cookie, undefined, grace.orgId);
    expect(((await again.json()) as { id: string }[]).map((found) => found.id)).toContain(
      thread.id,
    );
  });

  it("stop the agent when archived, and start no run there", async () => {
    const workspace = await graceWithSpace();
    const { ada, grace, thread, model, worker, db } = workspace;
    const runs = () =>
      db.all<{ status: string }>(`select status from run where thread_id = '${thread.id}'`);
    // Its run waits, unclaimed, for a worker.
    expect((await post(workspace, grace, thread.id, "Hello")).status).toBe(202);
    expect(runs()).toEqual([{ status: "queued" }]);

    await allow(workspace, ada, false);
    worker.start();
    onTestFinished(() => worker.stop());
    await worker.idle();
    expect(runs()).toEqual([{ status: "cancelled" }]);
    expect(model.calls).toHaveLength(0);

    await allow(workspace, ada, true);
    expect((await post(workspace, grace, thread.id, "Again")).status).toBe(202);
    const call = await model.next();
    call.reply("Hello.");
    await worker.idle();
    expect(runs().at(-1)).toEqual({ status: "completed" });
  });

  it("let their person move a thread out of an archived space to one they can post in", async () => {
    const workspace = await graceWithSpace();
    const { api, ada, grace, thread, generalId } = workspace;
    const closed = (await (
      await api("POST", "/spaces", ada.cookie, { name: "Closed" }, ada.orgId)
    ).json()) as SpaceBody;
    await api(
      "PUT",
      `/spaces/${closed.id}/members`,
      ada.cookie,
      { kind: "user", id: grace.userId, role: "viewer" },
      ada.orgId,
    );
    await allow(workspace, ada, false);

    const move = (spaceId: string, who: Person = grace) =>
      api("POST", `/threads/${thread.id}/move`, who.cookie, { spaceId }, who.orgId);
    expect((await move(closed.id)).status).toBe(403);
    expect((await move(generalId, ada)).status).toBe(404);
    const moved = await move(generalId);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ spaceId: generalId, folderId: null });
    expect(
      (await api("GET", `/threads/${thread.id}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(200);
    expect((await post(workspace, grace, thread.id, "out")).status).toBe(202);
  });

  it("are archived while their person is out of the org, and theirs again when they rejoin", async () => {
    const workspace = await graceWithSpace();
    const { api, ada, grace, mine } = workspace;

    expect(
      (await api("DELETE", `/org/members/${grace.userId}`, ada.cookie, undefined, ada.orgId))
        .status,
    ).toBe(200);
    const catalog = (await (
      await api("GET", "/org/spaces?kind=personal", ada.cookie, undefined, ada.orgId)
    ).json()) as Page<OrgSpace>;
    expect(catalog.items).toEqual([
      expect.objectContaining({ id: mine.id, archived: true, threadCount: 1, role: null }),
    ]);

    await invite(workspace, ada, grace, "grace@example.com");
    expect((await spacesOf(workspace, grace)).find((space) => space.id === mine.id)).toMatchObject({
      role: "owner",
      archived: false,
    });
  });

  it("go to trash with their threads, by their person or by the org's owners who never read them", async () => {
    const workspace = await graceWithSpace();
    const { api, ada, grace, mine, thread } = workspace;

    expect(
      (await api("GET", `/spaces/${mine.id}/threads`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(404);
    expect(
      (await api("GET", `/threads/${thread.id}`, ada.cookie, undefined, ada.orgId)).status,
    ).toBe(404);
    expect((await remove(workspace, ada, mine.id)).status).toBe(200);

    // Gone from every view: hers, the org's, and the thread itself.
    expect((await spacesOf(workspace, grace)).map((space) => space.id)).not.toContain(mine.id);
    expect((await catalogOf(workspace, ada)).map((space) => space.id)).not.toContain(mine.id);
    expect(
      (await api("GET", `/threads/${thread.id}`, grace.cookie, undefined, grace.orgId)).status,
    ).toBe(404);
    expect((await post(workspace, grace, thread.id, "more")).status).toBe(404);
    // In the trash of the org's owners, but not of Grace, who did not put it there.
    expect(await trashOf(workspace, ada)).toEqual([
      expect.objectContaining({
        id: mine.id,
        name: "Grace Hopper's Space",
        ownerName: "Grace Hopper",
        trashedByName: "Ada Lovelace",
        threadCount: 1,
      }),
    ]);
    expect(await trashOf(workspace, grace)).toEqual([]);
    expect((await restore(workspace, grace, mine.id)).status).toBe(404);

    // Restored, it is hers as it was.
    expect((await restore(workspace, ada, mine.id)).status).toBe(200);
    expect((await spacesOf(workspace, grace)).find((space) => space.id === mine.id)).toMatchObject({
      role: "owner",
      archived: false,
    });
    expect((await post(workspace, grace, thread.id, "more")).status).toBe(202);

    // Archived, she may still put it in trash, and then delete it for good.
    await allow(workspace, ada, false);
    expect((await remove(workspace, grace, mine.id)).status).toBe(200);
    expect((await trashOf(workspace, grace)).map((space) => space.name)).toEqual([
      "Personal Space",
    ]);
    expect(
      (await api("DELETE", `/spaces/trash/${mine.id}`, grace.cookie, undefined, grace.orgId))
        .status,
    ).toBe(200);
    expect(workspace.spaceStore.find(mine.id)).toBeNull();
    expect(workspace.threadStore.find(thread.id)).toBeNull();
  });

  it("shut out their threads' guests while in trash", async () => {
    const workspace = await graceWithSpace();
    const { api, grace, mine, thread, signUp } = workspace;
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
    const link = await api(
      "POST",
      `/threads/${thread.id}/invites`,
      grace.cookie,
      { accessFor: "1d" },
      grace.orgId,
    );
    const token = ((await link.json()) as { url: string }).url.split("/invite/")[1]!;
    expect((await api("POST", "/invites/accept", hedy.cookie, { token })).status).toBe(200);
    const shared = async () =>
      ((await (await api("GET", "/shared-threads", hedy.cookie)).json()) as { id: string }[]).map(
        (found) => found.id,
      );
    expect(await shared()).toEqual([thread.id]);

    await remove(workspace, grace, mine.id);
    expect((await api("GET", `/threads/${thread.id}`, hedy.cookie)).status).toBe(404);
    expect(await shared()).toEqual([]);
  });

  it("are not restored over the one their person made since", async () => {
    const workspace = await graceWithSpace();
    const { ada, grace, mine } = workspace;

    await remove(workspace, grace, mine.id);
    expect((await createMine(workspace, grace)).status).toBe(200);
    expect((await restore(workspace, ada, mine.id)).status).toBe(409);
  });

  it("stop the agent when put in trash", async () => {
    const workspace = await graceWithSpace();
    const { grace, mine, thread, model, worker, db } = workspace;
    expect((await post(workspace, grace, thread.id, "Hello")).status).toBe(202);

    await remove(workspace, grace, mine.id);
    worker.start();
    onTestFinished(() => worker.stop());
    await worker.idle();
    expect(db.all(`select status from run where thread_id = '${thread.id}'`)).toEqual([
      { status: "cancelled" },
    ]);
    expect(model.calls).toHaveLength(0);
  });

  it("leave trash for good after its days, and leave alone the rest", async () => {
    const workspace = await graceWithSpace();
    const { ada, grace, mine, spaces, spaceStore, generalId } = workspace;

    await remove(workspace, grace, mine.id);
    expect(spaces.sweep(daysOn(TRASH_DAYS - 1))).toBe(0);
    expect(spaceStore.find(mine.id)).not.toBeNull();
    expect(spaces.sweep(daysOn(TRASH_DAYS + 1))).toBe(1);
    expect(spaceStore.find(mine.id)).toBeNull();
    expect(spaceStore.find(generalId)).not.toBeNull();
    expect((await spacesOf(workspace, ada)).length).toBeGreaterThan(0);
  });

  it("are deleted once archived for long enough, counted from when they were archived", async () => {
    const workspace = await graceWithSpace();
    const { api, ada, grace, mine, spaces, spaceStore } = workspace;
    const archivedAt = () => spaceStore.find(mine.id)?.archivedAt ?? null;

    // Turned off, the countdown starts; on again, it stops.
    expect(archivedAt()).toBeNull();
    await allow(workspace, ada, false);
    expect(archivedAt()).not.toBeNull();
    await allow(workspace, ada, true);
    expect(archivedAt()).toBeNull();
    expect(spaces.sweep(daysOn(ARCHIVE_DAYS + 1))).toBe(0);

    // Out of the org, it starts again; rejoining stops it.
    await api("DELETE", `/org/members/${grace.userId}`, ada.cookie, undefined, ada.orgId);
    expect(archivedAt()).not.toBeNull();
    await invite(workspace, ada, grace, "grace@example.com");
    expect(archivedAt()).toBeNull();

    // Archived for longer than its days, it goes.
    await allow(workspace, ada, false);
    expect(spaces.sweep(daysOn(ARCHIVE_DAYS - 1))).toBe(0);
    expect(spaces.sweep(daysOn(ARCHIVE_DAYS + 1))).toBe(1);
    expect(spaceStore.find(mine.id)).toBeNull();
  });

  it("start their countdown on a sweep when archived without one noted", async () => {
    const workspace = await graceWithSpace();
    const { ada, mine, spaces, spaceStore, settingStore } = workspace;

    // Turned off without the app being told, as before the countdown was kept.
    settingStore.setTeamSettings(ada.orgId, { memberSpaces: false });
    const at = daysOn(ARCHIVE_DAYS + 1);
    expect(spaces.sweep(at)).toBe(0);
    expect(spaceStore.find(mine.id)?.archivedAt).toEqual(at);
  });
});

function remove(workspace: Workspace, who: Person, spaceId: string) {
  return workspace.api("DELETE", `/spaces/${spaceId}`, who.cookie, undefined, who.orgId);
}

function restore(workspace: Workspace, who: Person, spaceId: string) {
  return workspace.api(
    "POST",
    `/spaces/trash/${spaceId}/restore`,
    who.cookie,
    undefined,
    who.orgId,
  );
}

async function trashOf(workspace: Workspace, who: Person) {
  const res = await workspace.api("GET", "/spaces/trash", who.cookie, undefined, who.orgId);
  expect(res.status).toBe(200);
  return (await res.json()) as TrashedSpaceSummary[];
}

async function catalogOf(workspace: Workspace, who: Person) {
  const res = await workspace.api("GET", "/org/spaces", who.cookie, undefined, who.orgId);
  return ((await res.json()) as Page<OrgSpace>).items;
}

// The time the days from now.
function daysOn(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Skills the agent learns for a space: saved by a call, once per call, under a name no built-in,
// org or person's skill has; replaced only when the call says to update, the old one kept retired;
// listed with the space's own in one read, and edited, switched and deleted by its managers.

import { eq, sql } from "drizzle-orm";

import { user } from "@/server/orgs/schema.ts";
import { thread as threadTable } from "@/server/threads/schema.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import { setup } from "@/server/testing/workspace.ts";
import { queries } from "@/server/testing/tracing.ts";
import type { SkillDetail, SpaceSkillList } from "@/shared/skills.ts";
import type { ThreadCommand } from "@/shared/threads/commands.ts";

import { learnedSkill } from "./schema.ts";
import type { LearnInput } from "./service.ts";

const NOTES: LearnInput = {
  name: "deploy-notes",
  description: "Write the notes for a deploy",
  instructions: "Read the merged changes, then write one line each.",
  files: [{ path: "run.py", text: "print(await thread__info())" }],
};

const USABLE = "Usable now; listed in this thread's instructions after /reload.";

async function json<T>(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

// Ada owns a team org with a shared space and a thread in it, where Grace messages and manages
// nothing; and the agent of that thread saves skills, each call approved by Ada.
async function arranged() {
  const workspace = setup();
  const { api, signUp, join, skills, spaceStore } = workspace;
  const ada = await signUp("Ada Lovelace", "ada@example.com");
  const space = (await spaceStore.find((await workspace.yourSpace(ada.cookie)).id))!;
  const grace = await join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
  const thread = await workspace.createThread(ada.cookie, space.id);
  let calls = 0;
  const learn = (input: LearnInput, callId = `call-${(calls += 1)}`) =>
    skills.learn(
      {
        orgId: space.orgId,
        spaceId: space.id,
        threadId: thread.id,
        callId,
        influence: [],
        approvedBy: ada.userId,
      },
      input,
    );
  const listed = async (cookie = ada.cookie) =>
    (await json<SpaceSkillList>(await api("GET", `/spaces/${space.id}/skills`, cookie))).own
      .written;
  const here = { id: space.id, orgId: space.orgId };
  const names = async () => (await skills.effectiveIn(here)).map((skill) => skill.name);
  return { ...workspace, ada, grace, space, thread, learn, listed, names, here };
}

describe("learned skills", () => {
  it("are saved once per call, on in the space, and listed as learned with who approved them", async () => {
    const { learn, listed, names, thread, api, ada, grace, space, db } = await arranged();
    expect(await learn(NOTES, "call-a")).toEqual({
      ok: true,
      value: { name: "deploy-notes", note: USABLE },
    });
    // The same call again gives back what it saved, and saves nothing more.
    expect(await learn(NOTES, "call-a")).toEqual({
      ok: true,
      value: { name: "deploy-notes", note: USABLE },
    });
    expect(await db.select().from(learnedSkill)).toHaveLength(1);
    expect(await names()).toContain("deploy-notes");

    const [row] = await listed();
    expect(row).toMatchObject({
      name: "deploy-notes",
      sourceId: null,
      spaceId: space.id,
      enabled: true,
      fileCount: 1,
      learned: { thread: { id: thread.id, title: "Untitled" }, approvedBy: "Ada Lovelace" },
    });
    // Those who read the space's threads see the thread, managers or not.
    expect((await listed(grace.cookie))[0]!.learned!.thread).toEqual({
      id: thread.id,
      title: "Untitled",
    });
    const detail = await json<SkillDetail>(await api("GET", `/skills/${row!.id}`, ada.cookie));
    expect(detail.body).toBe(NOTES.instructions);
    expect(detail.files).toEqual(NOTES.files);

    // It runs as a command in the space.
    const commands = await json<ThreadCommand[]>(
      await api("GET", `/spaces/${space.id}/commands`, ada.cookie),
    );
    expect(commands.map((command) => command.name)).toContain("deploy-notes");
  });

  it("replace one the space learned only when told to update, keeping the old one retired", async () => {
    const { learn, listed, db } = await arranged();
    await learn(NOTES);
    expect(await learn({ ...NOTES, description: "Another" })).toEqual({
      ok: false,
      error: "A skill named deploy-notes already exists here; set update to change it",
    });
    expect(await learn({ ...NOTES, description: "Deploy notes, shorter", update: true })).toEqual({
      ok: true,
      value: { name: "deploy-notes", updated: true, note: USABLE },
    });
    expect((await listed()).map((row) => row.description)).toEqual(["Deploy notes, shorter"]);
    const rows = await db.select().from(learnedSkill).orderBy(learnedSkill.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.retiredAt).not.toBeNull();
    expect(rows[0]!.retiredBy).toBeNull();
    expect(rows[1]).toMatchObject({ retiredAt: null, supersedesId: rows[0]!.id });
  });

  it("refuse the names of built-in and org skills, of Mage's commands, and of people's skills", async () => {
    const { learn, api, ada, space, db } = await arranged();
    const taken = (name: string) => ({
      ok: false,
      error: `${name} is a built-in or organization skill; choose another name`,
    });
    expect(await learn({ ...NOTES, name: "reflect" })).toEqual(taken("reflect"));
    expect(await learn({ ...NOTES, name: "compact" })).toEqual({
      ok: false,
      error: "compact is a command; choose another name",
    });
    expect(await learn({ ...NOTES, name: "reload" })).toEqual({
      ok: false,
      error: "reload is a command; choose another name",
    });
    await json(
      await api("POST", "/org/skills", ada.cookie, {
        name: "haiku",
        description: "Answer in haiku",
        body: "Three lines.",
      }),
    );
    expect(await learn({ ...NOTES, name: "haiku" })).toEqual(taken("haiku"));
    await json(
      await api("POST", `/spaces/${space.id}/skills`, ada.cookie, {
        name: "local",
        description: "Only here",
        body: "Local.",
      }),
    );
    const written = {
      ok: false,
      error: "local was written by a person; only learned skills can be updated here",
    };
    expect(await learn({ ...NOTES, name: "local" })).toEqual(written);
    expect(await learn({ ...NOTES, name: "local", update: true })).toEqual(written);
    expect(await db.select().from(learnedSkill)).toEqual([]);
  });

  it("are refused, and not used, while the org does not let spaces add skills", async () => {
    const { learn, api, ada, names } = await arranged();
    await learn(NOTES);
    await json(await api("PUT", "/org/skills/space-skills", ada.cookie, { allowed: false }));
    expect(await names()).not.toContain("deploy-notes");
    expect(await learn({ ...NOTES, name: "other" })).toEqual({
      ok: false,
      error: "The organization does not let spaces add skills",
    });
  });

  it("are edited by the space's managers into a new row they approved, keeping files, thread and switch", async () => {
    const { learn, listed, names, api, grace, space, thread, signUp, join, db } = await arranged();
    const linus = await join(
      await signUp("Linus Torvalds", "linus@example.com"),
      space.id,
      "owner",
    );
    await learn(NOTES);
    const id = (await listed())[0]!.id;
    await json(await api("PUT", `/skills/${id}/enabled`, linus.cookie, { enabled: false }));
    const changes = { name: "release-notes", description: "Write release notes", body: "New." };
    expect((await api("PATCH", `/skills/${id}`, grace.cookie, changes)).status).toBe(403);
    const edited = await json<SkillDetail>(
      await api("PATCH", `/skills/${id}`, linus.cookie, changes),
    );
    expect(edited).toMatchObject({
      name: changes.name,
      description: changes.description,
      enabled: false,
      fileCount: 1,
      learned: { approvedBy: "Linus Torvalds" },
    });
    expect(edited.id).not.toBe(id);
    const detail = await json<SkillDetail>(await api("GET", `/skills/${edited.id}`, linus.cookie));
    expect(detail).toMatchObject({ body: "New.", files: NOTES.files });
    const rows = await db.select().from(learnedSkill).orderBy(learnedSkill.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id, name: "deploy-notes", retiredBy: null });
    expect(rows[0]!.retiredAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      id: edited.id,
      supersedesId: id,
      threadId: thread.id,
      callId: null,
      approvedBy: linus.userId,
      retiredAt: null,
    });
    await json(await api("PUT", `/skills/${edited.id}/enabled`, linus.cookie, { enabled: true }));
    expect(await names()).toContain("release-notes");
    expect(await names()).not.toContain("deploy-notes");
  });

  it("answer not found once replaced or deleted, to an edit, a switch or a delete", async () => {
    const { learn, listed, api, ada } = await arranged();
    await learn(NOTES);
    const id = (await listed())[0]!.id;
    await learn({ ...NOTES, description: "Newer", update: true });
    const edit = { name: "deploy-notes", description: "d", body: "b" };
    expect((await api("PATCH", `/skills/${id}`, ada.cookie, edit)).status).toBe(404);
    expect((await api("PUT", `/skills/${id}/enabled`, ada.cookie, { enabled: false })).status).toBe(
      404,
    );
    expect((await api("DELETE", `/skills/${id}`, ada.cookie)).status).toBe(404);
    expect(await listed()).toMatchObject([{ description: "Newer", enabled: true }]);
  });

  it("are switched off by the space's managers, then neither offered nor run; an update keeps the switch", async () => {
    const { learn, listed, names, api, ada, grace, space } = await arranged();
    await learn(NOTES);
    const id = (await listed())[0]!.id;
    const off = { enabled: false };
    expect((await api("PUT", `/skills/${id}/enabled`, grace.cookie, off)).status).toBe(403);
    await json(await api("PUT", `/skills/${id}/enabled`, ada.cookie, off));
    expect((await listed())[0]).toMatchObject({ id, enabled: false });
    expect(await names()).not.toContain("deploy-notes");
    const commands = await json<ThreadCommand[]>(
      await api("GET", `/spaces/${space.id}/commands`, ada.cookie),
    );
    expect(commands.map((command) => command.name)).not.toContain("deploy-notes");

    expect((await learn({ ...NOTES, description: "Shorter", update: true })).ok).toBe(true);
    const [updated] = await listed();
    expect(updated).toMatchObject({ description: "Shorter", enabled: false });
    await json(await api("PUT", `/skills/${updated!.id}/enabled`, ada.cookie, { enabled: true }));
    expect(await names()).toContain("deploy-notes");
  });

  it("are renamed never to a command, a built-in or org skill, or another of the space's", async () => {
    const { learn, listed, api, ada } = await arranged();
    await learn(NOTES);
    await learn({ ...NOTES, name: "other" });
    const id = (await listed()).find((row) => row.name === "deploy-notes")!.id;
    const otherId = (await listed()).find((row) => row.name === "other")!.id;
    // Off, the other still holds its name.
    await json(await api("PUT", `/skills/${otherId}/enabled`, ada.cookie, { enabled: false }));
    await json(
      await api("POST", "/org/skills", ada.cookie, {
        name: "haiku",
        description: "Answer in haiku",
        body: "Three lines.",
      }),
    );
    const rename = (name: string) =>
      api("PATCH", `/skills/${id}`, ada.cookie, { name, description: "d", body: "b" });
    for (const name of ["compact", "reflect", "haiku", "other"]) {
      expect((await rename(name)).status, name).toBe(409);
    }
    expect((await listed()).map((row) => row.name).sort()).toEqual(["deploy-notes", "other"]);
  });

  it("keep their name from a person's skill in the space, on or off", async () => {
    const { learn, listed, api, ada, space } = await arranged();
    await learn(NOTES);
    const id = (await listed())[0]!.id;
    await json(await api("PUT", `/skills/${id}/enabled`, ada.cookie, { enabled: false }));
    const write = (name: string) => ({ name, description: "By hand", body: "Written." });
    const held = await api("POST", `/spaces/${space.id}/skills`, ada.cookie, write("deploy-notes"));
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({
      error: "A learned skill named deploy-notes is already here",
    });
    const own = await json<{ id: string }>(
      await api("POST", `/spaces/${space.id}/skills`, ada.cookie, write("by-hand")),
    );
    const rename = await api("PATCH", `/skills/${own.id}`, ada.cookie, write("deploy-notes"));
    expect(rename.status).toBe(409);
    expect((await listed()).map((row) => row.name).sort()).toEqual(["by-hand", "deploy-notes"]);
  });

  it("are deleted by the space's managers alone", async () => {
    const { learn, listed, names, api, ada, grace, db } = await arranged();
    await learn(NOTES);
    const id = (await listed())[0]!.id;
    expect((await api("DELETE", `/skills/${id}`, grace.cookie)).status).toBe(403);
    await json(await api("DELETE", `/skills/${id}`, ada.cookie));
    expect(await listed()).toEqual([]);
    expect(await names()).not.toContain("deploy-notes");
    const [row] = await db.select().from(learnedSkill).where(eq(learnedSkill.id, id));
    expect(row).toMatchObject({ retiredBy: ada.userId });
    // Its name is free again.
    expect((await learn(NOTES)).ok).toBe(true);
  });

  it("are listed with the space's other skills in one read, however many there are", async () => {
    const { learn, listed } = await arranged();
    await learn(NOTES);
    const one = await queries(listed);
    for (const name of ["second", "third", "fourth"]) await learn({ ...NOTES, name });
    const four = await queries(listed);
    expect(four.result).toHaveLength(4);
    expect(four.count).toBe(one.count);
    const reads = four.texts.filter((text) => text.includes('"learned_skill"'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/union all/i);
  });

  it("never take the place of an org skill of their name, even one added after", async () => {
    const { learn, api, ada, space, skills, here } = await arranged();
    await learn({ ...NOTES, name: "haiku" });
    await json(
      await api("POST", "/org/skills", ada.cookie, {
        name: "haiku",
        description: "Answer in haiku",
        body: "Three lines.",
      }),
    );
    const on = (await skills.effectiveIn(here)).filter((skill) => skill.name === "haiku");
    expect(on.map((skill) => [skill.body, skill.learned ?? null])).toEqual([
      ["Three lines.", null],
    ]);
    const commands = await json<ThreadCommand[]>(
      await api("GET", `/spaces/${space.id}/commands`, ada.cookie),
    );
    expect(commands.filter((command) => command.name === "haiku")).toEqual([
      expect.objectContaining({ description: "Answer in haiku" }),
    ]);
  });

  it("are saved anew under the name of one deleted, with update set or not", async () => {
    const { learn, listed, api, ada } = await arranged();
    await learn(NOTES);
    await json(await api("DELETE", `/skills/${(await listed())[0]!.id}`, ada.cookie));
    expect(await learn({ ...NOTES, update: true })).toEqual({
      ok: true,
      value: { name: "deploy-notes", note: USABLE },
    });
    expect(await listed()).toHaveLength(1);
  });

  it("keep their place once the thread that saved them or the person who approved them is gone", async () => {
    const { learn, listed, db, thread, ada } = await arranged();
    await learn(NOTES);
    await db.delete(threadTable).where(eq(threadTable.id, thread.id));
    expect((await listed())[0]!.learned).toEqual({ thread: null, approvedBy: "Ada Lovelace" });
    await db.delete(user).where(eq(user.id, ada.userId));
    const [row] = await db.select().from(learnedSkill);
    expect(row).toMatchObject({ threadId: null, approvedBy: null, retiredAt: null });
  });

  it("are written one at a time with a person's skill of the same name", async () => {
    const { learn, api, ada, space, names } = await arranged();
    const [saved, written] = await Promise.all([
      learn({ ...NOTES, name: "same" }),
      api("POST", `/spaces/${space.id}/skills`, ada.cookie, {
        name: "same",
        description: "Written",
        body: "By hand.",
      }),
    ]);
    // Whichever went first, the other is refused.
    expect([saved.ok, written.status === 200].filter(Boolean)).toHaveLength(1);
    expect((await names()).filter((name) => name === "same")).toHaveLength(1);
  });

  it("let one of two racing updates through after the other", async () => {
    const { learn, db } = await arranged();
    await learn(NOTES);
    const [one, two] = await Promise.all([
      learn({ ...NOTES, description: "One", update: true }),
      learn({ ...NOTES, description: "Two", update: true }),
    ]);
    expect([one.ok, two.ok]).toEqual([true, true]);
    const live = (await db.select().from(learnedSkill)).filter((row) => !row.retiredAt);
    expect(live).toHaveLength(1);
  });
});

type Arranged = Awaited<ReturnType<typeof arranged>>;

// Holds the skill name in the space as a write of it does, until released.
async function holding({ db, space }: Arranged, name: string) {
  const key = `skill-name:${space.orgId}:${space.id}:${name}`;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked = () => {};
  const locking = new Promise<void>((resolve) => (locked = resolve));
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    locked();
    await held;
  });
  await Promise.race([locking, done]);
  return async () => {
    release();
    await done;
  };
}

// Starts the writes one after another, each queued on the held name before the next starts, then
// lets them through in that order.
async function queued(all: Arranged, writes: (() => Promise<unknown>)[]) {
  const release = await holding(all, NOTES.name);
  const started: Promise<unknown>[] = [];
  for (const [at, write] of writes.entries()) {
    started.push(write());
    await vi.waitFor(async () => {
      const rows = await all.db.execute<{ count: string }>(
        sql`select count(*) from pg_locks where locktype = 'advisory' and not granted`,
      );
      expect(Number(rows.rows[0]!.count)).toBe(at + 1);
    });
  }
  await release();
  return Promise.all(started);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("learned skills on Postgres", () => {
  const update = { ...NOTES, description: "From the agent", update: true };
  const renamed = { name: "release-notes", description: "Renamed", body: "New." };

  async function saved() {
    const all = await arranged();
    await all.learn(NOTES);
    return { ...all, id: (await all.listed())[0]!.id };
  }

  it("refuse a manager's rename queued behind the agent's update as changed", async () => {
    const all = await saved();
    const [learned, edit] = (await queued(all, [
      () => all.learn(update),
      () => all.api("PATCH", `/skills/${all.id}`, all.ada.cookie, renamed),
    ])) as [{ ok: boolean }, Response];
    expect(learned.ok).toBe(true);
    expect(edit.status).toBe(409);
    expect(await edit.json()).toMatchObject({ error: "It changed while this saved" });
    expect(await all.listed()).toMatchObject([
      { name: "deploy-notes", description: "From the agent" },
    ]);
  });

  it("save the agent's update queued behind a manager's rename anew, the rename kept", async () => {
    const all = await saved();
    const [edit, learned] = (await queued(all, [
      () => all.api("PATCH", `/skills/${all.id}`, all.ada.cookie, renamed),
      () => all.learn(update),
    ])) as [Response, { ok: boolean }];
    expect(edit.status).toBe(200);
    expect(learned.ok).toBe(true);
    expect((await all.listed()).map((row) => [row.name, row.description])).toEqual([
      ["deploy-notes", "From the agent"],
      ["release-notes", "Renamed"],
    ]);
  });

  it("refuse a manager's switch queued behind the agent's update as changed", async () => {
    const all = await saved();
    const [, off] = (await queued(all, [
      () => all.learn(update),
      () => all.api("PUT", `/skills/${all.id}/enabled`, all.ada.cookie, { enabled: false }),
    ])) as [unknown, Response];
    expect(off.status).toBe(409);
    expect(await all.listed()).toMatchObject([{ description: "From the agent", enabled: true }]);
  });

  it("keep a manager's switch in the agent's update queued behind it", async () => {
    const all = await saved();
    const [off, learned] = (await queued(all, [
      () => all.api("PUT", `/skills/${all.id}/enabled`, all.ada.cookie, { enabled: false }),
      () => all.learn(update),
    ])) as [Response, { ok: boolean }];
    expect(off.status).toBe(200);
    expect(learned.ok).toBe(true);
    expect(await all.listed()).toMatchObject([{ description: "From the agent", enabled: false }]);
  });

  it("refuse a delete queued behind the agent's update as changed", async () => {
    const all = await saved();
    const [, removed] = (await queued(all, [
      () => all.learn(update),
      () => all.api("DELETE", `/skills/${all.id}`, all.ada.cookie),
    ])) as [unknown, Response];
    expect(removed.status).toBe(409);
    expect(await all.listed()).toMatchObject([{ description: "From the agent" }]);
  });
});

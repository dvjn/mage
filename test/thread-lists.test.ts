import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setup } from "./workspace.ts";

// Ada's space with threads made straight in the store, titled as given, each newer than the last
// unless `at` gives them the same time.
async function space() {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const grace = workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    (await workspace.yourSpace(ada.cookie)).id,
    "messager",
  );
  const { id: spaceId } = await workspace.yourSpace(ada.cookie);
  let clock = Date.parse("2026-10-01T00:00:00Z");
  function thread(title: string, { folderId = null as string | null, at = 0 } = {}) {
    const made = workspace.threadStore.create({
      spaceId,
      folderId,
      model: null,
      createdBy: ada.userId,
    });
    workspace.threadStore.update(made.id, { title });
    clock += 1000;
    workspace.db.run(sql`update thread set updated_at = ${at || clock} where id = ${made.id}`);
    return made.id;
  }
  function said(threadId: string, userId: string, text: string) {
    const event = workspace.threadStore.append(threadId, {
      type: "message",
      actor: { kind: "user", userId },
      data: { parts: [{ type: "text", text }], quiet: true, mode: "steer" },
    });
    clock += 1000;
    workspace.db.run(sql`update thread set updated_at = ${clock} where id = ${threadId}`);
    return event.seq;
  }
  function failed(threadId: string) {
    const created = workspace.threadStore.append(threadId, {
      type: "run.created",
      actor: { kind: "agent" },
      data: { runId: `r-${threadId}`, reason: null, continuesRunId: null },
    });
    workspace.threadStore.append(threadId, {
      type: "run.failed",
      actor: { kind: "agent" },
      data: { runId: `r-${threadId}`, error: "No" },
    });
    clock += 1000;
    workspace.db.run(sql`update thread set updated_at = ${clock} where id = ${threadId}`);
    return created.seq;
  }
  function titles(
    reader: string,
    filter: Parameters<typeof workspace.threadStore.listed>[2] = {},
    window?: { limit: number; offset: number },
  ) {
    const { rows, total } = workspace.threadStore.listed(reader, spaceId, filter, window);
    const byId = new Map(
      workspace.db
        .all<{ id: string; title: string }>(sql`select id, title from thread`)
        .map((row) => [row.id, row.title]),
    );
    return { titles: rows.map((row) => byId.get(row.thread.id)), total };
  }
  return { ...workspace, ada, grace, spaceId, thread, said, failed, titles };
}

describe("a space's threads listed in the database", () => {
  it("pages by offset, newest first, counting every match", async () => {
    const { ada, thread, titles } = await space();
    for (const title of ["One", "Two", "Three", "Four", "Five"]) thread(title);

    expect(titles(ada.userId, {}, { limit: 2, offset: 0 })).toEqual({
      titles: ["Five", "Four"],
      total: 5,
    });
    expect(titles(ada.userId, {}, { limit: 2, offset: 4 })).toEqual({ titles: ["One"], total: 5 });
    expect(titles(ada.userId, {}, { limit: 2, offset: 6 })).toEqual({ titles: [], total: 5 });
  });

  it("keeps threads active at the same moment in one order, by id", async () => {
    const { ada, thread, titles } = await space();
    const at = Date.parse("2026-10-02T00:00:00Z");
    const ids = ["A", "B", "C", "D"].map((title) => [thread(title, { at }), title] as const);
    const expected = ids.toSorted(([a], [b]) => b.localeCompare(a)).map(([, title]) => title);

    const pages = [0, 2].flatMap((offset) => titles(ada.userId, {}, { limit: 2, offset }).titles);
    expect(pages).toEqual(expected);
  });

  it("finds threads by title or by the text of their newest message only", async () => {
    const { ada, thread, said, titles } = await space();
    const looms = thread("Looms");
    said(looms, ada.userId, "About **engines**\n\nand  cards");
    const gears = thread("Gears");
    said(gears, ada.userId, "Old engines talk");
    said(gears, ada.userId, "Newer words");
    thread("Engine notes");

    expect(titles(ada.userId, { text: "ENGINES AND" }).titles).toEqual(["Looms"]);
    expect(titles(ada.userId, { text: "engine" }).titles).toEqual(["Engine notes", "Looms"]);
    expect(titles(ada.userId, { text: "untitled" }).titles).toEqual([]);
    expect(titles(ada.userId, { text: "100%" }).titles).toEqual([]);
  });

  it("narrows by folder, text and status together", async () => {
    const { ada, grace, thread, said, failed, titles, createFolder, spaceId } = await space();
    const folder = await createFolder(ada.cookie, spaceId, "Looms");
    const inside = thread("Alpha inside", { folderId: folder.id });
    said(inside, grace.userId, "Hello");
    const quiet = thread("Alpha quiet", { folderId: folder.id });
    said(quiet, ada.userId, "Mine");
    const outside = thread("Alpha outside");
    said(outside, grace.userId, "Hello");
    const broken = thread("Beta broken", { folderId: folder.id });
    failed(broken);

    expect(
      titles(ada.userId, { folderId: folder.id, text: "alpha" }, { limit: 10, offset: 0 }),
    ).toEqual({ titles: ["Alpha quiet", "Alpha inside"], total: 2 });
    expect(
      titles(
        ada.userId,
        { folderId: folder.id, text: "alpha", show: "unread" },
        {
          limit: 10,
          offset: 0,
        },
      ),
    ).toEqual({ titles: ["Alpha inside"], total: 1 });
    expect(titles(ada.userId, { show: "unread" }).titles).toEqual([
      "Alpha outside",
      "Alpha inside",
    ]);
    // Grace wrote two of them; only Ada's message is news to her.
    expect(titles(grace.userId, { show: "unread" }).titles).toEqual(["Alpha quiet"]);
    expect(titles(ada.userId, { show: "maybe-needs-you" }).titles).toEqual(["Beta broken"]);
  });

  it("drops a failure the reader has seen, or one another run followed", async () => {
    const { ada, thread, failed, titles, threadStore, ...workspace } = await space();
    const broken = thread("Broken");
    failed(broken);
    const retried = thread("Retried");
    failed(retried);
    threadStore.append(retried, {
      type: "run.created",
      actor: { kind: "agent" },
      data: { runId: "again", reason: "retry", continuesRunId: null },
    });
    expect(titles(ada.userId, { show: "maybe-needs-you" }).titles).toEqual(["Broken"]);

    const seen = threadStore.find(broken)!.lastEventSeq;
    await workspace.api("PUT", `/threads/${broken}/read`, ada.cookie, { seq: seen });
    expect(titles(ada.userId, { show: "maybe-needs-you" }).titles).toEqual([]);
  });

  it("lists a run waiting on a decision as one that may need the reader", async () => {
    const { ada, thread, titles, runStore, db } = await space();
    thread("Idle");
    const asking = thread("Asking");
    const run = runStore.create({ threadId: asking, triggerSeq: 0, createdBy: ada.userId });
    db.run(sql`update run set status = 'waiting' where id = ${run.id}`);

    expect(titles(ada.userId, { show: "maybe-needs-you" }).titles).toEqual(["Asking"]);
    expect(titles(ada.userId, { show: "unread" }).titles).toEqual([]);
  });
});

describe("a space's sidebar threads", () => {
  it("takes the newest few of each folder, with counts and what says something", async () => {
    const { ada, grace, thread, said, failed, threadStore, createFolder, spaceId } = await space();
    const folder = await createFolder(ada.cookie, spaceId, "Looms");
    const unread = thread("Old news", { folderId: folder.id });
    said(unread, grace.userId, "Hello");
    const broken = thread("Old failure");
    failed(broken);
    for (let n = 1; n <= 3; n++) thread(`Folder ${n}`, { folderId: folder.id });
    for (let n = 1; n <= 3; n++) thread(`Top ${n}`);

    const { rows, counts, failed: failures } = threadStore.sidebar(ada.userId, spaceId, 2);
    expect(rows.map((row) => threadStore.find(row.thread.id)?.title)).toEqual([
      "Top 3",
      "Top 2",
      "Folder 3",
      "Folder 2",
      "Old failure",
      "Old news",
    ]);
    expect(Object.fromEntries(counts)).toEqual({ [folder.id]: 4, null: 4 });
    expect(failures).toBe(1);
  });
});

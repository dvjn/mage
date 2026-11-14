import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setup } from "@/server/testing/workspace.ts";

// Ada's space with threads made straight in the store, titled as given, each newer than the last
// unless `at` gives them the same time.
async function space() {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const grace = await workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    (await workspace.yourSpace(ada.cookie)).id,
    "messager",
  );
  const { id: spaceId } = await workspace.yourSpace(ada.cookie);
  let clock = Date.parse("2026-10-01T00:00:00Z");
  async function thread(title: string, { at = 0 } = {}) {
    const made = await workspace.threadStore.create({
      spaceId,
      model: null,
      createdBy: ada.userId,
    });
    await workspace.threadStore.update(made.id, { title });
    clock += 1000;
    await workspace.db.execute(
      sql`update thread set updated_at = ${new Date(at || clock)} where id = ${made.id}`,
    );
    return made.id;
  }
  async function said(threadId: string, userId: string, text: string) {
    const event = await workspace.threadStore.append(threadId, {
      type: "message",
      actor: { kind: "user", userId },
      data: { parts: [{ type: "text", text }], quiet: true, mode: "steer" },
    });
    await workspace.queue.fromLog(threadId);
    clock += 1000;
    await workspace.db.execute(
      sql`update thread set updated_at = ${new Date(clock)} where id = ${threadId}`,
    );
    return event.seq;
  }
  async function failed(threadId: string) {
    const created = await workspace.threadStore.append(threadId, {
      type: "run.created",
      actor: { kind: "agent" },
      data: { runId: `r-${threadId}`, reason: null, continuesRunId: null },
    });
    await workspace.threadStore.append(threadId, {
      type: "run.failed",
      actor: { kind: "agent" },
      data: { runId: `r-${threadId}`, error: "No" },
    });
    clock += 1000;
    await workspace.db.execute(
      sql`update thread set updated_at = ${new Date(clock)} where id = ${threadId}`,
    );
    return created.seq;
  }
  async function titles(
    reader: string,
    filter: Parameters<typeof workspace.threadStore.listed>[2] = {},
    window?: { limit: number; offset: number },
  ) {
    const { rows, total } = await workspace.threadStore.listed(reader, spaceId, filter, window);
    const byId = new Map(
      (
        await workspace.db.execute<{ id: string; title: string }>(sql`select id, title from thread`)
      ).rows.map((row) => [row.id, row.title]),
    );
    return { titles: rows.map((row) => byId.get(row.thread.id)), total };
  }
  return { ...workspace, ada, grace, spaceId, thread, said, failed, titles };
}

describe("a space's threads listed in the database", () => {
  it("pages by offset, newest first, counting every match", async () => {
    const { ada, thread, titles } = await space();
    for (const title of ["One", "Two", "Three", "Four", "Five"]) await thread(title);

    expect(await titles(ada.userId, {}, { limit: 2, offset: 0 })).toEqual({
      titles: ["Five", "Four"],
      total: 5,
    });
    expect(await titles(ada.userId, {}, { limit: 2, offset: 4 })).toEqual({
      titles: ["One"],
      total: 5,
    });
    expect(await titles(ada.userId, {}, { limit: 2, offset: 6 })).toEqual({ titles: [], total: 5 });
  });

  it("keeps threads active at the same moment in one order, by id", async () => {
    const { ada, thread, titles } = await space();
    const at = Date.parse("2026-10-02T00:00:00Z");
    const ids = await Promise.all(
      ["A", "B", "C", "D"].map(async (title) => [await thread(title, { at }), title] as const),
    );
    const expected = ids.toSorted(([a], [b]) => b.localeCompare(a)).map(([, title]) => title);

    const pages = (
      await Promise.all(
        [0, 2].map(async (offset) => (await titles(ada.userId, {}, { limit: 2, offset })).titles),
      )
    ).flat();
    expect(pages).toEqual(expected);
  });

  it("finds threads by title or by the text of their newest message only", async () => {
    const { ada, thread, said, titles } = await space();
    const looms = await thread("Looms");
    await said(looms, ada.userId, "About **engines**\n\nand  cards");
    const gears = await thread("Gears");
    await said(gears, ada.userId, "Old engines talk");
    await said(gears, ada.userId, "Newer words");
    await thread("Engine notes");

    expect((await titles(ada.userId, { text: "ENGINES AND" })).titles).toEqual(["Looms"]);
    expect((await titles(ada.userId, { text: "engine" })).titles).toEqual([
      "Engine notes",
      "Looms",
    ]);
    expect((await titles(ada.userId, { text: "untitled" })).titles).toEqual([]);
    expect((await titles(ada.userId, { text: "100%" })).titles).toEqual([]);
  });

  it("narrows by text and status together", async () => {
    const { ada, grace, thread, said, failed, titles } = await space();
    const inside = await thread("Alpha inside");
    await said(inside, grace.userId, "Hello");
    const quiet = await thread("Alpha quiet");
    await said(quiet, ada.userId, "Mine");
    const outside = await thread("Alpha outside");
    await said(outside, grace.userId, "Hello");
    const broken = await thread("Beta broken");
    await failed(broken);

    expect(await titles(ada.userId, { text: "alpha" }, { limit: 10, offset: 0 })).toEqual({
      titles: ["Alpha outside", "Alpha quiet", "Alpha inside"],
      total: 3,
    });
    expect(
      await titles(ada.userId, { text: "alpha", show: "unread" }, { limit: 10, offset: 0 }),
    ).toEqual({ titles: ["Alpha outside", "Alpha inside"], total: 2 });
    expect((await titles(ada.userId, { show: "unread" })).titles).toEqual([
      "Alpha outside",
      "Alpha inside",
    ]);
    // Grace wrote two of them; only Ada's message is news to her.
    expect((await titles(grace.userId, { show: "unread" })).titles).toEqual(["Alpha quiet"]);
    expect((await titles(ada.userId, { show: "maybe-needs-you" })).titles).toEqual(["Beta broken"]);
  });

  it("drops a failure the reader has seen, or one another run followed", async () => {
    const { ada, thread, failed, titles, threadStore, ...workspace } = await space();
    const broken = await thread("Broken");
    await failed(broken);
    const retried = await thread("Retried");
    await failed(retried);
    await threadStore.append(retried, {
      type: "run.created",
      actor: { kind: "agent" },
      data: { runId: "again", reason: "retry", continuesRunId: null },
    });
    expect((await titles(ada.userId, { show: "maybe-needs-you" })).titles).toEqual(["Broken"]);

    const seen = (await threadStore.find(broken))!.lastEventSeq;
    await workspace.api("PUT", `/threads/${broken}/read`, ada.cookie, { seq: seen });
    expect((await titles(ada.userId, { show: "maybe-needs-you" })).titles).toEqual([]);
  });

  it("lists a run waiting on a decision as one that may need the reader", async () => {
    const { ada, thread, titles, runStore, callStore, log, db } = await space();
    await thread("Idle");
    const asking = await thread("Asking");
    const run = await runStore.create({ threadId: asking, triggerSeq: 0, createdBy: ada.userId });
    await db.execute(sql`update run set status = 'waiting' where id = ${run.id}`);
    // What it waits on.
    await log.write(asking, async (append) => {
      const call = { runId: run.id, callId: "ask", toolId: "probe.guarded", input: {} };
      const data = { ...call, messageId: "", risk: "ask" as const, waits: true };
      const requested = await append({ type: "tool.requested", actor: { kind: "agent" }, data });
      await callStore.insert([
        {
          threadId: asking,
          id: "ask",
          branchId: run.branchId,
          seq: requested.seq,
          runId: run.id,
          toolId: call.toolId,
          risk: "ask",
          status: "waiting",
          waitsFor: "decision",
          background: false,
        },
      ]);
    });

    expect((await titles(ada.userId, { show: "maybe-needs-you" })).titles).toEqual(["Asking"]);
    expect((await titles(ada.userId, { show: "unread" })).titles).toEqual([]);
  });
});

describe("a space's sidebar threads", () => {
  it("takes the newest few, with the count and what says something", async () => {
    const { ada, grace, thread, said, failed, threadStore, spaceId } = await space();
    const unread = await thread("Old news");
    await said(unread, grace.userId, "Hello");
    const broken = await thread("Old failure");
    await failed(broken);
    for (let n = 1; n <= 3; n++) await thread(`Top ${n}`);

    const { rows, total, failed: failures } = await threadStore.sidebar(ada.userId, spaceId, 2);
    expect(
      await Promise.all(rows.map(async (row) => (await threadStore.find(row.thread.id))?.title)),
    ).toEqual(["Top 3", "Top 2", "Old failure", "Old news"]);
    expect(total).toBe(5);
    expect(failures).toBe(1);
  });
});

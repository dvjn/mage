// The most queries the paths people wait on may make. A step that makes one of them cheaper
// lowers its number; one that makes it dearer says why.

import { describe, expect, it } from "vite-plus/test";

import { createRunTraces } from "@/server/kernel/tracing.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { busyThread, subagentsIdle, subagentsWaiting } from "@/server/testing/busy-thread.ts";
import { queries } from "@/server/testing/tracing.ts";
import { createMemoryStore } from "@/server/memory/store.ts";
import { SAVE_MEMORY, SEARCH_MEMORY } from "@/shared/memory.ts";

const MAX = {
  detail: 39,
  rows: 12,
  threadList: 19,
  tray: 31,
  run: 93,
  // A thread with every kind of background work, as its owner and as a guest read it.
  busyTray: { owner: 85, guest: 98 },
  busyDetail: { owner: 108, guest: 133 },
  // What a page of forty rows reads beyond one of ten: the other threads its rows name.
  longPageMore: 18,
  // A guest's list feed over two hundred shared threads.
  guestFeed: { flush: 1618, recheck: 1418 },
  // A thread's opening notice of a space's memory.
  memoryNotice: 19,
};

// Ada's space with twenty threads, and a thread of fifty notes.
async function arranged() {
  const t = await agentThread({}, { traces: createRunTraces() });
  const seed = async (body: object) =>
    (
      await t.app.request("/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<{ threadId: string }>;
  await seed({ threads: { email: "ada@example.com", count: 20, prefix: "Thread" } });
  const { threadId } = await seed({
    notesThread: { email: "ada@example.com", title: "Notes", count: 50 },
  });
  const get = async (path: string) => {
    const res = await t.api("GET", path, t.ada.cookie);
    expect(res.status).toBe(200);
    await res.text();
  };
  return { ...t, notes: threadId, get };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("queries of the paths people wait on", () => {
  it("stay within their budgets", async () => {
    const t = await arranged();
    // None counted would mean the driver is not traced, not that a path is free.
    const counted = async (path: string) => {
      const { count } = await queries(() => t.get(path));
      expect(count).toBeGreaterThan(0);
      return count;
    };
    expect(await counted(`/threads/${t.notes}`)).toBeLessThanOrEqual(MAX.detail);
    expect(await counted(`/threads/${t.notes}/rows?before=40`)).toBeLessThanOrEqual(MAX.rows);
    expect(await counted(`/spaces/${t.space.id}/threads`)).toBeLessThanOrEqual(MAX.threadList);
    expect(await counted(`/threads/${t.notes}/activity`)).toBeLessThanOrEqual(MAX.tray);
    // One message, one model step, no tools: what the run makes, not the post that woke it.
    await t.start();
    const run = await queries(async () => {
      await t.post(t.ada, "Hello");
      (await t.model.next()).reply("Hello back.");
      await t.worker.idle();
    }, "run");
    expect(run.count).toBeGreaterThan(0);
    expect(run.count).toBeLessThanOrEqual(MAX.run);
  });

  it("of a busy thread stay within their budgets, for its owner and a guest", async () => {
    const { w, guest } = await busyThread();
    for (const [name, who] of [
      ["owner", w.ada],
      ["guest", guest],
    ] as const) {
      const tray = await queries(() => w.activity(who));
      expect(tray.count).toBeLessThanOrEqual(MAX.busyTray[name]);
      const detail = await queries(() => w.detail(who));
      expect(detail.count).toBeLessThanOrEqual(MAX.busyDetail[name]);
    }
  });

  it("read tools, policies and access as often however many subagents wait", async () => {
    const tables = ["tool_policy", "mcp_server", "tool_setting", "space_member"];
    // Statements naming each table, in the tray and in the detail.
    const counted = async (subagents: number) => {
      const w = await subagentsWaiting(subagents);
      const { texts: tray } = await queries(() => w.activity());
      const { texts: detail } = await queries(() => w.detail());
      const naming = (texts: string[], table: string) =>
        texts.filter((text) => new RegExp(`\\b${table}\\b`).test(text)).length;
      return tables.map((table) => [table, naming(tray, table), naming(detail, table)]);
    };
    // Four is as many as run at once.
    expect(await counted(4)).toEqual(await counted(2));
  });

  it("of a long page read no more than a short page's and a few for the threads it names", async () => {
    const { w } = await busyThread();
    const detail = await w.detail();
    const total = (detail.before ?? 0) + detail.rows.length;
    const page = async (limit: number) =>
      queries(async () => {
        const res = await w.api(
          "GET",
          `/threads/${w.threadId}/rows?before=${total}&limit=${limit}`,
          w.ada.cookie,
        );
        return ((await res.json()) as { rows: { kind: string; state?: string }[] }).rows;
      });
    const ten = await page(10);
    const forty = await page(40);
    // The whole thread, its calls, notices and the call that waits among them.
    expect(forty.result.length).toBe(total);
    expect(forty.result.some((row) => row.kind === "notice")).toBe(true);
    expect(forty.result.some((row) => row.state === "waiting")).toBe(true);
    expect(forty.count).toBeLessThanOrEqual(ten.count + MAX.longPageMore);
  });

  it("of a tray read as often for twelve idle subagents as for three", async () => {
    const counted = async (count: number) => {
      const w = await subagentsIdle(count);
      return (await queries(() => w.activity())).count;
    };
    expect(await counted(12)).toBeLessThanOrEqual(await counted(3));
  });

  it("of a guest's list feed over two hundred shared threads stay where they are measured", async () => {
    const t = await agentThread();
    const seed = async (body: object) =>
      t.app.request("/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await seed({ threads: { email: "ada@example.com", count: 200, prefix: "Shared" } });
    const hedy = await t.signUp("Hedy Lamarr", "hedy@example.com");
    await seed({ shareThreads: { ownerEmail: "ada@example.com", guestEmail: "hedy@example.com" } });
    const shared = (await t.threadStore.listInSpace(t.space.id)).map((thread) => thread.id);
    const told = new Set<string>();
    const feed = await t.views.lists.feed(hedy, (item) => {
      if (item.kind === "thread") told.add(item.thread.id);
    });
    const flush = await queries(async () => {
      for (const threadId of shared) t.signals.changed({ threadId });
      while (told.size < shared.length) await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const recheck = await queries(() => feed.recheck());
    feed.stop();
    // The feed still checks a guest's threads one by one, so these grow with the threads shared.
    expect(flush.count).toBeLessThanOrEqual(MAX.guestFeed.flush);
    expect(recheck.count).toBeLessThanOrEqual(MAX.guestFeed.recheck);
  });

  it("of a space's memory stay the same however many entries, topics and threads it has", async () => {
    const t = await arranged();
    const store = createMemoryStore(t.db);
    const threads = await t.threadStore.listInSpace(t.space.id);
    const thread = (await t.threadStore.find(t.notes))!;
    const tools = t.memory.toolset().tools;
    const run = (id: string, input: object, callId: string) =>
      tools
        .find((spec) => spec.name === id)!
        .run(input, {
          threadId: thread.id,
          spaceId: t.space.id,
          orgId: t.ada.orgId,
          runId: "run",
          callId,
          actor: { kind: "agent" },
          model: null,
          runAs: null,
          influence: [],
          named: (toolId: string) => toolId,
          write: () => Promise.reject(new Error("no writes")),
        });
    // Adds an entry from each of the threads from the first to the last, each under a topic of
    // its own, then counts what each path reads.
    const counted = async (first: number, last: number) => {
      for (const from of threads.slice(first, last)) {
        await store.create({
          id: from.id,
          spaceId: t.space.id,
          type: "fact",
          topic: `Topic ${from.id}`,
          text: `From ${from.title}`,
          threadId: from.id,
          callId: from.id,
          influence: [],
          approvedBy: t.ada.userId,
          supersedesId: null,
        });
      }
      const list = await queries(() => t.get(`/spaces/${t.space.id}/memory`));
      const reads = (texts: string[]) => texts.filter((text) => /memory_entry/.test(text)).length;
      const replaced = threads[first]!.id;
      return {
        list: list.count,
        listReads: reads(list.texts),
        notice: (await queries(() => t.memory.opening(thread))).count,
        search: (await queries(() => run(SEARCH_MEMORY, { query: "from" }, `s${last}`))).count,
        save: (
          await queries(() =>
            run(SAVE_MEMORY, { type: "fact", topic: "Deploys", text: "Tuesdays." }, `a${last}`),
          )
        ).count,
        replace: (
          await queries(() =>
            run(
              SAVE_MEMORY,
              { type: "fact", topic: "Deploys", text: "Wednesdays.", replaces: replaced },
              `r${last}`,
            ),
          )
        ).count,
        forget: (
          await queries(() =>
            t.memory.forget(t.ada, t.space.id, threads[first + 1]?.id ?? replaced),
          )
        ).count,
      };
    };
    // A space without memory pays the one read of its entries.
    expect((await queries(() => t.memory.opening(thread))).count).toBe(1);
    const few = await counted(0, 2);
    // With entries, the space and its tools, read once.
    expect(few.notice).toBeLessThanOrEqual(MAX.memoryNotice);
    // The list is one read of memory beyond the space check.
    expect(few.listReads).toBe(1);
    expect(await counted(2, 10)).toEqual(few);
  });
});

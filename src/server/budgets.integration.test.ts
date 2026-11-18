// The most queries the paths people wait on may make. A step that makes one of them cheaper
// lowers its number; one that makes it dearer says why.

import { describe, expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import * as z from "zod";

import { createRunTraces } from "@/server/kernel/tracing.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { busyThread, subagentsIdle, subagentsWaiting } from "@/server/testing/busy-thread.ts";
import { queries } from "@/server/testing/tracing.ts";
import { createMemoryStore } from "@/server/memory/store.ts";
import type { ToolSpec } from "@/server/tools/registry.ts";
import { SAVE_MEMORY, SEARCH_MEMORY } from "@/shared/memory.ts";
import { EDITORS } from "@/shared/tools.ts";

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
  // What each call a script makes adds to its run: its two writes, its tool's rules now, and
  // who may use it.
  scriptCall: 30,
  // A run that makes one call, then pauses its script at one that needs approval; and the run
  // that goes on once it is approved, to the reply.
  scriptPause: 220,
  // Going on reads the calls it waited on by their ids, however many it gathered.
  scriptResume: 207,
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

  it("of a script read its tools once, cost the same for each call it makes, and its page the same however many", async () => {
    const echo: ToolSpec<{ n: number }> = {
      name: "echo.say",
      title: "Say",
      description: "Says the number back.",
      input: z.object({ n: z.number() }),
      risk: () => "normal",
      run: async ({ n }) => Promise.resolve({ ok: true, value: { n } }),
    };
    // Held shut until the test opens it.
    let gate = Promise.withResolvers<void>();
    const t = await agentThread(
      {},
      {
        traces: createRunTraces(),
        toolsets: [
          {
            id: "echo",
            title: "Echo",
            source: "builtin",
            tools: [
              echo,
              { ...echo, name: "echo.ask", title: "Ask", risk: () => "ask" },
              {
                ...echo,
                name: "echo.gate",
                title: "Gate",
                run: async ({ n }) => {
                  await gate.promise;
                  return { ok: true, value: { n } };
                },
              },
            ],
          },
        ],
      },
    );
    await t.start();
    // A thread whose one run is a script that makes `calls` calls; what the run read.
    const scripted = async (calls: number) => {
      const thread = await t.createThread(t.ada.cookie, t.space.id);
      const run = await queries(async () => {
        const res = await t.api("POST", `/threads/${thread.id}/messages`, t.ada.cookie, {
          text: "Count",
          mode: "steer",
        });
        expect(res.status).toBe(202);
        const call = await t.model.next();
        call.startStep();
        call.toolCall(`s${calls}`, "scripts.run", {
          // Gathered, so they run at once, each costing what one alone does.
          code: `import asyncio\nawait asyncio.gather(*[call_tool("echo__say", {"n": i}) for i in range(${calls})])`,
        });
        call.endStep();
        call.end();
        (await t.model.next()).reply("Counted.");
        await t.worker.idle();
      }, "run");
      expect(run.count).toBeGreaterThan(0);
      return { thread: thread.id, run };
    };
    const naming = (texts: string[], table: string) =>
      texts.filter((text) => new RegExp(`\\b${table}\\b`).test(text)).length;
    // What a script reads once; the tools' rules it reads again for each call, as they may change.
    const setUp = ["mcp_server", "thread_tool", "thread_input"];
    // The first run reads what later ones find cached, as the model's connection.
    await scripted(1);
    const one = await scripted(1);
    const two = await scripted(2);
    const five = await scripted(5);
    const ten = await scripted(10);
    // Read once per script, however many calls it makes.
    expect(setUp.map((table) => naming(five.run.texts, table))).toEqual(
      setUp.map((table) => naming(one.run.texts, table)),
    );
    // Each call costs what the one before it did.
    const each = two.run.count - one.run.count;
    expect(five.run.count - one.run.count).toBe(4 * each);
    expect(each).toBeLessThanOrEqual(MAX.scriptCall);
    const page = async (threadId: string) =>
      (
        await queries(async () => {
          const res = await t.api("GET", `/threads/${threadId}`, t.ada.cookie);
          expect(res.status).toBe(200);
          await res.text();
        })
      ).count;
    const short = await page(one.thread);
    expect(short).toBeGreaterThan(0);
    expect(await page(ten.thread)).toBe(short);

    // A script that pauses at a call needing approval after `calls` calls; what its run read up
    // to the pause, and then once the call was approved.
    const paused = async (calls: number) => {
      const thread = await t.createThread(t.ada.cookie, t.space.id);
      const pause = await queries(async () => {
        const res = await t.api("POST", `/threads/${thread.id}/messages`, t.ada.cookie, {
          text: "Count",
          mode: "steer",
        });
        expect(res.status).toBe(202);
        const call = await t.model.next();
        call.startStep();
        call.toolCall(`p${calls}`, "scripts.run", {
          code: `[await call_tool("echo__say", {"n": i}) for i in range(${calls})]\nawait call_tool("echo__ask", {"n": 0})`,
        });
        call.endStep();
        call.end();
        await t.worker.idle();
      }, "run");
      const waiting = await t.db.execute<{ id: string }>(
        sql`select id from call where thread_id = ${thread.id} and status = 'waiting'`,
      );
      const resume = await queries(async () => {
        const res = await t.api(
          "POST",
          `/threads/${thread.id}/tools/${waiting.rows[0]!.id}/decision`,
          t.ada.cookie,
          { allow: true, scope: "once" },
        );
        expect(res.status).toBe(200);
        (await t.model.next()).reply("Counted.");
        await t.worker.idle();
      }, "run");
      expect(resume.count).toBeGreaterThan(0);
      return { pause: pause.count, resume: resume.count };
    };
    const after1 = await paused(1);
    const after2 = await paused(2);
    const after5 = await paused(5);
    // Going on reads nothing of the calls before; pausing adds only what each call costs.
    expect(after5.resume).toBe(after1.resume);
    expect(after1.pause).toBeLessThanOrEqual(MAX.scriptPause);
    expect(after1.resume).toBeLessThanOrEqual(MAX.scriptResume);
    expect(after5.pause - after1.pause).toBe(4 * (after2.pause - after1.pause));

    // The same script in the background: each call costs what one alone does.
    const background = async (calls: number) => {
      const thread = await t.createThread(t.ada.cookie, t.space.id);
      gate = Promise.withResolvers<void>();
      const job = await queries(async () => {
        const res = await t.api("POST", `/threads/${thread.id}/messages`, t.ada.cookie, {
          text: "In the background",
          mode: "steer",
        });
        expect(res.status).toBe(202);
        const call = await t.model.next();
        call.startStep();
        call.toolCall(`b${calls}`, "jobs.start", {
          tool: "scripts__run",
          input: {
            code: `await call_tool("echo__gate", {"n": 0})\n[await call_tool("echo__say", {"n": i}) for i in range(${calls})]`,
          },
        });
        call.endStep();
        call.end();
        (await t.model.next()).reply("Started.");
        await t.worker.idle();
        // The job goes on once its run has ended, and its end wakes a run of its own.
        gate.resolve();
        (await t.model.next()).reply("Done.");
        await t.worker.idle();
      }, "run");
      return job.count;
    };
    const bg1 = await background(1);
    const bg2 = await background(2);
    const bg5 = await background(5);
    expect(bg1).toBeGreaterThan(0);
    expect(bg5 - bg1).toBe(4 * (bg2 - bg1));
    expect(bg2 - bg1).toBeGreaterThan(0);
    expect(bg2 - bg1).toBeLessThanOrEqual(MAX.scriptCall);
  });

  it("of a thread page stay the same however deep and however many the calls nested in it", async () => {
    // A tool that runs until it is stopped.
    const hold: ToolSpec<{ n: number }> = {
      name: "echo.hold",
      title: "Hold",
      description: "Holds on.",
      input: z.object({ n: z.number() }),
      risk: () => "normal",
      run: async (_input, ctx) =>
        new Promise((resolve) =>
          ctx.signal?.addEventListener("abort", () => resolve({ ok: false, error: "stopped" })),
        ),
    };
    const t = await agentThread(
      {},
      { toolsets: [{ id: "echo", title: "Echo", source: "builtin", tools: [hold] }] },
    );
    await t.start();
    // A thread where a script started `jobs` jobs, each a call two levels under it.
    const nested = async (jobs: number) => {
      const thread = await t.createThread(t.ada.cookie, t.space.id);
      const res = await t.api("POST", `/threads/${thread.id}/messages`, t.ada.cookie, {
        text: "Start them",
        mode: "steer",
      });
      expect(res.status).toBe(202);
      const call = await t.model.next();
      call.startStep();
      call.toolCall(`n${jobs}`, "scripts.run", {
        code: `[await call_tool("jobs__start", {"tool": "echo__hold", "input": {"n": i}}) for i in range(${jobs})]`,
      });
      call.endStep();
      call.end();
      (await t.model.next()).reply("Started.");
      await t.worker.idle();
      const page = await queries(async () => {
        const read = await t.api("GET", `/threads/${thread.id}`, t.ada.cookie);
        expect(read.status).toBe(200);
        return (await read.json()) as { rows: { depth?: number }[] };
      });
      expect(page.result.rows.filter((row) => row.depth === 2)).toHaveLength(jobs);
      return page.count;
    };
    const one = await nested(1);
    expect(one).toBeGreaterThan(0);
    expect(await nested(4)).toBe(one);
  });

  it("of a decision stay the same however many calls wait beside it", async () => {
    const say: ToolSpec<{ n: number }> = {
      name: "echo.say",
      title: "Say",
      description: "Says the number back.",
      input: z.object({ n: z.number() }),
      risk: () => "normal",
      run: async ({ n }) => Promise.resolve({ ok: true, value: { n } }),
    };
    const t = await agentThread(
      {},
      { toolsets: [{ id: "echo", title: "Echo", source: "builtin", tools: [say] }] },
    );
    await t.start();
    // Ada's calls of it wait for an approver.
    const signOff = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "some",
      users: [`user:${t.grace.userId}`],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["echo.say"], signOff.id);
    // A thread whose run waits on `calls` calls; what allowing the first for now reads, which
    // judges each of the others again.
    const decided = async (calls: number) => {
      const thread = await t.createThread(t.ada.cookie, t.space.id);
      const res = await t.api("POST", `/threads/${thread.id}/messages`, t.ada.cookie, {
        text: "Ask",
        mode: "steer",
      });
      expect(res.status).toBe(202);
      const call = await t.model.next();
      call.startStep();
      for (let n = 0; n < calls; n += 1) call.toolCall(`a${calls}-${n}`, "echo.say", { n });
      call.endStep();
      call.end();
      await t.worker.idle();
      const { texts } = await queries(async () => {
        const allowed = await t.api(
          "POST",
          `/threads/${thread.id}/tools/a${calls}-0/decision`,
          t.ada.cookie,
          { allow: true, scope: "for_now" },
        );
        expect(allowed.status).toBe(200);
      });
      // Signals sent once the write is kept come as the listeners are woken, some before the
      // count ends and some after.
      const count = texts.filter((text) => !text.includes("pg_notify")).length;
      (await t.model.next()).reply("Said.");
      await t.worker.idle();
      return count;
    };
    await decided(2);
    const two = await decided(2);
    expect(two).toBeGreaterThan(0);
    expect(await decided(6)).toBe(two);
  });
});

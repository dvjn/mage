// Calls through their rows: the state each call is recorded in as a run asks for it, each guarded
// change people make, what a run's end leaves, a move asked of a running call, writes fenced by the
// lease the call runs under, and what waits on whom.

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import * as z from "zod";

import type { ToolSpec } from "@/server/tools/registry.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { expireLeases } from "@/server/testing/database.ts";
import { deadlockOnce, setup } from "@/server/testing/workspace.ts";
import { influenceIn, influenceOf } from "@/server/calls/influence.ts";
import { latestAuthor } from "@/server/tools/authority.ts";
import { lastWriter } from "@/server/tools/registry.ts";
import { EDITORS } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

// Tools for the tests: one that runs until finished by its label, writing to the thread first when
// asked to, and one that needs approval.
function probe() {
  const open = new Map<string, (output: { ok: true; value: unknown }) => void>();
  const writes = new Map<string, () => Promise<unknown>>();
  const wait: ToolSpec<{ label: string }> = {
    name: "probe.wait",
    title: "Wait",
    description: "Waits.",
    input: z.object({ label: z.string() }),
    risk: () => "normal",
    run({ label }, ctx) {
      writes.set(label, async () =>
        ctx.write(async (append) =>
          append({
            type: "message.completed",
            actor: { kind: "agent" },
            data: { messageId: `late-${label}`, runId: ctx.runId, parts: [], status: "completed" },
          }),
        ),
      );
      return new Promise((resolve) => {
        open.set(label, resolve);
        ctx.signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }));
      });
    },
  };
  const guarded: ToolSpec<{ label: string }> = {
    name: "probe.guarded",
    title: "Guarded",
    description: "Needs approval.",
    input: z.object({ label: z.string() }),
    risk: () => "ask",
    run: ({ label }) => Promise.resolve({ ok: true, value: { did: label } }),
  };
  return {
    toolset: { id: "probe", title: "Probe", source: "builtin" as const, tools: [wait, guarded] },
    running: (label: string) => open.has(label),
    finish: (label: string) => open.get(label)?.({ ok: true, value: label }),
    // Has the running call with the label write to its thread, as a tool may.
    write: async (label: string) => writes.get(label)!(),
  };
}

async function until(condition: () => boolean | Promise<boolean>) {
  for (let tries = 0; !(await condition()); tries++) {
    if (tries > 2000) throw new Error("never happened");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function callThread(options: Parameters<typeof setup>[1] = {}) {
  const tool = probe();
  const t = await agentThread({}, { toolsets: [tool.toolset], ...options });
  await t.start();
  let made = 0;
  // The model's next call, asking for the tool calls in one step; answers their ids.
  async function asks(...asked: [string, unknown][]) {
    const call = await t.model.next();
    call.startStep();
    const ids = asked.map(([toolId, input]) => {
      made += 1;
      call.toolCall(`c${made}`, toolId, input);
      return `c${made}`;
    });
    call.endStep();
    call.end();
    return ids;
  }
  async function rows() {
    return (
      await t.db.execute<{
        id: string;
        status: string;
        waits_for: string | null;
        background: boolean;
      }>(
        sql`select id, status, waits_for, background from call where thread_id = ${t.thread.id}
             order by created_at, id`,
      )
    ).rows;
  }
  const statuses = async () =>
    Object.fromEntries((await rows()).map((row) => [row.id, row.status]));
  function act(path: string, who = t.ada, body?: object) {
    return t.api("POST", `/threads/${t.thread.id}/tools/${path}`, who.cookie, body);
  }
  return { ...t, tool, asks, rows, statuses, act };
}

describe("a run's calls", () => {
  it("are recorded as they first stand: failed, waiting for a decision, ready, then running", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [unknown, bad, guarded, wait] = await t.asks(
      ["probe.nothing", {}],
      ["probe.wait", { label: 7 }],
      ["probe.guarded", { label: "g" }],
      ["probe.wait", { label: "w" }],
    );
    await until(() => t.tool.running("w"));
    expect(await t.statuses()).toEqual({
      [unknown!]: "failed",
      [bad!]: "failed",
      [guarded!]: "waiting",
      [wait!]: "running",
    });
    expect((await t.rows()).find((row) => row.id === guarded)?.waits_for).toBe("decision");
    t.tool.finish("w");
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.statuses())[wait!]).toBe("completed");

    // Stopped while it waits: what had not ended will not run.
    expect((await t.api("POST", `/threads/${t.thread.id}/stop`, t.ada.cookie)).status).toBe(202);
    await t.worker.idle();
    expect((await t.statuses())[guarded!]).toBe("cancelled");
  });

  it("judged again after a decision stay waiting, written by nobody until they start", async () => {
    const t = await callThread();
    const policy = async (fields: { users: string[]; approvers: string[] }) =>
      t.toolPolicyStore.create({
        orgId: t.ada.orgId,
        spaceId: null,
        name: "Sign-off",
        color: "orange",
        use: "some",
        independent: false,
        ...fields,
      });
    const signOff = await policy({ users: [`user:${t.grace.userId}`], approvers: [EDITORS] });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], signOff.id);
    await t.post(t.ada, "Twice");
    const [d0, d1] = await t.asks(["probe.wait", { label: "0" }], ["probe.wait", { label: "1" }]);
    await t.worker.idle();
    expect(await t.statuses()).toEqual({ [d0!]: "waiting", [d1!]: "waiting" });
    await t.worker.stop();
    expect((await t.act(`${d0}/decision`, t.ada, { allow: true, scope: "for_now" })).status).toBe(
      200,
    );
    // Covered by Ada's vouch, the other is not let run until something starts it.
    expect((await t.statuses())[d1!]).toBe("waiting");
    // Only Grace may approve from now on, so Ada's vouch no longer holds.
    const graceOnly = await policy({ users: [], approvers: [`user:${t.grace.userId}`] });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], graceOnly.id);
    await t.worker.start();
    await t.worker.idle();
    expect((await t.act(`${d1}/decision`, t.grace, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    await until(() => t.tool.running("1"));
    t.tool.finish("1");
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
    expect(await t.statuses()).toEqual({ [d0!]: "stale", [d1!]: "completed" });
  });

  it("are decided once: a second decision, or a denial after an approval, changes nothing", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [guarded] = await t.asks(["probe.guarded", { label: "g" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${guarded}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    expect(
      (await t.act(`${guarded}/decision`, t.ada, { allow: false, scope: "once" })).status,
    ).toBe(409);
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
    expect(await t.statuses()).toEqual({ [guarded!]: "completed" });
    expect((await t.types()).filter((type) => type === "tool.denied")).toEqual([]);
  });

  it("move to the background when asked while running, at the keeper's next beat without a hint", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [wait] = await t.asks(["probe.wait", { label: "w" }]);
    await until(() => t.tool.running("w"));
    // Asked as another instance would, whose hint this one missed.
    await t.db.execute(
      sql`update call set move_requested_at = now() where thread_id = ${t.thread.id} and id = ${wait}`,
    );
    await t.calls.beat();
    const after = await t.model.next();
    expect(after.texts.at(-1)).toMatch(/"movedToBackground":true/);
    after.reply("Carrying on.");
    await t.worker.idle();
    const rows = await t.rows();
    expect(rows.map((row) => [row.id, row.status, row.background])).toEqual([
      [wait, "running", true],
    ]);
    t.tool.finish("w");
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    expect((await t.rows())[0]?.status).toBe("completed");
  });

  it("moves to the background at once while it waits for a decision, and its run goes on", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [guarded] = await t.asks(["probe.guarded", { label: "g" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${guarded}/background`)).status).toBe(200);
    (await t.model.next()).reply("Carrying on.");
    await t.worker.idle();
    expect(
      (await t.rows()).map((row) => [row.id, row.status, row.waits_for, row.background]),
    ).toEqual([[guarded, "waiting", "decision", true]]);
  });

  it("refuse a move of a call that is not running", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [wait] = await t.asks(["probe.wait", { label: "w" }]);
    await until(() => t.tool.running("w"));
    t.tool.finish("w");
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
    expect((await t.act(`${wait}/background`)).status).toBe(409);
  });
});

describe("a call's writes", () => {
  it("are refused once the run it runs under has lost its lease", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    await t.asks(["probe.wait", { label: "w" }]);
    await until(() => t.tool.running("w"));
    const before = (await t.types()).length;
    await t.db.execute(sql`update run set lease_owner = 'another', lease_epoch = lease_epoch + 1`);
    await expect(t.tool.write("w")).rejects.toThrow(/lease/);
    expect(await t.types()).toHaveLength(before);
    // Let the run go as the instance that took it would.
    await t.db.execute(sql`update run set lease_owner = null, lease_expires_at = to_timestamp(0)`);
    t.tool.finish("w");
  });

  it("are refused for a job once its lease is taken", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    await until(() => t.tool.running("j"));
    const before = (await t.types()).length;
    await t.db.execute(sql`update call set lease_owner = 'another' where background`);
    await expect(t.tool.write("j")).rejects.toThrow(/lease/);
    expect(await t.types()).toHaveLength(before);
    await expireLeases(t.db, "call");
    await t.calls.recover();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
  });
});

describe("a job's end written again", () => {
  it("leaves what is in memory and in the database as one write would", async () => {
    const t = await callThread();
    const deadlock = deadlockOnce();
    t.queue.onEnqueued(async (input) => {
      if (input.origin.kind === "job") deadlock();
    });
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    await until(() => t.tool.running("j"));
    const retries = t.sync.stats.retries;
    t.tool.finish("j");
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    expect(t.sync.stats.retries).toBeGreaterThan(retries);
    const job = (await t.rows()).find((row) => row.background)!;
    expect(job.status).toBe("completed");
    const events = await t.events();
    expect(
      events.filter((one) => one.type === "tool.ran" && one.data.callId === job.id),
    ).toHaveLength(1);
    expect(events.filter((one) => one.type === "notice")).toHaveLength(1);
    // Nothing of it is still held here, nor kept of what it printed.
    expect(t.logLines.filter((line) => JSON.stringify(line).includes("not recorded"))).toEqual([]);
    const kept = await t.db.execute(sql`select call_id from call_output`);
    expect(kept.rows).toEqual([]);
  });
});

describe("what waits on whom", () => {
  it("is each waiting call of the threads named, with whether the reader may act on it", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [guarded] = await t.asks(
      ["probe.guarded", { label: "g" }],
      ["jobs.start", { tool: "probe.guarded", input: { label: "j" } }],
    );
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    const waiting = async (who: { userId: string }) =>
      (await t.calls.waitingOn(who, [t.thread.id]))
        .map((one) => [one.call.background ? "job" : one.call.id, one.waitsFor, one.canAct])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(await waiting(t.ada)).toEqual([
      [guarded, "decision", true],
      ["job", "decision", true],
    ]);
    expect(await waiting(t.alan)).toEqual([
      [guarded, "decision", false],
      ["job", "decision", false],
    ]);
    expect(
      (await t.act(`${guarded}/decision`, t.grace, { allow: true, scope: "once" })).status,
    ).toBe(200);
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
    expect(await waiting(t.ada)).toEqual([["job", "decision", true]]);
    expect(await waiting(t.alan)).toEqual([["job", "decision", false]]);
  });
});

describe("a step's calls", () => {
  it("run with the tools the step was offered, though one is turned off meanwhile", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const call = await t.model.next();
    const offered = (call.request.tools ?? []).map((tool) => tool.id);
    expect(offered).toContain("probe.wait");
    call.startStep();
    call.toolCall("c1", "probe.wait", { label: "a" });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], "off");
    call.endStep();
    call.end();
    await until(() => t.tool.running("a"));
    t.tool.finish("a");
    const next = await t.model.next();
    expect((next.request.tools ?? []).map((tool) => tool.id)).not.toContain("probe.wait");
    next.reply("Done.");
    await t.worker.idle();
    expect((await t.rows()).map((row) => [row.id, row.status])).toEqual([["c1", "completed"]]);
  });

  it("go stale when their tool is turned off while they wait, once the run goes on", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const [id] = await t.asks(["probe.guarded", { label: "a" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.guarded"], "off");
    expect((await t.act(`${id}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(200);
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
    expect((await t.rows()).map((row) => [row.id, row.status])).toEqual([[id, "stale"]]);
  });
});

describe("an approved job", () => {
  // Approves the job the agent asked for through the instance, whose keeper of jobs is stopped.
  async function approvedOnStopped() {
    const t = await callThread();
    const b = setup({}, { database: t.database, toolsets: [t.tool.toolset] });
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.guarded", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const job = (await t.rows()).find((row) => row.background)!;
    await t.calls.stop();
    const res = await t.api(
      "POST",
      `/threads/${t.thread.id}/tools/${job.id}/decision`,
      t.ada.cookie,
      {
        allow: true,
        scope: "once",
      },
    );
    expect(res.status).toBe(200);
    return { t, b, job };
  }

  it("left ready by an instance that stopped after the approval was kept is started by another", async () => {
    const { t, b, job } = await approvedOnStopped();
    expect((await t.callStore.find(t.thread.id, job.id))?.status).toBe("ready");
    await b.calls.beat();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    expect((await t.callStore.find(t.thread.id, job.id))?.status).toBe("completed");
    expect((await t.types()).filter((type) => type === "tool.ran")).toHaveLength(2);
  });
});

describe("an approved job that cannot be started for now", () => {
  it("stays waiting its turn after a failure, and starts on a later sweep", async () => {
    const t = await callThread();
    const b = setup({}, { database: t.database, toolsets: [t.tool.toolset] });
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.guarded", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const job = (await t.rows()).find((row) => row.background)!;
    await t.calls.stop();
    const res = await t.api(
      "POST",
      `/threads/${t.thread.id}/tools/${job.id}/decision`,
      t.ada.cookie,
      {
        allow: true,
        scope: "once",
      },
    );
    expect(res.status).toBe(200);
    vi.spyOn(b.tools, "offered").mockRejectedValueOnce(new Error("for the test"));
    await b.calls.beat();
    expect((await t.callStore.find(t.thread.id, job.id))?.status).toBe("ready");
    await b.calls.beat();
    await vi.waitFor(async () =>
      expect((await t.callStore.find(t.thread.id, job.id))?.status).toBe("completed"),
    );
    await b.calls.stop();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("calls on Postgres", () => {
  it("start a job approved through an instance whose keeper never beats once, as two others sweep", async () => {
    const t = await callThread();
    const b = setup({}, { database: t.database, toolsets: [t.tool.toolset] });
    const c = setup({}, { database: t.database, toolsets: [t.tool.toolset] });
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.guarded", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const job = (await t.rows()).find((row) => row.background)!;
    await t.calls.stop();
    const res = await t.api(
      "POST",
      `/threads/${t.thread.id}/tools/${job.id}/decision`,
      t.ada.cookie,
      {
        allow: true,
        scope: "once",
      },
    );
    expect(res.status).toBe(200);
    await Promise.all([b.calls.beat(), c.calls.beat()]);
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    expect((await t.types()).filter((type) => type === "tool.ran")).toHaveLength(2);
  });

  it("launch a job approved through two instances at once only once", async () => {
    const t = await callThread();
    const b = setup({}, { database: t.database, toolsets: [t.tool.toolset] });
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "probe.guarded", input: { label: "j" } }]);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const job = (await t.rows()).find((row) => row.background);
    const decide = (api: typeof t.api) =>
      api("POST", `/threads/${t.thread.id}/tools/${job!.id}/decision`, t.ada.cookie, {
        allow: true,
        scope: "once",
      });
    const codes = (await Promise.all([decide(t.api), decide(b.api)])).map((res) => res.status);
    expect(codes.toSorted((a, b) => a - b)).toEqual([200, 409]);
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    expect((await t.types()).filter((type) => type === "tool.ran")).toHaveLength(2);
  });

  it("hold a thread to its limit of running jobs when several start at once, queueing the rest", async () => {
    const t = await callThread();
    await t.post(t.ada, "Go");
    const starts = Array.from({ length: 9 }, (_, index): [string, unknown] => [
      "jobs.start",
      { tool: "probe.wait", input: { label: `j${index}` } },
    ]);
    await t.asks(...starts);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    // Eight run; the ninth waits its turn.
    expect(
      (await t.rows())
        .filter((row) => row.background)
        .map((row) => row.status)
        .toSorted(),
    ).toEqual(["ready", ...Array(8).fill("running")]);
    await expireLeases(t.db, "call");
    await t.calls.recover();
    for (;;) {
      const next = await Promise.race([
        t.model.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (!next) break;
      next.reply("Noted.");
    }
    await t.worker.idle();
  });
});

// A thread whose tools say whose words they were run with, and one that turns tools on as the
// search for left-out tools does.
async function seeingThread(searching = false) {
  const seen: { label: string; influence: unknown; input: unknown }[] = [];
  let turnOn: ((ids: string[]) => Promise<void>) | null = null;
  let release: (() => void) | null = null;
  let endJob = () => {};
  const jobDone = new Promise<void>((resolve) => (endJob = resolve));
  const see: ToolSpec<{ label: string; pad?: string }> = {
    name: "seeing.see",
    title: "See",
    description: "Says whose words it runs with.",
    input: z.object({ label: z.string(), pad: z.string().optional() }),
    risk: () => "normal",
    run: async (input, ctx) => {
      seen.push({ label: input.label, influence: ctx.influence, input });
      // A job goes on until the test lets it end.
      if (ctx.background) await jobDone;
      return { ok: true, value: input.label };
    },
  };
  const search: ToolSpec<Record<string, never>> = {
    name: "seeing.search",
    title: "Search",
    description: "Turns tools on.",
    input: z.object({}).strict() as z.ZodType<Record<string, never>>,
    risk: () => "normal",
    deferral: "search",
    run: async (_input, ctx) => {
      const deferred = ctx.deferred;
      turnOn = deferred ? async (ids) => deferred.turnOn(ids) : null;
      await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, value: null };
    },
  };
  const toolset = {
    id: "seeing",
    title: "Seeing",
    source: "builtin" as const,
    tools: searching ? [see, search] : [see],
  };
  const tool = probe();
  const t = await callThread({ toolsets: [tool.toolset, toolset] });
  const words = async () =>
    (await t.queue.words(t.thread.id)).map((word) => `${word.seq} ${word.name}`);
  // What the thread's fold says the agent read, up to the row with the id when one is given.
  async function folded(before?: string) {
    const rows = transcriptOf(await t.events()).rows;
    const at = before ? rows.findIndex((row) => row.id === before) : -1;
    return influenceIn(at === -1 ? rows : rows.slice(0, at));
  }
  return {
    ...t,
    tool,
    seen,
    words,
    folded,
    turnOn: async (ids: string[]) => turnOn!(ids),
    searching: () => turnOn !== null,
    release: () => release?.(),
    endJob: () => endJob(),
  };
}

describe("whose words the agent read", () => {
  it("are recorded where it read them: a message as it is taken in, an aside at once, an answer once given", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Go");
    const [ask] = await t.asks([
      "thread.ask",
      {
        questions: [
          { question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    ]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    const admitted = (await t.events()).find((event) => event.type === "message.admitted")!;
    expect(await t.words()).toEqual([`${admitted.seq} Ada Lovelace`]);

    const aside = await t.post(t.grace, "// between us");
    const asideSeq = (await t.events()).find((event) => event.id === aside.id)!.seq;
    expect(await t.words()).toEqual([`${admitted.seq} Ada Lovelace`, `${asideSeq} Grace Hopper`]);

    expect((await t.act(`${ask}/answer`, t.grace, { answers: { "Which?": "A" } })).status).toBe(
      200,
    );
    const answered = (await t.events()).find((event) => event.type === "tool.answered")!;
    expect(await t.words()).toEqual([
      `${admitted.seq} Ada Lovelace`,
      `${asideSeq} Grace Hopper`,
      `${answered.seq} Grace Hopper`,
    ]);

    // The call after the answer runs with everyone the fold says the agent read.
    await t.asks(["seeing.see", { label: "after" }]);
    await until(() => t.seen.length === 1);
    expect(t.seen[0]!.influence).toEqual(await t.folded());
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
  });

  it("are not recorded for a skipped question or a message taken back", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Go");
    const [ask] = await t.asks([
      "thread.ask",
      {
        questions: [
          { question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    ]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    const queued = await t.post(t.grace, "Later", "queue");
    const res = await t.api(
      "DELETE",
      `/threads/${t.thread.id}/messages/${queued.id}`,
      t.grace.cookie,
    );
    expect(res.status).toBe(200);
    expect((await t.act(`${ask}/answer`, t.grace, { answers: null })).status).toBe(200);
    (await t.model.next()).reply("Fine.");
    await t.worker.idle();
    const admitted = (await t.events()).find((event) => event.type === "message.admitted")!;
    expect(await t.words()).toEqual([`${admitted.seq} Ada Lovelace`]);
  });

  it("carry into a foreground call and a job as the fold says the agent had read them", async () => {
    const t = await seeingThread();
    await t.post(t.grace, "Look");
    await t.asks(["seeing.see", { label: "now" }]);
    await until(() => t.seen.length === 1);
    expect(t.seen[0]!.influence).toEqual(await t.folded());
    expect(t.seen[0]!.influence).toEqual([
      { userId: t.grace.userId, name: "Grace Hopper", via: [] },
    ]);
    const [job] = await t.asks(["jobs.start", { tool: "seeing.see", input: { label: "job" } }]);
    await until(() => t.seen.length === 2);
    const started = (
      await t.db.execute<{ id: string }>(
        sql`select id from call where thread_id = ${t.thread.id} and background`,
      )
    ).rows[0]!.id;
    expect(job).toBeDefined();
    expect(t.seen[1]!.influence).toEqual(await t.folded(started));
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    t.endJob();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
  });

  it("ran with an input of any size, as its request holds it", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Big");
    const pad = "x".repeat(200_000);
    await t.asks(["seeing.see", { label: "big", pad }]);
    await until(() => t.seen.length === 1);
    expect(t.seen[0]!.input).toEqual({ label: "big", pad });
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
  });

  it("are read for a call's decision, answer and wait without the thread's transcript", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Go");
    const [guarded] = await t.asks(["probe.guarded", { label: "g" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    const of = vi.spyOn(t.transcripts, "of");
    await t.calls.waitingOn({ userId: t.ada.userId }, [t.thread.id]);
    const thread = (await t.threadStore.find(t.thread.id))!;
    const reader = await t.access.reader({ ...t.ada, role: "member" } as never, thread);
    await t.calls.decide(reader, guarded!, { allow: true, scope: "once" });
    expect(of).not.toHaveBeenCalled();
    of.mockRestore();
    (await t.model.next()).reply("Done.");
    await t.worker.idle();
  });
});

describe("whose words were before", () => {
  const question = (q: string) => ({
    questions: [{ question: q, header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
  });

  // The fold read the rows asked for before an answer, so a later answer to a call asked earlier
  // counted as written before it; the rule asks who wrote before the answer was given.
  it("an answer are those written before it was given, not a later answer to a call asked earlier", async () => {
    const t = await seeingThread();
    await t.post(t.grace, "Two questions");
    const [first, second] = await t.asks(
      ["thread.ask", question("One?")],
      ["thread.ask", question("Two?")],
    );
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${second}/answer`, t.ada, { answers: { "Two?": "A" } })).status).toBe(200);
    expect((await t.act(`${first}/answer`, t.ada, { answers: { "One?": "B" } })).status).toBe(200);
    (await t.model.next()).reply("Thanks.");
    await t.worker.idle();
    const events = await t.events();
    const answeredSecond = events.find(
      (event) => event.type === "tool.answered" && event.data.callId === second,
    )!.seq;
    const rows = transcriptOf(events).rows;
    const byFold = latestAuthor(
      rows.filter((row) => row.seq < answeredSecond && row.id !== second),
    );
    const byRows = lastWriter(
      (await t.queue.words(t.thread.id)).filter((word) => word.seq < answeredSecond),
    );
    expect({ byRows, byFold }).toEqual({ byRows: t.grace.userId, byFold: t.ada.userId });
  });

  // The fold read the rows before the job's, so an answer given after the job was asked for, to a
  // call asked before it, counted as steering it.
  it("a job are those the agent had read when it was asked for, not a later answer", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Ask and start");
    const [ask, start] = await t.asks(
      ["thread.ask", question("Which?")],
      ["jobs.start", { tool: "seeing.see", input: { label: "job" } }],
    );
    await until(() => t.seen.length === 1);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${ask}/answer`, t.grace, { answers: { "Which?": "A" } })).status).toBe(
      200,
    );
    (await t.model.next()).reply("Answered.");
    await t.worker.idle();
    t.endJob();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    const events = await t.events();
    const job = (
      await t.db.execute<{ id: string }>(
        sql`select id from call where thread_id = ${t.thread.id} and background`,
      )
    ).rows[0]!.id;
    const ended = events.find(
      (event) => event.type === "notice" && event.data.kind === "call.ended",
    )!;
    const told = ended.type === "notice" ? ended.data.influence : [];
    expect(start).toBeDefined();
    expect(told).toEqual([{ userId: t.ada.userId, name: "Ada Lovelace", via: [] }]);
    expect(t.seen[0]!.influence).toEqual(told);
    const rows = transcriptOf(events).rows;
    const byFold = influenceIn(
      rows.slice(
        0,
        rows.findIndex((row) => row.id === job),
      ),
    );
    expect(byFold.map((one) => one.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });
});

describe("whose words a restore leaves out", () => {
  // A job's row is touched when it ends, so a restore from a reply before that end takes in the
  // log up to it, though the rows after the reply are left out: an aside and a quiet notice sent
  // meanwhile are not read on the new branch, until the notice is taken in there. The job's end,
  // whose start the new branch holds, is told there again and wakes it.
  it("are not read on the new branch until taken in there", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "seeing.see", input: { label: "job" } }]);
    await until(() => t.seen.length === 1);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const aside = await t.post(t.grace, "// while it runs");
    await t.queue.enqueue(t.thread.id, {
      kind: "notice",
      notice: {
        kind: "agent.idle",
        source: { threadId: t.thread.id, name: "Helper", main: false },
        text: "Quietly",
        wake: false,
        influence: [{ userId: t.grace.userId, name: "Grace Hopper", via: [] }],
      },
    });
    t.endJob();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();
    const asideSeq = (await t.events()).find((event) => event.id === aside.id)!.seq;
    expect(await t.words()).toContain(`${asideSeq} Grace Hopper`);

    const started = transcriptOf(await t.events()).rows.find(
      (row) => row.kind === "agent" && row.text === "Started.",
    )!;
    const res = await t.api("POST", `/threads/${t.thread.id}/history`, t.ada.cookie, {
      action: "restore",
      rowId: started.id,
      confirm: true,
    });
    expect(res.status).toBe(200);
    // The quiet notice waits on the new branch, and is read where its next run takes it in.
    (await t.model.next()).reply("Told.");
    await t.worker.idle();
    const words = await t.words();
    expect(words).not.toContain(`${asideSeq} Grace Hopper`);
    const taken = (await t.events()).filter((event) => event.type === "message.admitted").at(-1)!;
    expect(words).toContain(`${taken.seq} Grace Hopper`);
    expect(influenceOf(await t.queue.words(t.thread.id))).toEqual(await t.folded());
  });
});

describe("a vouch for now", () => {
  it("given on a branch since left, after where the new one starts, does not count there", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "First");
    (await t.model.next()).reply("One.");
    await t.worker.idle();
    await t.post(t.grace, "Second");
    const [guarded] = await t.asks(["probe.guarded", { label: "g" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${guarded}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    (await t.model.next()).reply("Two.");
    await t.worker.idle();
    // Given for now: what the rule reads of it is the row and where its decision is.
    await t.db.execute(sql`update call set scope = 'for_now' where id = ${guarded!}`);
    const branch = (await t.threadStore.find(t.thread.id))!.currentBranchId;
    expect((await t.callStore.vouches(t.thread.id, branch)).map((vouch) => vouch.callId)).toEqual([
      guarded,
    ]);
    // Back to the first reply: the new branch starts before the vouch.
    const rows = transcriptOf(await t.events()).rows;
    const one = rows.find((row) => row.kind === "agent" && row.text === "One.")!;
    const res = await t.api("POST", `/threads/${t.thread.id}/history`, t.ada.cookie, {
      action: "restore",
      rowId: one.id,
      confirm: true,
    });
    expect(res.status).toBe(200);
    const after = (await t.threadStore.find(t.thread.id))!.currentBranchId;
    expect(after).not.toBe(branch);
    expect(await t.callStore.vouches(t.thread.id, after)).toEqual([]);
  });
});

describe("a call a restore leaves out", () => {
  // The restore takes the log up to the job's end, after the call: the call is left out with the
  // rows after the restored reply, and so is its vouch.
  it("neither counts as a vouch for now nor can be decided on the new branch", async () => {
    const t = await seeingThread();
    await t.post(t.ada, "Go");
    await t.asks(["jobs.start", { tool: "seeing.see", input: { label: "job" } }]);
    await until(() => t.seen.length === 1);
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    await t.post(t.grace, "Second");
    const [guarded] = await t.asks(["probe.guarded", { label: "g" }]);
    await until(async () => (await t.runs()).at(-1)?.status === "waiting");
    expect((await t.act(`${guarded}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    (await t.model.next()).reply("Two.");
    await t.worker.idle();
    await t.db.execute(sql`update call set scope = 'for_now' where id = ${guarded!}`);
    t.endJob();
    (await t.model.next()).reply("Noted.");
    await t.worker.idle();

    const started = transcriptOf(await t.events()).rows.find(
      (row) => row.kind === "agent" && row.text === "Started.",
    )!;
    const res = await t.api("POST", `/threads/${t.thread.id}/history`, t.ada.cookie, {
      action: "restore",
      rowId: started.id,
      confirm: true,
    });
    expect(res.status).toBe(200);
    const after = (await t.threadStore.find(t.thread.id))!.currentBranchId;
    expect(await t.callStore.vouches(t.thread.id, after)).toEqual([]);
    expect(await t.callStore.onCurrent(t.thread.id, guarded!)).toBeNull();
    expect((await t.act(`${guarded}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      404,
    );
  });
});

describe("tools turned on by a search", () => {
  it("are not turned on once the run has lost its lease", async () => {
    const t = await seeingThread(true);
    await t.post(t.ada, "Find");
    await t.asks(["seeing.search", {}]);
    await until(() => t.searching());
    await t.db.execute(sql`update run set lease_owner = 'another', lease_epoch = lease_epoch + 1`);
    await expect(t.turnOn(["seeing.see"])).rejects.toThrow(/lease/);
    expect((await t.db.execute(sql`select 1 from thread_tool`)).rows).toEqual([]);
    await t.db.execute(sql`update run set lease_owner = null, lease_expires_at = to_timestamp(0)`);
    t.release();
  });
});

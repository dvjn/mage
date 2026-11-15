import { sql } from "drizzle-orm";
import { UnsecuredJWT } from "jose";
import { describe, expect, it, vi } from "vite-plus/test";

import { createCipher } from "@/server/kernel/cipher.ts";
import { createCredentialStore } from "@/server/models/credential-store.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { probe } from "@/server/testing/contract.ts";
import { expireLeases } from "@/server/testing/database.ts";
import {
  type AgentInstance,
  type Instance,
  deafen,
  dropListener,
  freeze,
  instances,
  kill,
  lockThread,
  restore,
  stall,
  thaw,
} from "@/server/testing/instances.ts";
import { openFeed, openStream } from "@/server/testing/sse.ts";
import { MCP_ORIGIN, setup } from "@/server/testing/workspace.ts";
import { LIVE_LIMIT, RUNNING_LIMIT } from "@/server/subagents/subagents.ts";
import { BACKGROUND_LIMIT } from "@/shared/jobs.ts";
import { LARGE_RESULT_CHARS, type LiveChunk } from "@/shared/threads/events.ts";

// Two server instances on one database: `a` with a thread in Ada's space, and `b`.
async function twoInstances() {
  const a = await agentThread();
  const b = setup({}, { database: a.database });
  return { a, b };
}

describe("several server instances on one database", () => {
  it("take over a run only once its lease has run out, and only one of them", async () => {
    const { a, b } = await twoInstances();
    await a.post(a.ada, "Hello");
    // An instance takes the run, then dies.
    const taken = await a.runStore.claim("dead", 60_000);
    expect(taken).not.toBeNull();

    await a.worker.recover();
    await b.worker.recover();
    expect(await a.runs()).toEqual([expect.objectContaining({ status: "running" })]);

    await expireLeases(a.db, "run");
    await b.worker.recover();
    await a.worker.recover();
    expect((await a.runs()).map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["queued", 2],
    ]);
    expect((await a.types()).filter((type) => type === "run.failed")).toHaveLength(1);
  });

  it("fire a due schedule once, whichever instance ticks", async () => {
    const { a, b } = await twoInstances();
    await a.scheduleStore.create({
      id: "wake-1",
      threadId: a.thread.id,
      kind: "once",
      name: "Wake",
      cron: null,
      timezone: null,
      prompt: "Carry on",
      influence: [],
      callId: null,
      nextRunAt: new Date(Date.now() - 1000),
    });
    a.clock.now = new Date();
    b.clock.now = new Date();
    expect((await b.schedules.tick()) + (await a.schedules.tick())).toBe(1);
    expect((await a.schedules.tick()) + (await b.schedules.tick())).toBe(0);
    expect((await a.events()).filter((event) => event.type === "notice")).toHaveLength(1);
    const keyed = await a.db.execute<{ key: string }>(
      sql`select key from thread_input where key like 'schedule:wake-1:%'`,
    );
    expect(keyed.rows).toHaveLength(1);
  });

  it("interrupt a background call left by a dead instance once, telling its thread once", async () => {
    const { a, b } = await twoInstances();
    const run = await a.runStore.create({ threadId: a.thread.id, wokenBySeq: 1, createdBy: null });
    await a.log.write(a.thread.id, async (append) => {
      const requested = await append({
        type: "tool.requested",
        actor: { kind: "agent" },
        data: {
          runId: run.id,
          callId: "call-1",
          messageId: "",
          toolId: "probe.wait",
          input: {},
          risk: "normal",
          waits: false,
          background: true,
        },
      });
      await a.callStore.insert([
        {
          threadId: a.thread.id,
          id: "call-1",
          branchId: run.branchId,
          seq: requested.seq,
          runId: run.id,
          toolId: "probe.wait",
          risk: "normal",
          status: "running",
          waitsFor: null,
          background: true,
          lease: { owner: "dead", leaseMs: 60_000 },
        },
      ]);
    });
    await a.calls.recover();
    await b.calls.recover();
    expect((await a.callStore.find(a.thread.id, "call-1"))?.status).toBe("running");

    await expireLeases(a.db, "call");
    await a.calls.recover();
    await b.calls.recover();
    expect((await a.callStore.find(a.thread.id, "call-1"))?.status).toBe("interrupted");
    const told = (await a.events()).filter(
      (event) => event.type === "notice" && event.data.kind === "call.ended",
    );
    expect(told).toHaveLength(1);
  });

  it("read a large tool result that another instance wrote", async () => {
    const { a, b } = await twoInstances();
    const value = { text: "x".repeat(LARGE_RESULT_CHARS) };
    const { events } = await a.log.write(a.thread.id, async (append) => {
      await append({
        type: "tool.ran",
        actor: { kind: "agent" },
        data: { runId: "run", callId: "call", ok: true, ms: 1, value },
      });
    });

    expect((await b.threadStore.eventAt(a.thread.id, events[0]!.seq))?.data).toMatchObject({
      large: { size: JSON.stringify(value).length },
    });
    const res = await b.api("GET", `/tool-results/${events[0]!.id}`, a.ada.cookie);
    expect(await res.json()).toEqual({ value });
  });

  it("deliver a write made through one instance to a stream open on another", async () => {
    const { a, b } = await twoInstances();
    await b.sync.start();
    const stream = await openStream(b.app, a.ada.cookie, a.thread.id);
    await a.api("POST", `/threads/${a.thread.id}/messages`, a.ada.cookie, {
      text: "// from the other instance",
    });
    const update = await stream.nextRows();
    await stream.close();
    expect(update.rows).toEqual([
      expect.objectContaining({ kind: "human", text: "// from the other instance" }),
    ]);
  });

  it("show a running call's output on another instance, and its end to someone who comes later", async () => {
    const { a, b } = await twoInstances();
    await b.sync.start();
    // The next piece of output a stream is sent, past rows and the rest.
    async function nextOutput(stream: Awaited<ReturnType<typeof openStream>>) {
      for (;;) {
        const frame = await stream.nextItem();
        if (frame.event === "tool-output") return JSON.parse(frame.data!) as LiveChunk;
      }
    }
    const watching = await openStream(b.app, a.ada.cookie, a.thread.id);
    const call = a.live.open(a.thread.id, "call-1", async () => true);
    call.output("one\n");
    expect(await nextOutput(watching)).toEqual({
      callId: "call-1",
      offset: 0,
      text: "one\n",
      from: 0,
    });
    await watching.close();

    call.progress({ progress: 2, total: 3 });
    call.output("two\n");
    await vi.waitFor(async () => expect((await b.live.of("call-1"))?.text).toBe("one\ntwo\n"));
    const late = await openStream(b.app, a.ada.cookie, a.thread.id);
    expect(await nextOutput(late)).toEqual({
      callId: "call-1",
      offset: 0,
      text: "one\ntwo\n",
      from: 0,
      progress: { progress: 2, total: 3 },
    });
    await late.close();
  });

  it("carry the pieces of a reply stored through one instance to a follower on another, each once", async () => {
    const { a, b } = await twoInstances();
    await b.sync.start();
    const stream = await openStream(b.app, a.ada.cookie, a.thread.id);
    // Batches stored one after another, as a reply's are.
    for (const [index, texts] of [
      [0, ["Hel", "lo"]],
      [2, [" there"]],
    ] as const) {
      await a.transact(async () => {
        await a.deltaStore.append(a.thread.id, { messageId: "m", index, texts: [...texts] });
        a.signals.publish(a.thread.id, {
          kind: "delta",
          messageId: "m",
          upto: index + texts.length,
        });
      });
    }
    const pieces: string[] = [];
    while (pieces.length < 3) {
      const frame = await stream.nextItem();
      if (frame.event !== "message-delta") continue;
      const delta = JSON.parse(frame.data!) as { index: number; texts: string[] };
      expect(delta.index).toBe(pieces.length);
      pieces.push(...delta.texts);
    }
    await stream.close();
    expect(pieces).toEqual(["Hel", "lo", " there"]);
  });

  it("hear a signal from one instance on another only once its transaction commits", async () => {
    const { a, b } = await twoInstances();
    await b.sync.start();
    const heard: string[] = [];
    b.signals.onChanged(({ threadId }) => heard.push(threadId));
    await a.transact(async () => {
      a.signals.changed({ threadId: "t-1" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard).toEqual([]);
    });
    await vi.waitFor(() => expect(heard).toEqual(["t-1"]));
  });

  it("bring a stream up to date after its instance stopped hearing the others for a while", async () => {
    const a = await agentThread();
    // The second instance's listener, which the test cuts off and restores.
    const listener = { deaf: false, gap: () => {} };
    const b = setup(
      {},
      {
        database: {
          ...a.database,
          listen: async (channel, onMessage, onGap) => {
            listener.gap = onGap;
            return a.database.listen(
              channel,
              (payload) => {
                if (!listener.deaf) onMessage(payload);
              },
              onGap,
            );
          },
        },
      },
    );
    await b.sync.start();
    const stream = await openStream(b.app, a.ada.cookie, a.thread.id);
    listener.deaf = true;
    await a.post(a.ada, "// said while the other was not listening");
    listener.deaf = false;
    listener.gap();
    const update = await stream.nextRows();
    await stream.close();
    expect(update.rows).toEqual([
      expect.objectContaining({ kind: "human", text: "// said while the other was not listening" }),
    ]);
  });
});

// Statements over several connections at once, which the database in the test's process cannot
// show.
describe.skipIf(!process.env.TEST_DATABASE_URL)("several server instances on one Postgres", () => {
  it("finish two transactions that lock two threads in opposite order, one run again", async () => {
    const [a, b] = await instances(2);
    const other = await a.createThread(a.ada.cookie, a.space.id);
    const [low, high] = [a.thread.id, other.id].sort() as [string, string];
    // Each holds its first thread before either asks for its second.
    let firsts = 0;
    let bothHeld = () => {};
    const held = new Promise<void>((resolve) => (bothHeld = resolve));
    const lockBoth = (first: string, second: string) => async () => {
      await a.threadStore.lock([first]);
      if (++firsts === 2) bothHeld();
      await held;
      await a.threadStore.lock([second]);
    };
    await Promise.all([
      a.transact(lockBoth(low, high)),
      b.transact(async () => {
        await b.threadStore.lock([high]);
        if (++firsts === 2) bothHeld();
        await held;
        await b.threadStore.lock([low]);
      }),
    ]);
    expect(a.sync.stats.retries + b.sync.stats.retries).toBe(1);
  });

  it("begin each of many queued runs once, with two workers claiming at once", async () => {
    const [a, b] = await instances(2);
    const threads = await Promise.all(
      Array.from({ length: 40 }, async () => a.createThread(a.ada.cookie, a.space.id)),
    );
    for (const thread of threads) {
      await a.runStore.create({ threadId: thread.id, wokenBySeq: 0, createdBy: null });
    }
    const claimAll = async (store: typeof a.runStore, owner: string) => {
      const ids: string[] = [];
      for (
        let run = await store.claim(owner, 60_000);
        run;
        run = await store.claim(owner, 60_000)
      ) {
        ids.push(run.id);
      }
      return ids;
    };
    const [byA, byB] = await Promise.all([claimAll(a.runStore, "a"), claimAll(b.runStore, "b")]);
    const all = [...byA, ...byB];
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
  });

  it("fire each of many due schedules once, with two instances ticking at once", async () => {
    const [a, b] = await instances(2);
    for (let index = 0; index < 40; index += 1) {
      await a.scheduleStore.create({
        id: `wake-${index}`,
        threadId: a.thread.id,
        kind: "once",
        name: "Wake",
        cron: null,
        timezone: null,
        prompt: `Carry on ${index}`,
        influence: [],
        callId: null,
        nextRunAt: new Date(Date.now() - 1000),
      });
    }
    a.clock.now = new Date();
    b.clock.now = new Date();
    const [byA, byB] = await Promise.all([a.schedules.tick(), b.schedules.tick()]);
    expect(byA + byB).toBe(40);
    expect((await a.events()).filter((event) => event.type === "notice")).toHaveLength(40);
  });

  it("sweep expired spaces on one instance at a time", async () => {
    const [a, b] = await instances(2);
    let sweeps = 0;
    for (const instance of [a, b]) {
      vi.spyOn(instance.spaces, "sweep").mockImplementation(async () => {
        sweeps += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 0;
      });
    }
    await Promise.all([a.spaceSweep.now(), b.spaceSweep.now()]);
    expect(sweeps).toBe(1);
  });

  it("sweep in short writes, holding a lease that another takes over once its holder died", async () => {
    const [a, b] = await instances(2);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let written = () => {};
    const isWritten = new Promise<void>((resolve) => (written = resolve));
    const sweeps: string[] = [];
    vi.spyOn(a.spaces, "sweep").mockImplementation(async () => {
      sweeps.push("a");
      await a.db.execute(sql`update space set name = 'swept' where id = ${a.space.id}`);
      written();
      await held;
      return 0;
    });
    vi.spyOn(b.spaces, "sweep").mockImplementation(async () => {
      sweeps.push("b");
      return 0;
    });
    const sweeping = a.spaceSweep.now();
    await isWritten;
    // What the pass wrote is kept and seen while it still runs.
    const name = await b.db.execute<{ name: string }>(
      sql`select name from space where id = ${a.space.id}`,
    );
    expect(name.rows[0]?.name).toBe("swept");
    await b.spaceSweep.now();
    await kill(a);
    release();
    await Promise.resolve(sweeping).catch(() => {});
    await b.spaceSweep.now();
    expect(sweeps).toEqual(["a"]);
    await expireLeases(b.db, "singleton");
    await b.spaceSweep.now();
    expect(sweeps).toEqual(["a", "b"]);
  });
});

// Waits until as many statements wait on a lock, as writes held behind the test's lock do.
async function blocked(db: ReturnType<typeof setup>["db"], statements = 1) {
  await vi.waitFor(async () => {
    const waiting = await db.execute<{ count: string }>(
      sql`select count(distinct pid) from pg_locks where not granted`,
    );
    expect(Number(waiting.rows[0]!.count)).toBeGreaterThanOrEqual(statements);
  });
}

// What a stream sends, kept as it arrives, and a wait for one that meets a check.
function collected(stream: Awaited<ReturnType<typeof openStream>>) {
  const frames: { id?: string; event?: string; data?: string }[] = [];
  let closed = false;
  void (async () => {
    try {
      for (;;) frames.push(await stream.nextItem());
    } catch {
      closed = true;
    }
  })();
  return {
    frames,
    async until(check: (frames: { event?: string; data?: string }[]) => boolean) {
      await vi.waitFor(() => expect(closed || check(frames)).toBe(true), { timeout: 5000 });
      expect(closed).toBe(false);
    },
    rows: () =>
      frames
        .filter((frame) => frame.event === "rows")
        .flatMap(
          (frame) =>
            (
              JSON.parse(frame.data!) as {
                rows: { kind: string; text?: string; status?: string }[];
              }
            ).rows,
        ),
  };
}

// Ada asks for a webhook through `a`, whose agent asks to add it, which waits on a person.
async function waitingOnDecision(a: Awaited<ReturnType<typeof instances>>[0]) {
  await a.start();
  await a.post(a.ada, "Set it up");
  const call = await a.model.next();
  call.startStep();
  call.toolCall("hook", "webhooks.add", { name: "Deploys", note: "Check the deploy" });
  call.endStep();
  call.end();
  await a.worker.idle();
  const runs = await a.db.execute<{ status: string }>(
    sql`select status from run where thread_id = ${a.thread.id}`,
  );
  expect(runs.rows).toEqual([{ status: "waiting" }]);
}

const decision = (on: { api: ReturnType<typeof setup>["api"] }, threadId: string, cookie: string) =>
  on.api("POST", `/threads/${threadId}/tools/hook/decision`, cookie, {
    allow: true,
    scope: "once",
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies", () => {
  it("while its run waits on a person leaves the run to go on through another once approved", async () => {
    const [a, b] = await instances(2);
    await waitingOnDecision(a);
    await kill(a);
    await b.worker.start();
    expect((await decision(b, a.thread.id, a.ada.cookie)).status).toBe(200);
    (await b.model.next()).reply("Added.");
    await b.worker.idle();
    const runs = await b.db.execute<{ status: string }>(
      sql`select status from run where thread_id = ${a.thread.id}`,
    );
    expect(runs.rows).toEqual([{ status: "completed" }]);
    const ran = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter(
      (event) => event.type === "tool.ran",
    );
    expect(ran).toHaveLength(1);
  });

  it("while serving a stream leaves its reader to go on from its cursor on another", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    await b.worker.start();
    const first = collected(await openStream(a.app, a.ada.cookie, a.thread.id, { after: 0 }));
    const posted = await b.api("POST", `/threads/${a.thread.id}/messages`, a.ada.cookie, {
      text: "Hello",
      mode: "steer",
    });
    expect(posted.status).toBe(202);
    const call = await b.model.next();
    call.startStep();
    call.delta("Gears");
    await call.drained();
    await first.until((frames) => frames.some((frame) => frame.event === "message-delta"));
    const cursor = first.frames.findLast((frame) => frame.id)!.id!;
    await kill(a);
    const second = collected(
      await openStream(b.app, a.ada.cookie, a.thread.id, { lastEventId: cursor }),
    );
    await second.until((frames) => frames.some((frame) => frame.event === "message-delta"));
    call.delta(" and levers");
    call.endStep();
    call.end();
    await b.worker.idle();
    await second.until(() =>
      second.rows().some((row) => row.text === "Gears and levers" && row.status === "completed"),
    );
    // What came before the cursor is not sent again; the reply under way is, from its first piece.
    expect(second.rows().filter((row) => row.kind === "human")).toEqual([]);
    const pieces = second.frames
      .filter((frame) => frame.event === "message-delta")
      .flatMap((frame) => (JSON.parse(frame.data!) as { texts: string[] }).texts);
    expect(pieces[0]).toBe("Gears");
    expect("Gears and levers".startsWith(pieces.join(""))).toBe(true);
  });

  it("inside a schedule's firing leaves it to fire once on another", async () => {
    const [a, b] = await instances(2);
    await a.scheduleStore.create({
      id: "wake",
      threadId: a.thread.id,
      kind: "once",
      name: "Wake",
      cron: null,
      timezone: null,
      prompt: "Carry on",
      influence: [],
      callId: null,
      nextRunAt: new Date(Date.now() - 1000),
    });
    a.clock.now = new Date();
    b.clock.now = new Date();
    const release = await lockThread(a, a.thread.id);
    const ticking = a.schedules.tick();
    await blocked(b.db);
    await kill(a);
    await release();
    expect(await ticking).toBe(0);
    expect(await b.schedules.tick()).toBe(1);
    const notices = await b.db.execute(
      sql`select id from thread_event where thread_id = ${a.thread.id} and type = 'notice'`,
    );
    expect(notices.rows).toHaveLength(1);
    const keyed = await b.db.execute(
      sql`select id from thread_input where key like 'schedule:wake:%'`,
    );
    expect(keyed.rows).toHaveLength(1);
    const runs = await b.db.execute(sql`select id from run where thread_id = ${a.thread.id}`);
    expect(runs.rows).toHaveLength(1);
  });

  it("mid-reply has its run tried again on another, its pieces told to a follower there once", async () => {
    const [a, b] = await instances(2);
    await b.sync.start();
    await a.sync.start();
    await a.start();
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    await a.post(a.ada, "Hello");
    const first = await a.model.next();
    first.startStep();
    first.delta("Gears");
    await first.drained();
    await stream.until((frames) => frames.some((frame) => frame.event === "message-delta"));
    await kill(a);
    await expireLeases(b.db, "run");
    await b.worker.recover();
    await b.worker.start();
    (await b.model.next()).reply("Levers.");
    await b.worker.idle();
    await stream.until(() =>
      stream.rows().some((row) => row.text === "Levers." && row.status === "completed"),
    );

    const runs = await b.db.execute<{ status: string; attempt: number }>(
      sql`select status, attempt from run where thread_id = ${a.thread.id} order by attempt`,
    );
    expect(runs.rows.map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["completed", 2],
    ]);
    const types = (await b.threadStore.eventsAfter(a.thread.id, 0)).map((event) => event.type);
    expect(types.filter((type) => type === "run.failed")).toHaveLength(1);
    expect(types.filter((type) => type === "message.admitted")).toHaveLength(1);
    const pieces = stream.frames
      .filter((frame) => frame.event === "message-delta")
      .flatMap((frame) => (JSON.parse(frame.data!) as { texts: string[] }).texts);
    // The reply cut short is told once; its retry's, written at once, comes as its row.
    expect(pieces).toEqual(["Gears"]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies sweeping", () => {
  it("inside the sweep of expired spaces leaves each to be swept once by another", async () => {
    const [a, b] = await instances(2);
    const other = await a.db.execute<{ id: string }>(
      sql`select id from space where id <> ${a.space.id} limit 1`,
    );
    const expired = [a.space.id, other.rows[0]!.id];
    for (const id of expired) {
      await a.db.execute(
        sql`update space set trashed_at = now() - interval '400 days' where id = ${id}`,
      );
    }
    // Deleting the thread's space waits on the thread.
    const release = await lockThread(a, a.thread.id);
    const sweeping = a.spaceSweep.now();
    await blocked(b.db);
    await kill(a);
    await release();
    await Promise.resolve(sweeping).catch(() => {});
    const left = async () =>
      (
        await b.db.execute<{ id: string }>(
          sql`select id from space where id in ${sql.raw(`('${expired.join("','")}')`)}`,
        )
      ).rows.map((row) => row.id);
    expect(await left()).toContain(a.space.id);
    // The dead instance's lease holds the pass until it runs out.
    await b.spaceSweep.now();
    expect(await left()).toContain(a.space.id);
    await expireLeases(b.db, "singleton");
    await b.spaceSweep.now();
    expect(await left()).toEqual([]);
    expect(await b.spaces.sweep()).toBe(0);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that stalls", () => {
  it("past its run's lease has what it writes after refused, once another took the run over", async () => {
    const [a, b] = await instances(2);
    await a.start();
    await a.post(a.ada, "Hello");
    const first = await a.model.next();
    first.startStep();
    first.delta("Late");
    await first.drained();
    freeze(a);
    await expireLeases(b.db, "run");
    await b.worker.recover();
    await b.worker.start();
    (await b.model.next()).reply("On time.");
    await b.worker.idle();
    thaw(a);
    first.delta(" words");
    first.endStep();
    first.end();
    await a.worker.idle();

    // The reply cut short is closed as failed by the takeover; only the second's is completed.
    const replies = (await b.threadStore.eventsAfter(a.thread.id, 0)).flatMap((event) =>
      event.type === "message.completed"
        ? [event.data as { status: string; parts: unknown[] }]
        : [],
    );
    expect(replies.map((reply) => reply.status)).toEqual(["failed", "completed"]);
    expect(JSON.stringify(replies)).not.toContain("Late");
    const ends = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter((event) =>
      ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
    );
    expect(ends.map((event) => event.type)).toEqual(["run.failed", "run.completed"]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that stops hearing", () => {
  it("is told of the gap when its listening connection ends, and its stream catches up", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    await dropListener(b);
    await a.post(a.ada, "// While away");
    await vi.waitFor(() => expect(gaps).toBe(1), { timeout: 5000 });
    await stream.until(() => stream.rows().some((row) => row.text === "// While away"));
  });

  it("finds its listening connection stalled at its check, and listens again, told of the gap", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    stall(b);
    await a.post(a.ada, "// While stalled");
    await b.database.listen.check?.();
    await vi.waitFor(() => expect(gaps).toBe(1), { timeout: 5000 });
    await stream.until(() => stream.rows().some((row) => row.text === "// While stalled"));
  });

  it("cuts a listening connection that stalls as it is made again, and makes another", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    stall(b, { connecting: 1 });
    await a.post(a.ada, "// While stalled");
    await b.database.listen.check?.();
    await vi.waitFor(() => expect(gaps).toBe(1), { timeout: 10_000 });
    await stream.until(() => stream.rows().some((row) => row.text === "// While stalled"));
  });

  it("from the start, still receives a whole run on another by its beats", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    await a.start();
    deafen(b);
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    await a.post(a.ada, "Hello");
    const call = await a.model.next();
    call.startStep();
    call.delta("Gears");
    await call.drained();
    await stream.until(() =>
      stream.rows().some((row) => row.kind === "agent" && row.status === "streaming"),
    );
    call.delta(" and levers");
    call.endStep();
    call.end();
    await a.worker.idle();
    await stream.until(() =>
      stream.rows().some((row) => row.text === "Gears and levers" && row.status === "completed"),
    );
  });

  it("through a whole run on another, holds its final rows once restored, with no gap told", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    await a.start();
    const stream = collected(await openStream(b.app, a.ada.cookie, a.thread.id, { after: 0 }));
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    deafen(b);
    await a.post(a.ada, "Hello");
    (await a.model.next()).reply("Hello back.");
    await a.worker.idle();
    restore(b);
    await stream.until(() =>
      stream.rows().some((row) => row.text === "Hello back." && row.status === "completed"),
    );
    expect(gaps).toBe(0);
  });

  it("tells a list feed of a thread shared unheard with its reader", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const hedy = await a.signUp("Hedy Lamarr", "hedy@example.com");
    const feed = await openFeed(a.app, hedy.cookie);
    // Its first beat says it has read its first time from the database.
    while ((await feed.next()).comment !== "heartbeat");
    const told: string[] = [];
    void (async () => {
      try {
        for (;;) {
          const item = await feed.nextChange();
          if (item.event === "thread") told.push((item.data.thread as { id: string }).id);
        }
      } catch {
        // Closed as the test ends.
      }
    })();
    deafen(a);
    const invited = await b.api("POST", `/threads/${a.thread.id}/invites`, a.ada.cookie, {
      accessFor: "1d",
    });
    const token = ((await invited.json()) as { url: string }).url.split("/invite/")[1]!;
    expect((await b.api("POST", "/invites/accept", hedy.cookie, { token })).status).toBe(200);
    await vi.waitFor(() => expect(told).toContain(a.thread.id), { timeout: 5000 });
    await feed.close();
  });

  it("tells a list feed of a thread changed unheard on one whose clock runs behind the database's", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const feed = await openFeed(a.app, a.ada.cookie);
    // Its first beat says it has read its first time from the database.
    while ((await feed.next()).comment !== "heartbeat");
    const told: string[] = [];
    void (async () => {
      try {
        for (;;) {
          const item = await feed.nextChange();
          if (item.event === "thread") told.push((item.data.thread as { id: string }).id);
        }
      } catch {
        // Closed as the test ends.
      }
    })();
    deafen(a);
    // The process's clock, which both instances share, a minute behind while the other writes.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 60_000 });
    try {
      const res = await b.api("POST", `/threads/${a.thread.id}/messages`, a.grace.cookie, {
        text: "// Unheard",
        mode: "steer",
      });
      expect(res.status).toBe(202);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(told).toContain(a.thread.id), { timeout: 5000 });
  });

  it("holds a list feed's next ask back by a write open many beats no further than the bound", async () => {
    const [a, b] = await instances(2);
    const release = await lockThread(b, a.thread.id);
    const ask = async () => {
      const before = (await a.db.execute<{ now: string }>(sql`select now()::text as now`)).rows[0]!;
      const { at } = await a.threadStore.changedSince({
        spaceIds: [],
        threadIds: [],
        userId: a.ada.userId,
        since: new Date(),
        heldAtMost: 200,
      });
      return { at: at.getTime(), now: new Date(before.now).getTime() };
    };
    try {
      // Open for less than the bound, the write holds the ask back to its start.
      const early = await ask();
      expect(early.at).toBeLessThanOrEqual(early.now);
      // Open past the bound, it holds the ask back by the bound alone.
      await vi.waitFor(async () => {
        const held = await ask();
        expect(held.at).toBeGreaterThan(early.at);
        expect(held.at).toBeGreaterThanOrEqual(held.now - 200);
      });
    } finally {
      await release();
    }
  });

  it("tells a list feed of a thread changed unheard by a write open across one of its beats", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    const feed = await openFeed(a.app, a.ada.cookie);
    let beats = 0;
    const told: string[] = [];
    void (async () => {
      try {
        for (;;) {
          const frame = await feed.next();
          if (frame.comment === "heartbeat") beats += 1;
          else if (frame.event === "thread") {
            told.push((JSON.parse(frame.data!) as { thread: { id: string } }).thread.id);
          }
        }
      } catch {
        // Closed as the test ends.
      }
    })();
    await vi.waitFor(() => expect(beats).toBeGreaterThan(0));
    deafen(a);
    // The post's transaction, and the time it stamps, begins before the beat it ends after.
    const release = await lockThread(b, a.thread.id);
    const posting = b.api("POST", `/threads/${a.thread.id}/messages`, a.grace.cookie, {
      text: "// Unheard",
      mode: "steer",
    });
    await blocked(b.db);
    const before = beats;
    await vi.waitFor(() => expect(beats).toBeGreaterThan(before + 1));
    await release();
    expect((await posting).status).toBe(202);
    await vi.waitFor(() => expect(told).toContain(a.thread.id), { timeout: 5000 });
    // Read again at later beats, it is not told again unchanged.
    const seen = beats;
    await vi.waitFor(() => expect(beats).toBeGreaterThan(seen + 3));
    expect(told.filter((id) => id === a.thread.id)).toHaveLength(1);
    await feed.close();
  });

  it("from one whose notify fails outside a write, stops a run before its lease's beat, and starts what waits", async () => {
    // The beat at a third of the lease, far later than the test waits; the poll for what waits short.
    const [a, b] = await instances(2, { worker: { pollMs: 50, leaseMs: 60_000 } });
    await a.sync.start();
    await b.sync.start();
    await b.worker.start();
    await a.post(a.ada, "Hello");
    const first = await b.model.next();
    first.startStep();
    await a.post(a.ada, "Then this", "queue");
    // Its notifies sent at once, outside a transaction, fail; those a write sends go with it.
    let failed = 0;
    const execute = a.database.db.execute.bind(a.database.db);
    vi.spyOn(a.database.db, "execute").mockImplementation(((
      query: Parameters<typeof execute>[0],
    ) => {
      const text = JSON.stringify(query);
      if (text.includes("select pg_notify(") && !text.includes("json_array_elements_text")) {
        failed += 1;
        return Promise.reject(new Error("notify failed"));
      }
      return execute(query);
    }) as typeof execute);
    expect((await a.api("POST", `/threads/${a.thread.id}/stop`, a.ada.cookie)).status).toBe(202);
    expect(failed).toBeGreaterThan(0);
    // The stop's wake went with its write, so B hears it now, not at the beat.
    const statuses = async () =>
      (
        await b.db.execute<{ status: string }>(
          sql`select status from run where thread_id = ${a.thread.id} order by created_at`,
        )
      ).rows.map((run) => run.status);
    await vi.waitFor(async () => expect((await statuses())[0]).toBe("cancelled"), {
      timeout: 5000,
    });
    (await b.model.next()).reply("Then that.");
    await b.worker.idle();
    expect(await statuses()).toEqual(["cancelled", "completed"]);
  });

  it("reads again when a signal is too large to be sent", async () => {
    const [a, b] = await instances(2);
    await a.sync.start();
    await b.sync.start();
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    a.signals.publish(a.thread.id, {
      kind: "live",
      callId: "x".repeat(10_000),
    } as Parameters<typeof a.signals.publish>[1]);
    await vi.waitFor(() => expect(gaps).toBe(1));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("instances racing", () => {
  it("decide a call once when two people decide it through two instances at once", async () => {
    const [a, b] = await instances(2);
    await waitingOnDecision(a);
    const codes = await Promise.all([
      decision(a, a.thread.id, a.ada.cookie),
      decision(b, a.thread.id, a.ada.cookie),
    ]);
    expect(codes.map((res) => res.status).toSorted((x, y) => x - y)).toEqual([200, 409]);
    (await a.model.next()).reply("Added.");
    await a.worker.idle();
    const approved = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter(
      (event) => event.type === "tool.approved",
    );
    expect(approved).toHaveLength(1);
  });

  it("start one run when two people post through two instances into an idle thread", async () => {
    const [a, b] = await instances(2);
    const posted = await Promise.all([
      a.post(a.ada, "From one"),
      b.api("POST", `/threads/${a.thread.id}/messages`, a.grace.cookie, {
        text: "From the other",
        mode: "steer",
      }),
    ]);
    expect(posted[1].status).toBe(202);
    const runs = await b.db.execute(sql`select id from run where thread_id = ${a.thread.id}`);
    expect(runs.rows).toHaveLength(1);
    await a.start();
    (await a.model.next()).reply("Both read.");
    await a.worker.idle();
    const events = await b.threadStore.eventsAfter(a.thread.id, 0);
    const messages = events.filter((event) => event.type === "message").map((event) => event.id);
    const admitted = events.filter((event) => event.type === "message.admitted");
    expect(
      admitted.flatMap((event) => (event.data as { messageIds: string[] }).messageIds),
    ).toEqual(messages);
  });

  it("make every keyed notice once and take each in once, two instances enqueuing at once", async () => {
    const [a, b] = await instances(2);
    await a.start();
    const notice = (index: number) => ({
      kind: "notice" as const,
      notice: {
        kind: "agent.idle" as const,
        source: { threadId: "elsewhere", name: "Watcher", main: false },
        text: `Notice ${index}`,
        influence: [],
      },
    });
    // A quarter of the keys come twice, once through each instance.
    const keys = Array.from({ length: 200 }, (_, index) => `n-${index % 150}`);
    await a.post(a.ada, "Go");
    const first = await a.model.next();
    await Promise.all(
      keys.map(async (key, index) =>
        (index % 2 ? a : b).queue.enqueue(a.thread.id, notice(index), { key }),
      ),
    );
    first.reply("Going.");
    // The run takes in what waits at its next step, and ends after it.
    (await a.model.next()).reply("Noted.");
    await a.worker.idle();
    const rows = await b.db.execute<{ key: string }>(
      sql`select key from thread_input
           where thread_id = ${a.thread.id} and key is not null order by seq`,
    );
    expect(rows.rows).toHaveLength(150);
    expect(new Set(rows.rows.map((row) => row.key)).size).toBe(150);
  });
});

// The agent in `on`'s thread asks for the calls in one step; answers when the step is recorded.
async function asks(on: AgentInstance, ...asked: [string, string, unknown][]) {
  const call = await on.model.next();
  call.startStep();
  for (const [callId, toolId, input] of asked) call.toolCall(callId, toolId, input);
  call.endStep();
  call.end();
}

async function callStatus(db: ReturnType<typeof setup>["db"], threadId: string, callId: string) {
  const rows = await db.execute<{ status: string; background: boolean }>(
    sql`select status, background from call where thread_id = ${threadId} and id = ${callId}`,
  );
  return rows.rows[0];
}

// A thread whose places all run on `a`, with two jobs queued behind them, q0 then q1.
async function queuedBehind(a: AgentInstance, reader: Pick<Instance, "db"> = a) {
  await a.post(a.ada, "Start many");
  await asks(
    a,
    ...Array.from({ length: BACKGROUND_LIMIT }, (_, i): [string, string, unknown] => [
      `l${i}`,
      "jobs.start",
      { tool: "probe.wait", input: { label: `l${i}` } },
    ]),
    ["q0", "jobs.start", { tool: "probe.wait", input: { label: "q0" } }],
    ["q1", "jobs.start", { tool: "probe.wait", input: { label: "q1" } }],
  );
  (await a.model.next()).reply("Started.");
  await a.worker.idle();
  const jobs = async () =>
    (
      await reader.db.execute<{ id: string; status: string }>(
        sql`select id, status from call where thread_id = ${a.thread.id} and background
             order by created_at, id`,
      )
    ).rows;
  return { jobs };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("instances with queued jobs", () => {
  it("race for one freed place, and only the oldest queued job starts", async () => {
    const tool = probe();
    const [a, b, c] = await instances(3, { toolsets: [tool.toolset] });
    await a.start();
    const { jobs } = await queuedBehind(a);
    expect((await jobs()).filter((job) => job.status === "ready")).toHaveLength(2);
    const first = (await jobs())[0]!;
    // Each instance's start waits at the thread's lock until all three are there.
    let arrived = 0;
    let all = () => {};
    const together = new Promise<void>((resolve) => (all = resolve));
    for (const one of [a, b, c]) {
      const write = one.log.write.bind(one.log);
      vi.spyOn(one.log, "write").mockImplementation(async (threadId, ...rest) => {
        if (threadId === a.thread.id) {
          arrived += 1;
          if (arrived === 3) all();
          await Promise.race([together, new Promise((resolve) => setTimeout(resolve, 2000))]);
        }
        return write(threadId, ...rest);
      });
    }
    // A place frees as a person cancels a running job through another instance.
    const res = await b.api(
      "POST",
      `/threads/${a.thread.id}/tools/${first.id}/cancel`,
      a.ada.cookie,
    );
    expect(res.status).toBe(200);
    arrived = 0;
    await Promise.all([a.calls.beat(), b.calls.beat(), c.calls.beat()]);
    vi.restoreAllMocks();
    expect(arrived).toBeGreaterThan(1);
    await vi.waitFor(() => expect(tool.running("q0")).toBe(true));
    expect(tool.running("q1")).toBe(false);
    const after = await jobs();
    expect(after.filter((job) => job.status === "running")).toHaveLength(BACKGROUND_LIMIT);
    expect(after.filter((job) => job.status === "ready")).toHaveLength(1);
  });

  it("start once the places an instance that died held are freed", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    const { jobs } = await queuedBehind(a, b);
    await kill(a);
    await expireLeases(b.db, "call");
    await b.worker.start();
    await b.calls.recover();
    await b.calls.beat();
    await vi.waitFor(() => expect(tool.running("q1")).toBe(true));
    const after = await jobs();
    expect(after.filter((job) => job.status === "interrupted")).toHaveLength(BACKGROUND_LIMIT);
    expect(after.filter((job) => job.status === "running")).toHaveLength(2);
  });

  it("do not run a job cancelled as it starts", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    const { jobs } = await queuedBehind(a);
    const [first] = await jobs();
    const q0 = (await jobs())[BACKGROUND_LIMIT]!;
    // Whichever instance starts it, a cancel through the other lands before the tool is run.
    let cancelled = false;
    let landed = () => {};
    const done = new Promise<void>((resolve) => (landed = resolve));
    for (const [one, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const holds = one.callStore.holds.bind(one.callStore);
      vi.spyOn(one.callStore, "holds").mockImplementation(async (lease) => {
        if (lease.callId === q0.id && !cancelled) {
          cancelled = true;
          const res = await other.api(
            "POST",
            `/threads/${a.thread.id}/tools/${q0.id}/cancel`,
            a.ada.cookie,
          );
          expect(res.status).toBe(200);
          landed();
        }
        return holds(lease);
      });
    }
    const res = await b.api(
      "POST",
      `/threads/${a.thread.id}/tools/${first!.id}/cancel`,
      a.ada.cookie,
    );
    expect(res.status).toBe(200);
    await a.calls.beat();
    await done;
    // The start that met the cancel has let the job go before running it.
    await vi.waitFor(async () =>
      expect((await a.calls.find(a.thread.id, q0.id))?.status).toBe("cancelled"),
    );
    vi.restoreAllMocks();
    expect(tool.running("q0")).toBe(false);
    expect((await jobs()).find((job) => job.id === q0.id)?.status).toBe("cancelled");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies with a call", () => {
  it("running a job leaves it interrupted once, told once, its starter woken once", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    await a.post(a.ada, "Start a job");
    await asks(a, ["job", "jobs.start", { tool: "probe.wait", input: { label: "job" } }]);
    (await a.model.next()).reply("Started.");
    await a.worker.idle();
    await vi.waitFor(() => expect(tool.running("job")).toBe(true));
    await kill(a);
    await expireLeases(b.db, "call");
    await b.worker.start();
    await b.calls.recover();
    (await b.model.next()).reply("Noted.");
    await b.worker.idle();
    const events = await b.threadStore.eventsAfter(a.thread.id, 0);
    const ended = events.filter(
      (event) => event.type === "notice" && (event.data as { kind: string }).kind === "call.ended",
    );
    expect(ended).toHaveLength(1);
    const runs = await b.db.execute(sql`select id from run where thread_id = ${a.thread.id}`);
    expect(runs.rows).toHaveLength(2);
    const jobs = await b.db.execute<{ status: string }>(
      sql`select status from call where thread_id = ${a.thread.id} and background`,
    );
    expect(jobs.rows).toEqual([{ status: "interrupted" }]);
  });

  it("after approving a job no instance claimed leaves it to start once on another", async () => {
    const tool = probe();
    const [a, b, c] = await instances(3, { toolsets: [tool.toolset] });
    // Its keeper never runs, so it claims nothing.
    await a.worker.start();
    await a.post(a.ada, "Start a job");
    await asks(a, ["job", "jobs.start", { tool: "probe.guarded", input: { label: "j" } }]);
    (await a.model.next()).reply("Started.");
    await a.worker.idle();
    const job = await b.db.execute<{ id: string }>(
      sql`select id from call where thread_id = ${a.thread.id} and background`,
    );
    const approved = await a.api(
      "POST",
      `/threads/${a.thread.id}/tools/${job.rows[0]!.id}/decision`,
      a.ada.cookie,
      { allow: true, scope: "once" },
    );
    expect(approved.status).toBe(200);
    await kill(a);
    await b.worker.start();
    await Promise.all([b.calls.beat(), c.calls.beat()]);
    (await b.model.next()).reply("Noted.");
    await b.worker.idle();
    const ran = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter(
      (event) => event.type === "tool.ran",
    );
    // The start's own result, and the job's.
    expect(ran).toHaveLength(2);
  });

  it("after a call ran, before its result was written, leaves it ended without running again", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    await a.post(a.ada, "Wait");
    await asks(a, ["once", "probe.wait", { label: "once" }]);
    await vi.waitFor(() => expect(tool.running("once")).toBe(true));
    const release = await lockThread(a, a.thread.id);
    tool.finish("once", "done");
    await blocked(b.db);
    await kill(a);
    await release();
    await expireLeases(b.db, "run");
    await b.worker.recover();
    await b.worker.start();
    (await b.model.next()).reply("Tried again.");
    await b.worker.idle();
    const ran = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter(
      (event) => event.type === "tool.ran",
    );
    expect(ran).toEqual([]);
    expect((await callStatus(b.db, a.thread.id, "once"))?.status).not.toBe("running");
  });

  it("with a running call asked to move leaves no call open, and the mark moves no dead call", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    await a.post(a.ada, "Wait");
    await asks(a, ["slow", "probe.wait", { label: "slow" }]);
    await vi.waitFor(() => expect(tool.running("slow")).toBe(true));
    await kill(a);
    const moved = await b.api(
      "POST",
      `/threads/${a.thread.id}/tools/slow/background`,
      a.ada.cookie,
    );
    expect([200, 409]).toContain(moved.status);
    await expireLeases(b.db, "run");
    await b.worker.recover();
    await b.worker.start();
    (await b.model.next()).reply("Tried again.");
    await b.worker.idle();
    const call = await callStatus(b.db, a.thread.id, "slow");
    expect(call?.status).not.toBe("running");
    expect(call?.background).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that stalls with a job", () => {
  it("past the job's lease has its late result refused, once another ended the job", async () => {
    const tool = probe();
    const [a, b] = await instances(2, { toolsets: [tool.toolset] });
    await a.start();
    await a.post(a.ada, "Start a job");
    await asks(a, ["job", "jobs.start", { tool: "probe.wait", input: { label: "late" } }]);
    (await a.model.next()).reply("Started.");
    await a.worker.idle();
    await vi.waitFor(() => expect(tool.running("late")).toBe(true));
    freeze(a);
    await expireLeases(b.db, "call");
    await b.worker.start();
    await b.calls.recover();
    (await b.model.next()).reply("Noted.");
    await b.worker.idle();
    thaw(a);
    tool.finish("late", "too late");
    // Its keeper's stop waits for the job it was running to be done with, refused or not.
    await a.calls.stop();
    const jobs = await b.db.execute<{ status: string }>(
      sql`select status from call where thread_id = ${a.thread.id} and background`,
    );
    expect(jobs.rows).toEqual([{ status: "interrupted" }]);
    const events = await b.threadStore.eventsAfter(a.thread.id, 0);
    expect(JSON.stringify(events)).not.toContain("too late");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("instances under load", () => {
  it("begin each thread's run once, fifty threads of four notices each, two workers", async () => {
    const [a, b] = await instances(2);
    const threads = await Promise.all(
      Array.from({ length: 50 }, async () => a.createThread(a.ada.cookie, a.space.id)),
    );
    const replied = new Set<object>();
    let replying = true;
    const reply = (async () => {
      while (replying) {
        for (const call of [...a.model.calls, ...b.model.calls]) {
          if (replied.has(call)) continue;
          replied.add(call);
          call.reply("Noted.");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    await a.worker.start();
    await b.worker.start();
    await Promise.all(
      threads.flatMap((thread, index) =>
        [0, 1, 2, 3].map(async (n) =>
          ((index + n) % 2 ? a : b).queue.enqueue(thread.id, {
            kind: "notice",
            notice: {
              kind: "agent.idle",
              source: { threadId: "elsewhere", name: "Watcher", main: false },
              text: `Notice ${n}`,
              influence: [],
            },
          }),
        ),
      ),
    );
    await vi.waitFor(
      async () => {
        const open = await b.db.execute(
          sql`select id from run where status in ('queued', 'running', 'waiting')`,
        );
        expect(open.rows).toEqual([]);
      },
      { timeout: 20_000 },
    );
    replying = false;
    await reply;
    expect(await b.queue.stranded()).toEqual([]);
    const taken = await b.db.execute<{ count: string }>(
      sql`select count(*) from thread_input where status = 'waiting'`,
    );
    expect(taken.rows[0]!.count).toBe("0");
  });
});

// A webhook added in `a`'s thread, approved, and the path it is posted to.
async function webhookOf(a: AgentInstance) {
  await waitingOnDecision(a);
  expect((await decision(a, a.thread.id, a.ada.cookie)).status).toBe(200);
  (await a.model.next()).reply("Added.");
  await a.worker.idle();
  const ran = (await a.threadStore.eventsAfter(a.thread.id, 0)).find(
    (event) => event.type === "tool.ran",
  )!;
  return new URL((ran.data as { value: { url: string } }).value.url).pathname;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies inside a delivery", () => {
  for (const [named, headers] of [
    ["with a delivery id", { "X-GitHub-Delivery": "d-1" }],
    ["with none", {}],
  ] as const) {
    it(`leaves one notice when the sender posts again to another, ${named}`, async () => {
      const [a, b] = await instances(2);
      const path = await webhookOf(a);
      const release = await lockThread(a, a.thread.id);
      const first = a.app.request(path, { method: "POST", body: "{}", headers });
      await blocked(b.db);
      await kill(a);
      await release();
      await Promise.resolve(first).catch(() => {});
      expect((await b.app.request(path, { method: "POST", body: "{}", headers })).status).toBe(200);
      const told = (await b.threadStore.eventsAfter(a.thread.id, 0)).filter(
        (event) =>
          event.type === "notice" && (event.data as { kind: string }).kind === "webhook.received",
      );
      expect(told).toHaveLength(1);
    });
  }
});

// The model calls made through the instances, each taken by the test once: the next in a thread,
// or every one as it comes, answered.
function modelCalls(...on: { model: AgentInstance["model"] }[]) {
  const taken = new Set<object>();
  const untaken = (threadId?: string) =>
    on
      .flatMap((instance) => instance.model.calls)
      .find(
        (call) =>
          !taken.has(call) && (threadId === undefined || call.request.sessionId === threadId),
      );
  return {
    async next(threadId: string) {
      await vi.waitFor(() => expect(untaken(threadId)).toBeDefined(), { timeout: 5000 });
      const call = untaken(threadId)!;
      taken.add(call);
      return call;
    },
    // Replies to every call made through the instances until stopped.
    answerAll(text = "Done.") {
      let answering = true;
      const done = (async () => {
        while (answering) {
          for (let call = untaken(); call; call = untaken()) {
            taken.add(call);
            call.reply(text);
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
      return async () => {
        answering = false;
        await done;
      };
    },
  };
}

// Ada's thread on `a` with as many subagents as it may have, S0 onwards, every run ended; by name.
async function fullOfSubagents(a: AgentInstance, models: ReturnType<typeof modelCalls>) {
  await a.start();
  await a.post(a.ada, "Go");
  const asked = await models.next(a.thread.id);
  asked.startStep();
  for (let index = 0; index < LIVE_LIMIT; index += 1) {
    asked.toolCall(`start-${index}`, "subagents.start", { name: `S${index}`, task: "Work" });
  }
  asked.endStep();
  asked.end();
  const stop = models.answerAll();
  await settled(a.db);
  await stop();
  return new Map(
    (await a.subagentStore.ofParents([a.thread.id])).map((one) => [one.name, one.threadId]),
  );
}

// Waits until no run is open in the database.
async function settled(db: ReturnType<typeof setup>["db"]) {
  await vi.waitFor(
    async () => {
      const open = await db.execute(
        sql`select id from run where status in ('queued', 'running', 'waiting')`,
      );
      expect(open.rows).toEqual([]);
    },
    { timeout: 20_000 },
  );
}

// The notices told to the thread, by kind and source.
async function noticesIn(on: Instance, threadId: string) {
  return (await on.threadStore.eventsAfter(threadId, 0)).flatMap((event) =>
    event.type === "notice" ? [event.data as { kind: string; source: { threadId: string } }] : [],
  );
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies with subagents", () => {
  it("inside the write that ends a subagent's run leaves its starter told once, its place taken once", async () => {
    const [a, b] = await instances(2);
    const models = modelCalls(a);
    const starter = a.thread.id;
    await a.start();
    await a.post(a.ada, "Go");
    const asked = await models.next(starter);
    asked.startStep();
    for (let index = 0; index <= RUNNING_LIMIT; index += 1) {
      asked.toolCall(`start-${index}`, "subagents.start", { name: `S${index}`, task: "Work" });
    }
    asked.toolCall("watch", "subagents.watch", { when: "any_idle", subagents: ["S0"] });
    asked.endStep();
    asked.end();
    (await models.next(starter)).reply("Started.");
    const named = new Map(
      (await a.subagentStore.ofParents([starter])).map((one) => [one.name, one.threadId]),
    );
    const first = named.get("S0")!;
    const queued = named.get(`S${RUNNING_LIMIT}`)!;
    const ending = await models.next(first);
    await vi.waitFor(async () => expect(await a.runStore.active(starter)).toBeNull());
    const release = await lockThread(a, starter);
    ending.reply("Done.");
    await blocked(b.db);
    await kill(a);
    await release();
    await expireLeases(b.db, "run");
    await b.worker.recover();
    await b.worker.start();
    const stop = modelCalls(b).answerAll();
    await settled(b.db);
    await stop();

    // The run whose end died with the instance is tried again, and ends once.
    const ended = await b.db.execute<{ status: string; attempt: number }>(
      sql`select status, attempt from run where thread_id = ${first} order by attempt`,
    );
    expect(ended.rows.map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["completed", 2],
    ]);
    const notices = await noticesIn(b, starter);
    expect(notices.filter((notice) => notice.source.threadId === first)).toEqual([
      expect.objectContaining({ kind: "agent.ended" }),
    ]);
    expect(notices.filter((notice) => notice.kind === "agent.idle")).toHaveLength(1);
    const runs = await b.db.execute(sql`select id from run where thread_id = ${queued}`);
    expect(runs.rows).toHaveLength(1);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("instances racing over subagents", () => {
  it("start one of two subagents brought in at once on two instances, with one place left", async () => {
    const [a, b] = await instances(2);
    const models = modelCalls(a, b);
    const named = await fullOfSubagents(a, models);
    await a.subagentStore.archive(named.get("S0")!, new Date());
    await a.post(a.ada, "One more");
    const asked = await models.next(a.thread.id);
    // The agent's start and a person's unarchive both wait at the starter's lock.
    const release = await lockThread(a, a.thread.id);
    asked.startStep();
    asked.toolCall("more", "subagents.start", { name: "More", task: "Work" });
    asked.endStep();
    asked.end();
    const unarchiving = b.api("POST", `/threads/${named.get("S0")!}/unarchive`, a.ada.cookie);
    await blocked(b.db, 2);
    await release();
    const unarchived = (await unarchiving).status;
    const stop = models.answerAll();
    await settled(b.db);
    await stop();
    const all = await b.subagentStore.ofParents([a.thread.id]);
    expect(all.filter((one) => !one.archivedAt)).toHaveLength(LIVE_LIMIT);
    expect([unarchived, all.length]).toEqual(
      all.length > LIVE_LIMIT ? [409, LIVE_LIMIT + 1] : [200, LIVE_LIMIT],
    );
  });

  it("run no more than the limit, and leave none queued beside a free place, as two runs end at once", async () => {
    const [a, b] = await instances(2);
    const models = modelCalls(a, b);
    const starter = a.thread.id;
    await a.start();
    await b.worker.start();
    await a.post(a.ada, "Go");
    const asked = await models.next(starter);
    asked.startStep();
    for (let index = 0; index < RUNNING_LIMIT + 3; index += 1) {
      asked.toolCall(`start-${index}`, "subagents.start", { name: `S${index}`, task: "Work" });
    }
    asked.endStep();
    asked.end();
    (await models.next(starter)).reply("Started.");
    const siblings = (await a.subagentStore.ofParents([starter])).map((one) => one.threadId);
    // The most of them running at once, read while they run.
    let most = 0;
    let watching = true;
    const watched = (async () => {
      while (watching) {
        const active = await b.db.execute(
          sql`select id from run where thread_id in ${sql.raw(`('${siblings.join("','")}')`)}
               and status in ('queued', 'running', 'waiting')`,
        );
        most = Math.max(most, active.rows.length);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const first = await models.next(siblings[0]!);
    const second = await models.next(siblings[1]!);
    await vi.waitFor(async () => expect(await a.runStore.active(starter)).toBeNull());
    const release = await lockThread(a, starter);
    first.reply("Done.");
    second.reply("Done.");
    await blocked(b.db, 2);
    await release();
    const stop = models.answerAll();
    await settled(b.db);
    await stop();
    watching = false;
    await watched;
    expect(most).toBe(RUNNING_LIMIT);
    const ran = await b.db.execute<{ thread_id: string }>(
      sql`select distinct thread_id from run where thread_id in ${sql.raw(`('${siblings.join("','")}')`)}`,
    );
    expect(ran.rows).toHaveLength(RUNNING_LIMIT + 3);
    expect(await b.queue.stranded()).toEqual([]);
  });

  it("bring back one of two archived subagents asked for at once on two instances, with one place left", async () => {
    const [a, b] = await instances(2);
    const models = modelCalls(a, b);
    const named = await fullOfSubagents(a, models);
    await a.subagentStore.archive(named.get("S0")!, new Date());
    // One more started in its place, then another archived: one place, two archived.
    await a.post(a.ada, "One more");
    const asked = await models.next(a.thread.id);
    asked.startStep();
    asked.toolCall("more", "subagents.start", { name: "More", task: "Work" });
    asked.endStep();
    asked.end();
    const stop = models.answerAll();
    await settled(a.db);
    await stop();
    await a.subagentStore.archive(named.get("S1")!, new Date());
    const release = await lockThread(a, a.thread.id);
    const unarchiving = [
      a.api("POST", `/threads/${named.get("S0")!}/unarchive`, a.ada.cookie),
      b.api("POST", `/threads/${named.get("S1")!}/unarchive`, a.ada.cookie),
    ];
    await blocked(b.db, 2);
    await release();
    const statuses = await Promise.all(unarchiving.map(async (res) => (await res).status));
    expect(statuses.toSorted((x, y) => x - y)).toEqual([200, 409]);
    const live = (await b.subagentStore.ofParents([a.thread.id])).filter((one) => !one.archivedAt);
    expect(live).toHaveLength(LIVE_LIMIT);
  });

  it("tell the starter of a subagent's report once, as another's place frees at once on another instance", async () => {
    const [a, b] = await instances(2);
    const models = modelCalls(a, b);
    const starter = a.thread.id;
    await a.start();
    await b.worker.start();
    await a.post(a.ada, "Go");
    const asked = await models.next(starter);
    asked.startStep();
    for (let index = 0; index <= RUNNING_LIMIT; index += 1) {
      asked.toolCall(`start-${index}`, "subagents.start", { name: `S${index}`, task: "Work" });
    }
    asked.endStep();
    asked.end();
    (await models.next(starter)).reply("Started.");
    const siblings = (await a.subagentStore.ofParents([starter])).map((one) => one.threadId);
    const reporting = await models.next(siblings[0]!);
    const ending = await models.next(siblings[1]!);
    await vi.waitFor(async () => expect(await a.runStore.active(starter)).toBeNull());
    const retries = a.sync.stats.retries + b.sync.stats.retries;
    const release = await lockThread(a, starter);
    reporting.startStep();
    reporting.toolCall("report", "subagents.send", { to: "agent", text: "Found it" });
    reporting.endStep();
    reporting.end();
    ending.reply("Done.");
    await blocked(b.db, 2);
    await release();
    const stop = models.answerAll();
    await settled(b.db);
    await stop();
    const notices = await noticesIn(b, starter);
    expect(
      notices
        .filter((notice) => notice.source.threadId === siblings[0])
        .map((notice) => notice.kind),
    ).toEqual(["message"]);
    expect(
      notices
        .filter((notice) => notice.source.threadId === siblings[1])
        .map((notice) => notice.kind),
    ).toEqual(["agent.ended"]);
    const queued = await b.db.execute(
      sql`select id from run where thread_id = ${siblings[RUNNING_LIMIT]!}`,
    );
    expect(queued.rows).toHaveLength(1);
    // Both took the starter's lock after their own, in the one order: none was run again.
    expect(a.sync.stats.retries + b.sync.stats.retries).toBe(retries);
  });
});

// The providers' sign-in endpoints, one service every instance reaches: ChatGPT's device sign-in
// and token endpoint, and Claude's token endpoint. A refresh token is spent once, unless it does
// not rotate. A request `hold` picks is left unanswered, before the provider handles it or after,
// or answered late, once `late` resolves.
function signInProvider() {
  let serial = 0;
  const live = new Set<string>();
  const state = {
    approved: false,
    // Each request's endpoint and, for a renewal, the refresh token it spent.
    asked: [] as { url: string; refresh?: string }[],
    rotates: true,
    hold: undefined as ((url: string) => "before" | "after" | "late" | undefined) | undefined,
    late: Promise.withResolvers<void>(),
    // Resolved once a request was held.
    held: Promise.withResolvers<void>(),
  };
  const issued = (expiresIn = 3600) => {
    serial += 1;
    const refresh = `refresh-${serial}`;
    live.add(refresh);
    return {
      access_token: new UnsecuredJWT({
        serial,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
      }).encode(),
      refresh_token: refresh,
      expires_in: expiresIn,
      account: { uuid: "acct-1", email_address: "ada@claude.example" },
    };
  };
  function answer(url: string, body: Record<string, string>) {
    if (url.endsWith("/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "5" });
    }
    if (url.endsWith("/deviceauth/token")) {
      return state.approved
        ? Response.json({ authorization_code: "device-code", code_verifier: "verifier" })
        : Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 403 });
    }
    const spent = state.rotates ? live.delete(body.refresh_token!) : live.has(body.refresh_token!);
    if (body.grant_type === "refresh_token" && !spent) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json(issued());
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body = (
      text.startsWith("{") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
    ) as Record<string, string>;
    state.asked.push({
      url: request.url,
      ...(body.grant_type === "refresh_token" && { refresh: body.refresh_token }),
    });
    const held = state.hold?.(request.url);
    if (held) state.held.resolve();
    if (held === "before") return new Promise<never>(() => {});
    const reply = answer(request.url, body);
    if (held === "after") return new Promise<never>(() => {});
    if (held === "late") await state.late.promise;
    return reply;
  }) as typeof globalThis.fetch;
  return { ...state, state, fetch, issued };
}

const asksFor = (provider: ReturnType<typeof signInProvider>, path: string) =>
  provider.state.asked.filter((one) => one.url.endsWith(path));

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies signing in", () => {
  it("while asking about a device sign-in leaves it to be finished once on another", async () => {
    const provider = signInProvider();
    const [a, b] = await instances(2, { fetch: provider.fetch });
    // The org's sign-in the harness made, removed, as an org has one ChatGPT sign-in.
    const listed = (await (await a.api("GET", "/connections", a.ada.cookie)).json()) as {
      id: string;
      host: string;
    }[];
    const made = listed.find((one) => one.host === "codex")!;
    expect((await a.api("DELETE", `/connections/${made.id}`, a.ada.cookie)).status).toBe(200);
    const res = await a.api("POST", "/connections/codex/device", a.ada.cookie);
    const { attemptId } = (await res.json()) as { attemptId: string };
    for (const on of [a, b]) on.clock.now = new Date(Date.now() + 60_000);
    provider.state.hold = (url) => (url.endsWith("/deviceauth/token") ? "before" : undefined);
    void a.connections.askDevices().catch(() => {});
    await provider.state.held.promise;
    await kill(a);
    provider.state.hold = undefined;
    provider.state.approved = true;
    await b.connections.askDevices();
    expect(asksFor(provider, "/deviceauth/token")).toHaveLength(1);
    await expireLeases(b.db, "oauth_attempt");
    await b.connections.askDevices();
    await b.connections.askDevices();

    const shown = await b.api("GET", `/connections/codex/attempts/${attemptId}`, a.ada.cookie);
    expect(await shown.json()).toMatchObject({ status: "connected" });
    const connections = await b.db.execute<{ id: string }>(
      sql`select id from connection where host = 'codex' and organization_id = ${a.ada.orgId}`,
    );
    expect(connections.rows).toHaveLength(1);
    const credentials = await b.db.execute(
      sql`select connection_id from credential where connection_id = ${connections.rows[0]!.id}`,
    );
    expect(credentials.rows).toHaveLength(1);
    expect(asksFor(provider, "/oauth/token")).toHaveLength(1);
  });

  it("after beginning a code sign-in leaves its code to be taken on another", async () => {
    const provider = signInProvider();
    const [a, b] = await instances(2, { fetch: provider.fetch });
    const res = await a.api("POST", "/connections/claude/authorization", a.ada.cookie);
    const { attemptId } = (await res.json()) as { attemptId: string };
    await kill(a);
    const finished = await b.api(
      "POST",
      `/connections/claude/attempts/${attemptId}/code`,
      a.ada.cookie,
      { code: `the-code#${attemptId}` },
    );
    expect(finished.status).toBe(200);
    const connections = await b.db.execute(
      sql`select id from connection where host = 'claude' and organization_id = ${a.ada.orgId}`,
    );
    expect(connections.rows).toHaveLength(1);
    expect(asksFor(provider, "/oauth/token")).toHaveLength(1);
  });
});

// The ChatGPT sign-in the harness made in Ada's org, its tokens the provider's and about to expire.
async function expiring(a: AgentInstance, provider: ReturnType<typeof signInProvider>) {
  const found = await a.db.execute<{ id: string }>(
    sql`select id from connection where host = 'codex' and organization_id = ${a.ada.orgId}`,
  );
  const id = found.rows[0]!.id;
  const tokens = provider.issued();
  await createCredentialStore(a.db, createCipher({ version: 1, key: Buffer.alloc(32, 7) })).put(
    id,
    {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: a.clock.now.getTime() + 1000,
      accountId: "acct-1",
    },
  );
  return { id, refresh: tokens.refresh_token };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("an instance that dies renewing", () => {
  it("before the provider answered leaves another to renew once its lease runs out", async () => {
    const provider = signInProvider();
    const [a, b] = await instances(2, { fetch: provider.fetch });
    const { id, refresh } = await expiring(a, provider);
    provider.state.hold = (url) => (url.endsWith("/oauth/token") ? "before" : undefined);
    void a.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access).catch(() => {});
    await provider.state.held.promise;
    await kill(a);
    provider.state.hold = undefined;
    await expireLeases(b.db, "credential");

    const access = await b.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access);
    expect(asksFor(provider, "/oauth/token").map((one) => one.refresh)).toEqual([refresh, refresh]);
    const stored = await createCredentialStore(
      b.db,
      createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
    ).get(id);
    expect(stored).toMatchObject({ access, refresh: "refresh-2" });
  });

  it("after the provider spent its token leaves the sign-in to be made again, asked once more", async () => {
    const provider = signInProvider();
    const [a, b] = await instances(2, { fetch: provider.fetch });
    const { id, refresh } = await expiring(a, provider);
    provider.state.hold = (url) => (url.endsWith("/oauth/token") ? "after" : undefined);
    void a.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access).catch(() => {});
    await provider.state.held.promise;
    await kill(a);
    provider.state.hold = undefined;
    await expireLeases(b.db, "credential");

    await expect(
      b.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access),
    ).rejects.toThrow("Connect again");
    expect(asksFor(provider, "/oauth/token").map((one) => one.refresh)).toEqual([refresh, refresh]);
    const held = await b.db.execute(
      sql`select connection_id from credential where connection_id = ${id} and lease_owner is not null`,
    );
    expect(held.rows).toEqual([]);
  });

  it("frozen past its lease, answered late, leaves the tokens another renewed meanwhile", async () => {
    const provider = signInProvider();
    provider.state.rotates = false;
    const [a, b] = await instances(2, { fetch: provider.fetch });
    const { id } = await expiring(a, provider);
    provider.state.hold = (url) => (url.endsWith("/oauth/token") ? "late" : undefined);
    const late = a.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access);
    await provider.state.held.promise;
    provider.state.hold = undefined;
    freeze(a);
    provider.state.late.resolve();
    await expireLeases(b.db, "credential");
    const access = await b.connections.withFreshToken(a.ada.orgId, id, async (t) => t.access);
    thaw(a);

    // What it got late is not kept over the newer renewal; it uses that one.
    expect(await late).toBe(access);
    const stored = await createCredentialStore(
      b.db,
      createCipher({ version: 1, key: Buffer.alloc(32, 7) }),
    ).get(id);
    expect(stored).toMatchObject({ access, refresh: "refresh-3" });
  });

  for (const [when, named] of [
    ["before", "before its server answered leaves another to renew once its lease runs out"],
    ["after", "after its server spent the token leaves the server to be authorized again"],
  ] as const) {
    it(`an MCP server's tokens ${named}`, async () => {
      const [a, b] = await instances(2);
      const id = await authorizedServer(a);
      const handle = a.mcpNetwork.handle;
      b.mcpNetwork.handle = handle;
      const spent: string[] = [];
      let held = () => {};
      const holding = new Promise<void>((resolve) => (held = resolve));
      a.mcpNetwork.handle = async (req) => {
        const form = new URLSearchParams(await req.clone().text());
        if (new URL(req.url).pathname !== "/token" || form.get("grant_type") !== "refresh_token") {
          return handle(req);
        }
        spent.push(form.get("refresh_token")!);
        held();
        if (when === "after") await handle(req);
        return new Promise<never>(() => {});
      };
      await handle(new Request(`${MCP_ORIGIN}/control/expire`, { method: "POST" }));
      void a.api("POST", `/mcp-servers/${id}/refresh`, a.ada.cookie).catch(() => {});
      await holding;
      await kill(a);
      await expireLeases(b.db, "mcp_credential");
      const counting = b.mcpNetwork.handle;
      b.mcpNetwork.handle = async (req) => {
        const form = new URLSearchParams(await req.clone().text());
        if (form.get("grant_type") === "refresh_token") spent.push(form.get("refresh_token")!);
        return counting(req);
      };

      const renewed = await b.api("POST", `/mcp-servers/${id}/refresh`, a.ada.cookie);
      expect(await renewed.json()).toMatchObject(
        when === "before" ? { status: "ok", error: null } : { status: "needs_auth" },
      );
      expect(spent).toHaveLength(2);
      expect(new Set(spent).size).toBe(1);
    });
  }
});

// An MCP server in Ada's org, authorized through `a` in her browser; its id.
async function authorizedServer(a: AgentInstance) {
  const added = await a.api("POST", "/org/mcp-servers", a.ada.cookie, {
    name: "Notes",
    url: `${MCP_ORIGIN}/oauth/mcp`,
    auth: { kind: "oauth", clientId: null, clientSecret: null },
  });
  const { id } = (await added.json()) as { id: string };
  const res = await a.api("POST", `/mcp-servers/${id}/authorize`, a.ada.cookie);
  const started = (await res.json()) as { url: string };
  const page = await a.mcpNetwork.handle(new Request(started.url));
  const back = new URL(page.headers.get("location")!);
  await a.app.request(`${back.pathname}${back.search}`, { headers: { Cookie: a.ada.cookie } });
  return id;
}

import { describe, expect, it, vi } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { expireLeases } from "@/server/testing/database.ts";
import { openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";
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

  it("fire a due trigger once, whichever instance ticks", async () => {
    const { a, b } = await twoInstances();
    await a.triggerStore.create({
      id: "trigger-1",
      threadId: a.thread.id,
      kind: "once",
      name: "Wake",
      cron: null,
      timezone: null,
      prompt: "Carry on",
      steeredBy: [],
      createdByLabel: "Agent",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
    });
    a.clock.now = new Date();
    b.clock.now = new Date();
    expect((await b.triggers.tick()) + (await a.triggers.tick())).toBe(1);
    expect((await a.triggers.tick()) + (await b.triggers.tick())).toBe(0);
    expect((await a.events()).filter((event) => event.type === "notification")).toHaveLength(1);
  });

  it("interrupt a background call left by a dead instance once, telling its thread once", async () => {
    const { a, b } = await twoInstances();
    const run = await a.runStore.create({ threadId: a.thread.id, triggerSeq: 1, createdBy: null });
    await a.callStore.create(
      {
        id: "call-1",
        threadId: a.thread.id,
        runId: run.id,
        toolId: "probe.wait",
        input: {},
        status: "running",
      },
      { owner: "dead", leaseMs: 60_000 },
    );
    await a.calls.recover();
    await b.calls.recover();
    expect((await a.callStore.find("call-1"))?.status).toBe("running");

    await expireLeases(a.db, "background_call");
    await a.calls.recover();
    await b.calls.recover();
    expect((await a.callStore.find("call-1"))?.status).toBe("interrupted");
    const told = (await a.events()).filter(
      (event) => event.type === "notification" && event.data.kind === "call.ended",
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
    const call = a.live.open(a.thread.id, "call-1", () => true);
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
        a.bus.publish(a.thread.id, { kind: "delta", messageId: "m", upto: index + texts.length });
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
    b.bus.onActivity(({ threadId }) => heard.push(threadId));
    await a.transact(async () => {
      a.bus.activity({ threadId: "t-1" });
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
    const { a, b } = await twoInstances();
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
    const { a, b } = await twoInstances();
    const threads = await Promise.all(
      Array.from({ length: 10 }, async () => a.createThread(a.ada.cookie, a.space.id)),
    );
    for (const thread of threads) {
      await a.runStore.create({ threadId: thread.id, triggerSeq: 0, createdBy: null });
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
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
  });

  it("fire each of many due schedules once, with two instances ticking at once", async () => {
    const { a, b } = await twoInstances();
    for (let index = 0; index < 20; index += 1) {
      await a.triggerStore.create({
        id: `trigger-${index}`,
        threadId: a.thread.id,
        kind: "once",
        name: "Wake",
        cron: null,
        timezone: null,
        prompt: `Carry on ${index}`,
        steeredBy: [],
        createdByLabel: "Agent",
        status: "active",
        nextRunAt: new Date(Date.now() - 1000),
      });
    }
    a.clock.now = new Date();
    b.clock.now = new Date();
    const [byA, byB] = await Promise.all([a.triggers.tick(), b.triggers.tick()]);
    expect(byA + byB).toBe(20);
    expect((await a.events()).filter((event) => event.type === "notification")).toHaveLength(20);
  });

  it("sweep expired spaces on one instance at a time", async () => {
    const { a, b } = await twoInstances();
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
});

// Execution through its interface over a composed server: when a run starts and what it takes in,
// the worker's pass over threads whose start was missed, stops of every kind, and what a run's end
// leaves in the database whatever happens after.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import type { ToolSpec } from "@/server/tools/registry.ts";
import type { Notice } from "@/server/queue/notices.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { deadlockOnce } from "@/server/testing/workspace.ts";

function notice(text: string, wake = true): Notice {
  return {
    kind: "agent.idle",
    source: { threadId: "elsewhere", name: "Watcher", main: false },
    text,
    influence: [],
    ...(!wake && { wake: false }),
  };
}

const guarded: ToolSpec<{ label: string }> = {
  name: "probe.guarded",
  title: "Guarded",
  description: "Needs approval.",
  input: z.object({ label: z.string() }),
  risk: () => "ask",
  run: ({ label }) => Promise.resolve({ ok: true, value: { did: label } }),
};

async function until(condition: () => boolean | Promise<boolean>) {
  for (let tries = 0; !(await condition()); tries++) {
    if (tries > 2000) throw new Error("never happened");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function engine() {
  const t = await agentThread(
    {},
    {
      toolsets: [{ id: "probe", title: "Probe", source: "builtin", tools: [guarded] }],
    },
  );
  const gate = { open: true };
  t.execution.gate(async () => gate.open);
  // What each run took in at its start, by the inputs' texts.
  async function admitted() {
    const events = await t.events();
    const text = new Map(
      events.map((event) => [
        event.id,
        event.type === "message"
          ? (event.data.parts[0] as { text: string }).text
          : event.type === "notice"
            ? event.data.text
            : "",
      ]),
    );
    return events
      .filter((event) => event.type === "message.admitted")
      .map((event) => event.data.messageIds.map((id: string) => text.get(id)));
  }
  const message = async (text: string, delivery: "steer" | "queue" = "steer") =>
    t.queue.enqueue(t.thread.id, { kind: "message", by: t.ada.userId, text, delivery });
  const tell = async (text: string, wake = true) =>
    t.queue.enqueue(t.thread.id, { kind: "notice", notice: notice(text, wake) });
  return { ...t, gate, admitted, message, tell };
}

describe("a run starts", () => {
  // Idle or busy, what arrives, and whether the gate lets a notice start the agent: whether a run
  // is made, and what it took in at its start.
  const table = [
    { busy: false, input: "message", gate: true, runs: 1, takes: [["M"]] },
    { busy: false, input: "message", gate: false, runs: 1, takes: [["M"]] },
    { busy: false, input: "notice", gate: true, runs: 1, takes: [["N"]] },
    { busy: false, input: "notice", gate: false, runs: 0, takes: [] },
    { busy: false, input: "silent", gate: true, runs: 0, takes: [] },
    { busy: true, input: "message", gate: true, runs: 1, takes: [["Busy"]] },
    { busy: true, input: "notice", gate: true, runs: 1, takes: [["Busy"]] },
    { busy: true, input: "silent", gate: false, runs: 1, takes: [["Busy"]] },
  ] as const;

  for (const row of table) {
    it(`${row.busy ? "busy" : "idle"}, on a ${row.input}, the gate ${row.gate ? "open" : "shut"}`, async () => {
      const e = await engine();
      if (row.busy) await e.message("Busy");
      e.gate.open = row.gate;
      if (row.input === "message") await e.message("M");
      else await e.tell(row.input === "notice" ? "N" : "S", row.input === "notice");
      expect(await e.runs()).toHaveLength(row.runs);
      expect(await e.admitted()).toEqual(row.takes);
    });
  }
});

describe("what a run takes in at its start", () => {
  it("is every input waiting, in one admission, when a person's message starts it", async () => {
    const e = await engine();
    e.gate.open = false;
    await e.tell("Held");
    await e.message("M");
    expect(await e.admitted()).toEqual([["M", "Held"]]);
  });

  it("is every input waiting, in one admission, when a run's successor starts", async () => {
    const e = await engine();
    await e.start();
    await e.message("Go");
    const first = await e.model.next();
    first.step("Working.");
    await first.drained();
    await e.message("One", "queue");
    await e.message("Two", "queue");
    first.end();
    const next = await e.model.next();
    next.reply("Done.");
    await e.worker.idle();
    expect((await e.admitted()).at(-1)).toEqual(["One", "Two"]);
  });

  it("leaves what arrives after its start for its first step", async () => {
    const e = await engine();
    await e.message("One");
    await e.message("Two");
    await e.start();
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    expect(await e.admitted()).toEqual([["One"], ["Two"]]);
  });

  it("drops the messages of those who may no longer post, and takes in the rest", async () => {
    const e = await engine();
    await e.start();
    await e.message("Go");
    const first = await e.model.next();
    first.step("Working.");
    await first.drained();
    await e.queue.enqueue(e.thread.id, {
      kind: "message",
      by: e.grace.userId,
      text: "From Grace",
      delivery: "queue",
    });
    await e.message("From Ada", "queue");
    await e.spaceStore.revoke(e.space.id, { kind: "user", id: e.grace.userId });
    first.end();
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    expect((await e.admitted()).at(-1)).toEqual(["From Ada"]);
    expect((await e.types()).filter((type) => type === "message.dropped")).toHaveLength(1);
  });
});

describe("the worker's pass", () => {
  it("starts a thread whose start was missed, once its gate opens, with nothing told in memory", async () => {
    const e = await engine();
    await e.start();
    await e.message("Go");
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    e.gate.open = false;
    await e.tell("Held");
    await e.worker.idle();
    expect(await e.runs()).toHaveLength(1);
    expect(await e.queue.stranded()).toEqual([e.thread.id]);
    e.gate.open = true;
    // The next pass starts it.
    const passed = e.worker.idle();
    const call = await e.model.next();
    expect(call.texts.at(-1)).toContain("Held");
    call.reply("Done.");
    await passed;
    expect(await e.queue.stranded()).toEqual([]);
  });

  it("leaves out a log copied in with no runs of its own", async () => {
    const e = await engine();
    await e.log.write(e.thread.id, async (append) =>
      append({ type: "notice", actor: { kind: "agent" }, data: notice("Copied") }),
    );
    await e.queue.fromLog(e.thread.id);
    expect(await e.queue.stranded()).toEqual([]);
  });
});

describe("a stop", () => {
  it("is one statement per run, and queues again a run that waits", async () => {
    const e = await engine();
    await e.start();
    await e.message("Go");
    const call = await e.model.next();
    call.startStep();
    call.toolCall("g", "probe.guarded", { label: "g" });
    call.endStep();
    call.end();
    await until(async () => (await e.runs())[0]?.status === "waiting");
    await e.worker.stop();
    const [stopped] = await e.execution.stop({ threadId: e.thread.id }, e.ada.userId);
    expect(stopped).toMatchObject({ status: "queued", cancelSilent: false });
    expect(stopped?.cancelRequestedBy).toBe(e.ada.userId);
    // Asked once: a second stop finds nothing to ask.
    expect(await e.execution.stop({ threadId: e.thread.id }, e.ada.userId)).toEqual([]);
    const worker = e.makeWorker();
    await e.start(worker);
    await worker.idle();
    expect((await e.runs())[0]?.status).toBe("cancelled");
  });

  it("reaches every run of a space, and of an org", async () => {
    const e = await engine();
    await e.message("Go");
    expect(await e.execution.stop({ spaceId: e.space.id }, null)).toHaveLength(1);
    const other = await e.createThread(e.ada.cookie, e.space.id);
    await e.queue.enqueue(other.id, {
      kind: "message",
      by: e.ada.userId,
      text: "Hi",
      delivery: "steer",
    });
    expect(await e.execution.stop({ orgId: e.ada.orgId }, null, { silent: true })).toEqual([
      expect.objectContaining({ threadId: other.id, cancelSilent: true }),
    ]);
    await e.start();
    await e.worker.idle();
    expect((await e.runs()).map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("of a space run again after a deadlock asks each run to stop once", async () => {
    const e = await engine();
    await e.message("Go");
    const other = await e.createThread(e.ada.cookie, e.space.id);
    await e.queue.enqueue(other.id, {
      kind: "message",
      by: e.ada.userId,
      text: "Hi",
      delivery: "steer",
    });
    const deadlock = deadlockOnce();
    const stop = e.runStore.stop.bind(e.runStore);
    e.runStore.stop = async (...args) => {
      const stopped = await stop(...args);
      deadlock();
      return stopped;
    };
    const retries = e.sync.stats.retries;
    expect(await e.execution.stop({ spaceId: e.space.id }, e.ada.userId)).toHaveLength(2);
    expect(e.sync.stats.retries).toBe(retries + 1);
    expect(await e.execution.stop({ spaceId: e.space.id }, e.ada.userId)).toEqual([]);
    await e.start();
    await e.worker.idle();
    expect((await e.runs()).map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect((await e.types()).filter((type) => type === "run.cancelled")).toHaveLength(1);
  });

  it("asked before a run would wait ends it, never leaving it waiting", async () => {
    const e = await engine();
    await e.message("Go");
    const [run] = await e.runs();
    const claimed = (await e.runStore.claim("holder", 60_000))!;
    await e.execution.stop({ threadId: e.thread.id }, e.ada.userId);
    const lease = { runId: run!.id, owner: "holder", epoch: claimed.leaseEpoch };
    expect(await e.runStore.wait(lease)).toBeNull();
    expect((await e.runStore.find(run!.id))?.status).toBe("running");
    // Its holder gone, it is taken over and tried again, as any run left running is.
    await e.db.execute(sql`update run set lease_expires_at = to_timestamp(0)`);
    await e.start();
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    expect((await e.runs()).map((one) => one.status)).toEqual(["failed", "completed"]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("stopping on Postgres", () => {
  it("of a space meets runs ending in the same space, either way round, with no deadlock reaching it", async () => {
    const e = await engine();
    await e.start();
    const threads = [e.thread.id];
    for (let index = 0; index < 3; index += 1) {
      threads.push((await e.createThread(e.ada.cookie, e.space.id)).id);
    }
    for (const [index, threadId] of threads.entries()) {
      await e.queue.enqueue(threadId, {
        kind: "message",
        by: e.ada.userId,
        text: `Go ${index}`,
        delivery: "steer",
      });
    }
    const calls = await Promise.all(threads.map(async () => e.model.next()));
    // Half end before the stop is asked, half after.
    const ends = calls.map((call, index) =>
      index % 2 === 0
        ? Promise.resolve(call.reply("Done."))
        : new Promise<void>((resolve) => setTimeout(() => resolve(call.reply("Done.")), 1)),
    );
    const [stopped] = await Promise.all([
      e.execution.stop({ spaceId: e.space.id }, e.ada.userId),
      ...ends,
    ]);
    await e.worker.idle();
    const runs = await e.runs();
    expect(runs.every((run) => run.status === "completed" || run.status === "cancelled")).toBe(
      true,
    );
    expect(stopped.length).toBeLessThanOrEqual(threads.length);
  });
});

describe("a run's end", () => {
  it("leaves what follows it in the database, though what runs after its write fails", async () => {
    const e = await engine();
    e.execution.onEndKept(async () => {
      throw new Error("after the end, for this test");
    });
    await e.start();
    await e.message("Go");
    const first = await e.model.next();
    first.startStep();
    await first.drained();
    await e.message("Then", "queue");
    first.end();
    const next = await e.model.next();
    expect(next.texts.at(-1)).toBe("user: [Ada Lovelace] Then");
    next.reply("Done.");
    await e.worker.idle();
    expect((await e.runs()).map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("written again after a deadlock leaves one end, and what followed it once", async () => {
    const e = await engine();
    const deadlock = deadlockOnce();
    e.execution.onEnded(async () => deadlock());
    await e.start();
    await e.message("Go");
    const first = await e.model.next();
    first.startStep();
    await first.drained();
    await e.message("Then", "queue");
    const retries = e.sync.stats.retries;
    first.end();
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    expect(e.sync.stats.retries).toBeGreaterThan(retries);
    const types = await e.types();
    expect(types.filter((type) => type === "run.completed")).toHaveLength(2);
    expect(types.filter((type) => type === "run.created")).toHaveLength(2);
    expect((await e.runs()).map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("goes on from a wait only once none of its calls waits", async () => {
    const e = await engine();
    await e.start();
    await e.message("Go");
    const call = await e.model.next();
    call.startStep();
    call.toolCall("a", "probe.guarded", { label: "a" });
    call.toolCall("b", "probe.guarded", { label: "b" });
    call.endStep();
    call.end();
    await until(async () => (await e.runs())[0]?.status === "waiting");
    const decide = (id: string) =>
      e.api("POST", `/threads/${e.thread.id}/tools/${id}/decision`, e.ada.cookie, {
        allow: true,
        scope: "once",
      });
    expect((await decide("a")).status).toBe(200);
    expect((await e.runs())[0]?.status).toBe("waiting");
    expect((await decide("b")).status).toBe(200);
    (await e.model.next()).reply("Done.");
    await e.worker.idle();
    expect((await e.runs())[0]?.status).toBe("completed");
  });
});

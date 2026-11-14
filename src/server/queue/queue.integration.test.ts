// The queue through its interface, over a composed server: what an enqueue writes, how a key makes
// a delivery once, what a run takes in, and where inputs stand after a change of branch or a copy.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { NotificationKind } from "@/shared/threads/events.ts";

import type { Notification } from "./notices.ts";
import type { QueuedInput } from "./queue.ts";

function notice(text: string, kind: NotificationKind = "agent.idle", wake = true): Notification {
  return {
    kind,
    source: { threadId: "elsewhere", name: "Watcher", main: false },
    text,
    people: [],
    ...(!wake && { wake: false }),
  };
}

async function queued() {
  const w = await agentThread();
  const { queue, thread, ada, grace } = w;
  const told: QueuedInput[] = [];
  queue.onEnqueued(async (input) => {
    told.push(input);
  });
  const rows = async () =>
    (
      await w.db.execute<{
        id: string;
        kind: string;
        status: string;
        wake: boolean;
        origin_kind: string;
        origin_id: string;
        admitted_run_id: string | null;
        branch_id: string;
      }>(sql`select id, kind, status, wake, origin_kind, origin_id, admitted_run_id, branch_id
               from thread_input where thread_id = ${thread.id} order by seq`)
    ).rows;
  const message = async (who: { userId: string }, text: string, delivery = "steer" as const) =>
    queue.enqueue(thread.id, { kind: "message", by: who.userId, text, delivery });
  const tell = async (text: string, wake = true, opts = {}) =>
    queue.enqueue(thread.id, { kind: "notice", notice: notice(text, "agent.idle", wake) }, opts);
  const readerOf = async (who: typeof ada) => w.access.require(who, thread.id, "post");
  return { ...w, told, rows, message, tell, readerOf, ada, grace };
}

describe("enqueue", () => {
  it("writes one event and one row for a message, a notice that wakes and one that does not", async () => {
    const q = await queued();
    await q.message(q.ada, "Hello");
    await q.tell("Idle", true, { origin: { kind: "subagent", id: "elsewhere" } });
    await q.tell("Quiet change", false);
    expect(await q.rows()).toEqual([
      expect.objectContaining({ kind: "message", origin_kind: "person", origin_id: q.ada.userId }),
      expect.objectContaining({ kind: "notice", wake: true, origin_kind: "subagent" }),
      expect.objectContaining({ kind: "notice", wake: false }),
    ]);
    expect(
      (await q.types()).filter((type) => type !== "run.created" && type !== "message.admitted"),
    ).toEqual(["message", "notification", "notification"]);
    expect(q.told).toHaveLength(3);
  });

  it("writes an aside as an event with no row, and tells no listener", async () => {
    const q = await queued();
    const { input } = await q.queue.enqueue(q.thread.id, {
      kind: "message",
      by: q.ada.userId,
      text: "// between us",
      delivery: "steer",
      quiet: true,
    });
    expect(input).toBeNull();
    expect(await q.rows()).toEqual([]);
    expect(await q.types()).toEqual(["message"]);
    expect(q.told).toEqual([]);
  });

  it("makes a delivery with a key once, answering what the first made", async () => {
    const q = await queued();
    const first = await q.tell("Fired", true, { key: "schedule:1:a" });
    const again = await q.tell("Fired", true, { key: "schedule:1:a" });
    expect(again.input?.id).toBe(first.input?.id);
    expect(again.event.id).toBe(first.event.id);
    await q.tell("Fired", true, { key: "schedule:1:b" });
    expect(await q.rows()).toHaveLength(2);
    expect((await q.types()).filter((type) => type === "notification")).toHaveLength(2);
  });

  it("leaves nothing and wakes nobody when its transaction rolls back", async () => {
    const q = await queued();
    const woken: string[] = [];
    const off = q.bus.onWake((id) => woken.push(id));
    await expect(
      q.transact(async () => {
        await q.tell("Never");
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    off();
    expect(await q.rows()).toEqual([]);
    expect(await q.types()).toEqual([]);
    expect(woken).toEqual([]);
  });

  it("tells its listeners in its own write, so one that throws leaves nothing", async () => {
    const q = await queued();
    q.queue.onEnqueued(async (input) => {
      if (input.kind === "notice") throw new Error("refused");
    });
    await expect(q.tell("Refused")).rejects.toThrow("refused");
    expect(await q.rows()).toEqual([]);
    expect(await q.types()).toEqual([]);
  });
});

describe("what waits", () => {
  it("is oldest first, people's messages and notices together, as they read after changes", async () => {
    const q = await queued();
    await q.message(q.ada, "Go");
    const notified = await q.tell("Idle");
    const sent = await q.message(q.grace, "Then this");
    await q.queue.change(await q.readerOf(q.grace), sent.input!.id, {
      text: "Then this, changed",
      delivery: "queue",
    });
    const waiting = await q.queue.waiting(q.thread.id);
    expect(waiting.map((input) => input.id)).toEqual([notified.input!.id, sent.input!.id]);
    expect(waiting[1]).toMatchObject({
      delivery: "queue",
      message: { text: "Then this, changed", mode: "queue" },
    });
    expect(await q.queue.wakes(q.thread.id)).toBe(true);
  });

  it("changes only for its author, while it waits, and never a command's text", async () => {
    const q = await queued();
    await q.message(q.ada, "Go");
    const sent = await q.message(q.grace, "Mine");
    await expect(
      q.queue.change(await q.readerOf(q.ada), sent.input!.id, { text: "Hers" }),
    ).rejects.toMatchObject({ status: 403 });
    const command = await q.queue.enqueue(q.thread.id, {
      kind: "message",
      by: q.grace.userId,
      text: "/compact",
      delivery: "queue",
      command: { name: "compact", args: "", text: "Compact the thread." },
    });
    await expect(
      q.queue.change(await q.readerOf(q.grace), command.input!.id, { text: "Other" }),
    ).rejects.toMatchObject({ status: 409 });
    await q.queue.change(await q.readerOf(q.grace), sent.input!.id, { delivery: "queue" });
    await q.queue.change(await q.readerOf(q.grace), sent.input!.id, { delivery: "steer" });
    expect(
      (await q.queue.waiting(q.thread.id)).find((one) => one.id === sent.input!.id),
    ).toMatchObject({ delivery: "steer" });
    const first = (await q.rows())[0]!;
    await expect(
      q.queue.change(await q.readerOf(q.ada), first.id, { text: "Too late" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("is taken back once", async () => {
    const q = await queued();
    await q.message(q.ada, "Go");
    const sent = await q.message(q.grace, "Never mind");
    await q.queue.withdraw(await q.readerOf(q.grace), sent.input!.id);
    expect((await q.rows()).find((row) => row.id === sent.input!.id)?.status).toBe("withdrawn");
    expect(await q.queue.waiting(q.thread.id)).toEqual([]);
    await expect(q.queue.withdraw(await q.readerOf(q.grace), sent.input!.id)).rejects.toMatchObject(
      { status: 409 },
    );
  });
});

describe("what a run takes in", () => {
  // A run under way, with a steering and a queued message and a notice waiting for it.
  async function busy() {
    const q = await queued();
    await q.message(q.ada, "Go");
    const run = (await q.runStore.active(q.thread.id))!;
    const notified = (await q.tell("Idle")).input!;
    const steer = (await q.message(q.grace, "Steer")).input!;
    const later = (await q.message(q.grace, "Later", "queue" as "steer")).input!;
    const compact = (
      await q.queue.enqueue(q.thread.id, {
        kind: "message",
        by: q.grace.userId,
        text: "/compact",
        delivery: "queue",
        command: { name: "compact", args: "", text: "Compact the thread." },
      })
    ).input!;
    return { ...q, run, notified, steer, later, compact };
  }

  async function admitted(q: Awaited<ReturnType<typeof queued>>) {
    return (await q.events())
      .filter((event) => event.type === "message.admitted")
      .map((event) => (event.data as { messageIds: string[] }).messageIds);
  }

  it("is what steers it, then every notice, in one event naming messages before notices", async () => {
    const q = await busy();
    const taken = await q.queue.admission.admit(q.run, "steering");
    expect(taken.map((input) => input.id)).toEqual([q.steer.id, q.notified.id]);
    expect((await admitted(q)).at(-1)).toEqual([q.steer.id, q.notified.id]);
    const rows = await q.rows();
    expect(rows.find((row) => row.id === q.steer.id)).toMatchObject({
      status: "admitted",
      admitted_run_id: q.run.id,
    });
    expect(rows.find((row) => row.id === q.later.id)?.status).toBe("waiting");
  });

  it("is every message but one asking to compact, with all", async () => {
    const q = await busy();
    const taken = await q.queue.admission.admit(q.run, "all");
    expect(taken.map((input) => input.id)).toEqual([q.steer.id, q.later.id, q.notified.id]);
    expect((await q.queue.waiting(q.thread.id)).map((input) => input.id)).toEqual([q.compact.id]);
  });

  it("is those named, once each", async () => {
    const q = await busy();
    const before = (await admitted(q)).length;
    await q.queue.admission.admit(q.run, { ids: [q.compact.id] });
    await q.queue.admission.admit(q.run, { ids: [q.compact.id] });
    expect((await admitted(q)).slice(before)).toEqual([[q.compact.id]]);
  });

  it("drops first the messages of those who may no longer post", async () => {
    const q = await busy();
    await q.spaceStore.revoke(q.space.id, { kind: "user", id: q.grace.userId });
    const taken = await q.queue.admission.admit(q.run, "all");
    expect(taken.map((input) => input.id)).toEqual([q.notified.id]);
    expect((await q.types()).filter((type) => type === "message.dropped")).toHaveLength(3);
    expect((await q.rows()).filter((row) => row.status === "dropped")).toHaveLength(3);
  });
});

describe("a new branch", () => {
  // Makes a branch from the current one after the seq, current from then on, as the branch
  // actions do, in one write with what the queue does about it.
  async function branchAfter(q: Awaited<ReturnType<typeof queued>>, forkSeq: number) {
    const before = (await q.threadStore.find(q.thread.id))!;
    const { result } = await q.log.write(q.thread.id, async (append) => {
      const made = await q.threadStore.addBranch({
        threadId: q.thread.id,
        parentBranchId: before.currentBranchId,
        forkSeq,
        kind: "restore",
        rowId: "r",
        groupRowId: null,
        createdBy: q.ada.userId,
      });
      await append(
        { type: "branch.started", actor: { kind: "agent" }, data: { kind: "restore", rowId: "r" } },
        undefined,
        made.id,
      );
      await q.threadStore.setCurrent(q.thread.id, made.id);
      await q.queue.admission.branched(q.thread.id, made.id, before.currentBranchId);
      return made;
    });
    return { left: before.currentBranchId, branch: result.id };
  }

  // The call `id` the thread's log asks for, so a branch may hold it.
  async function asked(q: Awaited<ReturnType<typeof queued>>, id: string) {
    await q.log.write(q.thread.id, async (append) => {
      const requested = await append({
        type: "tool.requested",
        actor: { kind: "agent" },
        data: {
          runId: "r",
          callId: id,
          messageId: "",
          toolId: "probe.wait",
          input: {},
          risk: "normal",
          waits: false,
          background: true,
        },
      });
      await append({
        type: "tool.ran",
        actor: { kind: "agent" },
        data: { runId: "r", callId: id, ok: true, value: null, ms: 0 },
      });
      const branchId = (await q.threadStore.find(q.thread.id))!.currentBranchId;
      await q.callStore.insert([
        {
          threadId: q.thread.id,
          id,
          branchId,
          seq: requested.seq,
          runId: "r",
          toolId: "probe.wait",
          risk: "normal",
          status: "completed",
          waitsFor: null,
          background: true,
        },
      ]);
    });
  }

  const quiet = (text: string) => notice(text, "agent.idle", false);

  // A run under way on the current branch, so what is enqueued waits; and its end.
  async function held(q: Awaited<ReturnType<typeof queued>>) {
    const seq = (await q.threadStore.find(q.thread.id))!.lastEventSeq;
    return q.runStore.create({ threadId: q.thread.id, triggerSeq: seq, createdBy: null });
  }
  async function ended(q: Awaited<ReturnType<typeof queued>>, run: { id: string }) {
    await q.log.write(q.thread.id, async (append) => {
      await q.db.execute(sql`update run set status = 'cancelled' where id = ${run.id}`);
      await append(
        { type: "run.cancelled", actor: { kind: "agent" }, data: { runId: run.id } },
        undefined,
        (await q.runStore.find(run.id))!.branchId,
      );
    });
  }

  it("has the notices it reads and has not taken in waiting, and still on the branch left", async () => {
    const q = await queued();
    const run = await held(q);
    const read = (await q.tell("Read", false)).input!;
    const sent = (await q.message(q.grace, "Waiting")).input!;
    const { left, branch } = await branchAfter(q, read.seq);
    await ended(q, run);
    const rows = await q.rows();
    expect(
      rows.filter((row) => row.id === read.id).map((row) => [row.branch_id, row.status]),
    ).toEqual(
      expect.arrayContaining([
        [left, "waiting"],
        [branch, "waiting"],
      ]),
    );
    expect(rows.find((row) => row.id === sent.id)).toMatchObject({
      status: "dropped",
      branch_id: left,
    });
  });

  it("has a notice waiting that the branch left took in after the fork point", async () => {
    const q = await queued();
    const read = (await q.tell("Read", false)).input!;
    const run = await q.runStore.create({
      threadId: q.thread.id,
      triggerSeq: read.seq,
      createdBy: null,
    });
    await q.queue.admission.admit(run, "all");
    await ended(q, run);
    const { left, branch } = await branchAfter(q, read.seq);
    const rows = (await q.rows()).filter((row) => row.id === read.id);
    expect(rows.map((row) => [row.branch_id, row.status])).toEqual(
      expect.arrayContaining([
        [left, "admitted"],
        [branch, "waiting"],
      ]),
    );
  });

  it("is told again a notice it does not read whose source it holds, or that has none", async () => {
    const q = await queued();
    await asked(q, "job-before");
    const fork = (await q.message(q.ada, "Fork here")).input!;
    await q.queue.admission.dropRefused(q.thread.id);
    const held = (
      await q.queue.enqueue(
        q.thread.id,
        { kind: "notice", notice: quiet("Held") },
        { origin: { kind: "job", id: "job-before" }, source: { callId: "job-before" } },
      )
    ).input!;
    await asked(q, "job-after");
    const unheld = (
      await q.queue.enqueue(
        q.thread.id,
        { kind: "notice", notice: quiet("Not held") },
        { origin: { kind: "job", id: "job-after" }, source: { callId: "job-after" } },
      )
    ).input!;
    const none = (await q.tell("No source", false)).input!;
    const { left, branch } = await branchAfter(q, fork.seq);
    const rows = await q.rows();
    const copies = (
      await q.db.execute<{
        copy_of: string;
        branch_id: string;
        status: string;
        source_call_id: string | null;
      }>(
        sql`select copy_of, branch_id, status, source_call_id from thread_input
             where thread_id = ${q.thread.id} and copy_of is not null order by seq`,
      )
    ).rows;
    expect(copies).toEqual([
      { copy_of: held.id, branch_id: branch, status: "waiting", source_call_id: "job-before" },
      { copy_of: none.id, branch_id: branch, status: "waiting", source_call_id: null },
    ]);
    for (const original of [held, unheld, none]) {
      expect(rows.find((row) => row.id === original.id)).toMatchObject({
        branch_id: left,
        status: "waiting",
      });
    }
    const types = (await q.threadStore.eventsAfter(q.thread.id, 0, branch)).map(
      (event) => event.type,
    );
    expect(types.filter((type) => type === "notification")).toHaveLength(2);
  });

  it("holds a source made on the parent before the fork, at it, not after, and on a grandparent", async () => {
    const q = await queued();
    await asked(q, "grand");
    const first = (await q.tell("Mark", false)).input!;
    await branchAfter(q, first.seq);
    await asked(q, "before");
    await asked(q, "at");
    const at = (await q.callStore.find(q.thread.id, "at"))!;
    await asked(q, "after");
    for (const id of ["grand", "before", "at", "after"]) {
      await q.queue.enqueue(
        q.thread.id,
        { kind: "notice", notice: quiet(`From ${id}`) },
        { origin: { kind: "job", id }, source: { callId: id } },
      );
    }
    const { branch } = await branchAfter(q, at.seq);
    const copies = (
      await q.db.execute<{ source_call_id: string }>(
        sql`select source_call_id from thread_input
             where thread_id = ${q.thread.id} and branch_id = ${branch} and copy_of is not null
             order by seq`,
      )
    ).rows.map((row) => row.source_call_id);
    expect(copies).toEqual(["grand", "before", "at"]);
  });

  // A notice that wakes, told while a run under way holds it back, and a branch made from before
  // it with that run stopped; answers whether the worker then starts the agent.
  async function restoredWith(source: { callId: string } | undefined) {
    const q = await queued();
    const mark = (await q.tell("Mark", false)).input!;
    if (source) await asked(q, source.callId);
    const run = await held(q);
    await q.queue.enqueue(
      q.thread.id,
      { kind: "notice", notice: notice("Wakes") },
      source ? { origin: { kind: "job", id: source.callId }, source } : {},
    );
    await ended(q, run);
    await branchAfter(q, mark.seq);
    await q.start();
    return q;
  }

  it("is started on a notice that wakes and is told again, by the worker's pass", async () => {
    const q = await restoredWith(undefined);
    const call = await q.model.next();
    expect(call.texts.at(-1)).toContain("Wakes");
    call.reply("Read.");
    await q.worker.idle();
  });

  it("is not started when no notice is told again", async () => {
    const q = await restoredWith({ callId: "job-after" });
    await q.worker.idle();
    expect(q.model.calls).toHaveLength(0);
  });

  it("drops the messages waiting on the branch left, and has an edit's kept ones taken in on each", async () => {
    const q = await queued();
    await q.start();
    await q.post(q.ada, "Go");
    const first = await q.model.next();
    first.step("Working.");
    await first.drained();
    const one = await q.post(q.ada, "One", "queue");
    const two = await q.post(q.grace, "Two", "queue");
    first.end();
    (await q.model.next()).reply("Both read.");
    await q.worker.idle();
    const res = await q.api("POST", `/threads/${q.thread.id}/history`, q.ada.cookie, {
      action: "edit",
      rowId: one.id,
      text: "One, edited",
    });
    expect(res.status).toBe(200);
    (await q.model.next()).reply("Read again.");
    await q.worker.idle();
    const rows = (await q.rows()).filter((row) => row.id === two.id);
    expect(rows.map((row) => row.status)).toEqual(["admitted", "admitted"]);
    expect(new Set(rows.map((row) => row.branch_id)).size).toBe(2);
  });

  it("is told again what a trigger no call set sent, as a notice with no source", async () => {
    const q = await queued();
    const mark = (await q.tell("Mark", false)).input!;
    const run = await held(q);
    await q.scheduleStore.create({
      id: "trigger-1",
      threadId: q.thread.id,
      kind: "once",
      name: "Wake",
      cron: null,
      timezone: null,
      prompt: "Carry on",
      influence: [],
      callId: null,
      nextRunAt: new Date(q.clock.now.getTime() - 1000),
    });
    expect(await q.schedules.tick()).toBe(1);
    await ended(q, run);
    const { branch } = await branchAfter(q, mark.seq);
    const copies = (
      await q.db.execute<{ origin_kind: string; source_call_id: string | null }>(
        sql`select origin_kind, source_call_id from thread_input
             where branch_id = ${branch} and copy_of is not null`,
      )
    ).rows;
    expect(copies).toEqual([{ origin_kind: "schedule", source_call_id: null }]);
    await q.start();
    (await q.model.next()).reply("Carried on.");
    await q.worker.idle();
  });

  it("is answered for a key used on another branch, adding nothing", async () => {
    const q = await queued();
    const once = (await q.tell("Once", false, { key: "k" })).input!;
    await branchAfter(q, 0);
    const again = await q.tell("Again", false, { key: "k" });
    expect(again.input?.id).toBe(once.id);
    expect((await q.rows()).filter((row) => row.id === once.id)).toHaveLength(1);
  });

  it("changes, withdraws and admits only the row of the branch named", async () => {
    const q = await queued();
    const read = (await q.tell("Read", false)).input!;
    const { left, branch } = await branchAfter(q, read.seq);
    const run = await q.runStore.create({
      threadId: q.thread.id,
      branchId: branch,
      triggerSeq: read.seq,
      createdBy: null,
    });
    await q.queue.admission.admit(run, "all");
    const rows = (await q.rows()).filter((row) => row.id === read.id);
    expect(rows.map((row) => [row.branch_id, row.status])).toEqual(
      expect.arrayContaining([
        [left, "waiting"],
        [branch, "admitted"],
      ]),
    );
    await ended(q, run);
  });
});

describe("a log copied in", () => {
  it("gets rows that say what its log says", async () => {
    const q = await queued();
    const actor = { kind: "user" as const, userId: q.ada.userId };
    const text = (said: string) => [{ type: "text" as const, text: said }];
    const ids = await q.log.write(q.thread.id, async (append) => {
      const taken = await append({
        type: "message",
        actor,
        data: { parts: text("Taken"), quiet: false, mode: "steer" },
      });
      const back = await append({
        type: "message",
        actor,
        data: { parts: text("Back"), quiet: false, mode: "steer" },
      });
      const waits = await append({
        type: "message",
        actor,
        data: { parts: text("Waits"), quiet: false, mode: "queue" },
      });
      const told = await append({
        type: "notification",
        actor: { kind: "agent" },
        data: notice("Told"),
      });
      await append({
        type: "message.admitted",
        actor: { kind: "agent" },
        data: { runId: "r-1", messageIds: [taken.id] },
      });
      await append({ type: "message.withdrawn", actor, data: { messageId: back.id } });
      return { taken: taken.id, back: back.id, waits: waits.id, told: told.id };
    });
    await q.queue.fromLog(q.thread.id);
    const rows = await q.rows();
    expect(rows.map((row) => [row.id, row.status, row.admitted_run_id])).toEqual([
      [ids.result.taken, "admitted", "r-1"],
      [ids.result.back, "withdrawn", null],
      [ids.result.waits, "waiting", null],
      [ids.result.told, "waiting", null],
    ]);
  });
});

describe("history", () => {
  it("lists what came to the thread from an origin, newest first, a page at a time", async () => {
    const q = await queued();
    const origin = { kind: "webhook" as const, id: "hook-1" };
    for (const text of ["one", "two", "three"]) {
      await q.queue.enqueue(
        q.thread.id,
        { kind: "notice", notice: notice(text, "webhook.received", false) },
        { origin },
      );
    }
    const first = await q.queue.history(q.thread.id, origin, { offset: 0, limit: 2 });
    const rest = await q.queue.history(q.thread.id, origin, { offset: 2, limit: 2 });
    expect(first.total).toBe(3);
    expect([...first.entries, ...rest.entries].map((entry) => entry.notice.text)).toEqual([
      "three",
      "two",
      "one",
    ]);
    expect(await q.queue.counts(q.thread.id, ["webhook"])).toEqual(new Map([["hook-1", 3]]));
  });

  it("counts each once across branches, leaves copies out, and another thread's rows", async () => {
    const q = await queued();
    const origin = { kind: "job" as const, id: "job-1" };
    const told = (
      await q.queue.enqueue(
        q.thread.id,
        { kind: "notice", notice: notice("Told", "agent.idle", false) },
        { origin },
      )
    ).input!;
    // The same notice on a second branch, and a copy of it.
    const branch = await q.threadStore.addBranch({
      threadId: q.thread.id,
      parentBranchId: told.branchId,
      forkSeq: told.seq,
      kind: "restore",
      rowId: "r",
      groupRowId: null,
      createdBy: q.ada.userId,
    });
    await q.db
      .execute(sql`insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake,
                                                      origin_kind, origin_id)
                           values (${told.id}, ${q.thread.id}, ${branch.id}, ${told.seq}, 'notice',
                                   'waiting', false, 'job', 'job-1')`);
    await q.log.write(q.thread.id, async (append) => {
      const copy = await append(
        {
          type: "notification",
          actor: { kind: "agent" },
          data: notice("Told", "agent.idle", false),
        },
        undefined,
        branch.id,
      );
      await q.db
        .execute(sql`insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake,
                                                        origin_kind, origin_id, copy_of)
                             values (${copy.id}, ${q.thread.id}, ${branch.id}, ${copy.seq}, 'notice',
                                     'waiting', false, 'job', 'job-1', ${told.id})`);
    });
    const other = await q.createThread(q.ada.cookie, q.space.id);
    await q.queue.enqueue(
      other.id,
      { kind: "notice", notice: notice("Elsewhere", "agent.idle", false) },
      { origin },
    );
    expect((await q.queue.history(q.thread.id, origin, { offset: 0, limit: 10 })).total).toBe(1);
    expect(await q.queue.counts(q.thread.id, ["job"])).toEqual(new Map([["job-1", 1]]));
    await q.threadStore.setCurrent(q.thread.id, told.branchId);
  });
});

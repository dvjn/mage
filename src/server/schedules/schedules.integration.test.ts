import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { NOTICES_HEADING } from "@/server/execution/context.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { setup } from "@/server/testing/workspace.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { eventSummary } from "@/server/threads/log.ts";
import { describeCron } from "@/shared/schedules.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import { transcriptOf } from "@/shared/transcript.ts";

async function scheduleThread() {
  const workspace = await agentThread();
  const { model, threadStore, thread } = workspace;
  const taken = new Set<Call>();
  let count = 0;

  async function callIn(threadId: string): Promise<Call> {
    for (;;) {
      const call = model.calls.find(
        (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
      );
      if (call) {
        taken.add(call);
        return call;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function calls(threadId: string, ...asked: [string, unknown][]) {
    const call = await callIn(threadId);
    call.startStep();
    call.delta("On it.");
    for (const [toolId, input] of asked) {
      count += 1;
      call.toolCall(`call-${count}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }

  async function answer(threadId: string, text = "Done.") {
    const call = await callIn(threadId);
    call.reply(text);
    return call;
  }

  async function rowsOf() {
    return transcriptOf((await threadStore.eventsAfter(thread.id, 0)).map(eventSummary)).rows;
  }

  // Sets timers and schedules the way the agent does, and returns what the tool gave back.
  async function set(...asked: [string, unknown][]) {
    await workspace.post(workspace.ada, "Set it up");
    await calls(thread.id, ...asked);
    return answer(thread.id);
  }

  return { ...workspace, calls, answer, rowsOf, set };
}

const MINUTE = 60_000;

describe("describeCron", () => {
  it("puts common expressions in words and leaves the rest as written", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30");
    expect(describeCron("0 8 * * *")).toBe("Every day at 08:00");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 08:00");
    expect(describeCron("5 4 1,15 * *")).toBe("5 4 1,15 * *");
  });
});

describe("wake-up timers", () => {
  it("wake the agent once, with the note and the people who steered the call", async () => {
    const t = await scheduleThread();
    await t.start();
    const set = await t.set(["schedules.wake_at", { in_seconds: 600, note: "Check the build" }]);
    expect(set.texts.at(-1)).toContain('"id"');
    await t.worker.idle();

    // Nothing happens before its time.
    expect(await t.schedules.tick()).toBe(0);
    t.clock.now = new Date(t.clock.now.getTime() + 11 * MINUTE);
    expect(await t.schedules.tick()).toBe(1);
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toContain("Wake-up timer went off");
    expect(told.texts.at(-1)).toContain("Check the build");
    await t.worker.idle();

    // It was the notice that carried the people.
    const notice = (await t.rowsOf()).find((row) => row.kind === "notice");
    expect(notice).toMatchObject({ type: "schedule.fired" });
    expect(notice?.kind === "notice" && notice.influence.map((one) => one.name)).toEqual([
      "Ada Lovelace",
    ]);

    // It does not go off again, and is gone from the list.
    t.clock.now = new Date(t.clock.now.getTime() + 60 * MINUTE);
    expect(await t.schedules.tick()).toBe(0);
    await t.post(t.ada, "What is set?");
    await t.calls(t.thread.id, ["schedules.list", {}]);
    const listed = await t.answer(t.thread.id);
    expect(listed.texts.at(-1)).toContain('"schedules":[]');
  });

  it("refuse a time that is unclear or has passed", async () => {
    const t = await scheduleThread();
    await t.start();
    await t.post(t.ada, "Set it up");
    await t.calls(
      t.thread.id,
      ["schedules.wake_at", { note: "x" }],
      ["schedules.wake_at", { in_seconds: 5, at: "2099-01-01T00:00:00Z", note: "x" }],
      ["schedules.wake_at", { at: "2001-01-01T00:00:00Z", note: "x" }],
      ["schedules.wake_at", { at: "soon", note: "x" }],
    );
    const refused = (await t.answer(t.thread.id)).texts.join("\n");
    expect(refused).toContain("Give in_seconds or at");
    expect(refused).toContain("That time has passed.");
    expect(refused).toContain("is not a time");
  });
});

describe("schedules", () => {
  it("fire on their cron in their zone, and once for what was missed while down", async () => {
    const t = await scheduleThread();
    await t.start();
    t.clock.now = new Date("2030-01-07T08:59:00Z");
    await t.set([
      "schedules.add",
      {
        name: "Digest",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Write the digest",
      },
    ]);
    await t.worker.idle();
    t.clock.now = new Date("2030-01-07T09:00:30Z");
    expect(await t.schedules.tick()).toBe(1);
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toContain('Schedule "Digest" fired');
    expect(told.texts.at(-1)).toContain("Write the digest");
    await t.worker.idle();
    expect((await t.rowsOf()).find((row) => row.kind === "notice")).toMatchObject({
      schedule: "Every day at 09:00",
    });

    // Days pass with the server down: it fires once, then waits for the next 09:00.
    t.clock.now = new Date("2030-01-10T12:00:00Z");
    expect(await t.schedules.tick()).toBe(1);
    expect(await t.schedules.tick()).toBe(0);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [record] = (
      await t.db.execute<{ next_run_at: number }>("select next_run_at from schedule" as never)
    ).rows;
    expect(new Date(record!.next_run_at).toISOString()).toBe("2030-01-11T09:00:00.000Z");
  });

  it("are listed and deleted by the agent, and refuse a bad cron or zone", async () => {
    const t = await scheduleThread();
    await t.start();
    const bad = await t.set(
      ["schedules.add", { name: "A", cron: "* * *", prompt: "x" }],
      ["schedules.add", { name: "B", cron: "0 9 * * *", timezone: "Mars/Base", prompt: "x" }],
      ["schedules.add", { name: "C", cron: "99 9 * * *", prompt: "x" }],
    );
    const refused = bad.texts.join("\n");
    expect(refused).toContain("needs five fields");
    expect(refused).toContain("not a time zone");
    expect(refused).toContain("not valid");
    await t.worker.idle();

    await t.post(t.ada, "Again");
    await t.calls(t.thread.id, [
      "schedules.add",
      { name: "Daily", cron: "0 9 * * *", prompt: "Go" },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [made] = await t.schedules.inThread(t.thread.id);
    expect(made).toMatchObject({
      name: "Daily",
      timezone: "UTC",
      status: "active",
    });

    await t.post(t.ada, "Remove it");
    await t.calls(t.thread.id, ["schedules.list", {}], ["schedules.delete", { id: made!.id }]);
    const after = await t.answer(t.thread.id);
    expect(after.texts.join("\n")).toContain('"name":"Daily"');
    expect(after.texts.join("\n")).toContain(`"deleted":"${made!.id}"`);
    expect(await t.schedules.inThread(t.thread.id)).toEqual([]);
  });
});

describe("with several server instances", () => {
  async function due() {
    const t = await scheduleThread();
    await t.start();
    await t.set(["schedules.wake_at", { in_seconds: 60, note: "Once only" }]);
    await t.worker.idle();
    t.clock.now = new Date(t.clock.now.getTime() + 2 * MINUTE);
    return t;
  }

  it("fire a due schedule once, whichever instance looks first", async () => {
    const t = await due();
    const other = t.schedulesFor();
    expect((await t.schedules.tick()) + (await other.tick())).toBe(1);
    expect((await other.tick()) + (await t.schedules.tick())).toBe(0);
    await t.answer(t.thread.id);
    expect((await t.rowsOf()).filter((row) => row.kind === "notice")).toHaveLength(1);
  });

  it("move a due one on once: a move on the row as it was read before loses", async () => {
    const t = await due();
    const [seen] = await t.schedules.inThread(t.thread.id);
    expect(await t.scheduleStore.finish(seen!, t.clock.now)).not.toBeNull();
    expect(await t.scheduleStore.finish(seen!, t.clock.now)).toBeNull();
  });
});

describe("the card and its controls", () => {
  it("show a schedule's state, and people who may post pause, resume and delete it", async () => {
    const t = await scheduleThread();
    await t.start();
    t.clock.now = new Date("2030-01-07T08:00:00Z");
    await t.set([
      "schedules.add",
      {
        name: "Digest",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
        prompt: "Write it",
      },
    ]);
    await t.worker.idle();
    const [made] = await t.schedules.inThread(t.thread.id);
    const path = (action: string) => `/threads/${t.thread.id}/schedules/${made!.id}${action}`;

    const card = async (canChange = true) => {
      const reader = await t.access.require(canChange ? t.ada : t.alan, t.thread.id);
      const row = { id: made!.callId! } as ToolRow;
      return (await t.schedules.present(reader, [row]))(row)!.work!;
    };
    expect(await card()).toMatchObject({
      kind: "schedule",
      status: "scheduled",
      schedule: {
        name: "Digest",
        words: "Weekdays at 09:00",
        nextRunAt: "2030-01-07T09:00:00.000Z",
        canChange: true,
      },
    });
    expect((await card(false)).schedule?.canChange).toBe(false);

    // A reader may not.
    expect((await t.api("POST", path("/pause"), t.alan.cookie)).status).toBeGreaterThanOrEqual(400);

    expect((await t.api("POST", path("/pause"), t.grace.cookie)).status).toBe(200);
    expect((await card()).status).toBe("paused");
    // Nothing fires while it is paused; resuming works the next time out from now.
    t.clock.now = new Date("2030-01-07T10:00:00Z");
    expect(await t.schedules.tick()).toBe(0);
    expect((await t.api("POST", path("/resume"), t.ada.cookie)).status).toBe(200);
    expect((await card()).schedule?.nextRunAt).toBe("2030-01-08T09:00:00.000Z");

    expect((await t.api("DELETE", path(""), t.ada.cookie)).status).toBe(200);
    expect((await card()).status).toBe("cancelled");
    t.clock.now = new Date("2030-01-09T10:00:00Z");
    expect(await t.schedules.tick()).toBe(0);
    expect((await t.api("POST", path("/pause"), t.ada.cookie)).status).toBe(404);
  });

  it("tell the agent, without waking it, what a person did to them, and who", async () => {
    const t = await scheduleThread();
    await t.start();
    await t.set([
      "schedules.add",
      { name: "Digest", cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Go" },
    ]);
    await t.worker.idle();
    const [schedule] = await t.schedules.inThread(t.thread.id);
    const base = `/threads/${t.thread.id}/schedules/${schedule!.id}`;
    const calls = t.model.calls.length;
    await t.api("POST", `${base}/pause`, t.grace.cookie);
    await t.api("POST", `${base}/resume`, t.grace.cookie);
    await t.api("DELETE", base, t.grace.cookie);
    await t.worker.idle();
    expect(t.model.calls.length).toBe(calls);
    const told = (await t.rowsOf()).flatMap((row) => (row.kind === "notice" ? [row] : []));
    expect(told.map((row) => [row.type, row.text, row.tray])).toEqual([
      ["change", "Grace Hopper paused schedule Digest", "schedules"],
      ["change", "Grace Hopper resumed schedule Digest", "schedules"],
      ["change", "Grace Hopper deleted schedule Digest", "schedules"],
    ]);
    expect(told.map((row) => row.change)).toEqual([
      { subject: { kind: "schedule", name: "Digest" }, action: "pause" },
      { subject: { kind: "schedule", name: "Digest" }, action: "resume" },
      { subject: { kind: "schedule", name: "Digest" }, action: "delete" },
    ]);
    await t.post(t.ada, "Go on");
    const next = await t.answer(t.thread.id);
    expect(next.texts.at(-1)).toBe(
      `user: ${NOTICES_HEADING}\n\n${told.map((row) => row.text).join("\n\n")}`,
    );
  });

  it("shows on the tool call's row in the thread", async () => {
    const t = await scheduleThread();
    await t.start();
    await t.set(["schedules.wake_at", { in_seconds: 600, note: "Look again" }]);
    await t.worker.idle();
    const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
    const { rows } = (await res.json()) as {
      rows: {
        kind: string;
        toolId?: string;
        work?: { kind: string; status: string };
      }[];
    };
    const call = rows.find((row) => row.toolId === "schedules.wake_at");
    expect(call?.work).toMatchObject({
      kind: "schedule",
      status: "scheduled",
    });
  });
});

describe("each change of where one stands", () => {
  // A timer due now, set by no call.
  async function dueTimer(t: Awaited<ReturnType<typeof scheduleThread>>, id = "timer-1") {
    return t.scheduleStore.create({
      id,
      threadId: t.thread.id,
      callId: null,
      kind: "once",
      name: "Wake-up",
      cron: null,
      timezone: null,
      prompt: "Look again",
      influence: [],
      nextRunAt: new Date(t.clock.now.getTime() - 1000),
    });
  }

  it("is one guarded statement: what has moved already moves no more", async () => {
    const t = await scheduleThread();
    const timer = await dueTimer(t);
    expect(await t.scheduleStore.pause(timer.id)).toMatchObject({ status: "paused" });
    expect(await t.scheduleStore.pause(timer.id)).toBeNull();
    expect(await t.scheduleStore.resume(timer.id, null)).toMatchObject({
      status: "active",
      nextRunAt: timer.nextRunAt,
    });
    const later = new Date(t.clock.now.getTime() + MINUTE);
    expect(await t.scheduleStore.finish({ ...timer, nextRunAt: later }, t.clock.now)).toBeNull();
    expect(await t.scheduleStore.finish(timer, t.clock.now)).toMatchObject({ status: "completed" });
    expect(await t.scheduleStore.remove(timer.id)).toBeNull();
    const other = await dueTimer(t, "timer-2");
    expect(await t.schedules.removeFor(t.thread.id, other.id)).toBe(true);
    expect(await t.schedules.removeFor(t.thread.id, other.id)).toBe(false);
  });

  it("is told once when two people pause it at once", async () => {
    const t = await scheduleThread();
    const timer = await dueTimer(t);
    const pause = (who: { cookie: string }) =>
      t.api("POST", `/threads/${t.thread.id}/schedules/${timer.id}/pause`, who.cookie);
    const codes = (await Promise.all([pause(t.ada), pause(t.grace)])).map((res) => res.status);
    expect(codes).toEqual([200, 200]);
    const changes = (await t.rowsOf()).filter((row) => row.kind === "notice");
    expect(changes).toHaveLength(1);
  });

  it("leaves a row whose firing fails due, and fires the rest", async () => {
    const t = await scheduleThread();
    await t.db.execute(sql`set session_replication_role = replica`);
    await t.db.execute(sql`insert into schedule (id, thread_id, kind, name, prompt, influence,
                                                  status, next_run_at)
                           values ('broken', 'no-thread', 'once', 'Wake-up', 'x', '[]', 'active',
                                   ${new Date(t.clock.now.getTime() - 2000)})`);
    await t.db.execute(sql`set session_replication_role = default`);
    await dueTimer(t);
    expect(await t.schedules.tick()).toBe(1);
    const [broken] = (
      await t.db.execute<{ status: string }>(sql`select status from schedule where id = 'broken'`)
    ).rows;
    expect(broken?.status).toBe("active");
    await t.db.execute(sql`delete from schedule where id = 'broken'`);
    await t.start();
    await t.answer(t.thread.id);
    await t.worker.idle();
  });

  it("finishes a schedule with no next time", async () => {
    const t = await scheduleThread();
    await t.scheduleStore.create({
      id: "past",
      threadId: t.thread.id,
      callId: null,
      kind: "cron",
      name: "Once in 2020",
      cron: "0 9 1 1 *",
      timezone: "UTC",
      prompt: "Go",
      influence: [],
      nextRunAt: new Date(t.clock.now.getTime() - 1000),
    });
    // A cron that does go off again moves on; this one is made to have no next time.
    await t.db.execute(sql`update schedule set cron = '0 0 30 2 *' where id = 'past'`);
    expect(await t.schedules.tick()).toBe(1);
    expect((await t.scheduleStore.find("past"))?.status).toBe("completed");
    await t.start();
    await t.answer(t.thread.id);
    await t.worker.idle();
  });

  it("answers a deleted one's history as not found", async () => {
    const t = await scheduleThread();
    const timer = await dueTimer(t);
    expect(
      (await t.api("DELETE", `/threads/${t.thread.id}/schedules/${timer.id}`, t.ada.cookie)).status,
    ).toBe(200);
    expect(
      (await t.api("GET", `/threads/${t.thread.id}/schedules/${timer.id}/history`, t.ada.cookie))
        .status,
    ).toBe(404);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("on Postgres, against a firing", () => {
  for (const action of ["pause", "delete"] as const) {
    it(`a ${action} either comes before the timer goes off or after, never both`, async () => {
      const t = await scheduleThread();
      const other = setup({}, { database: t.database });
      await t.scheduleStore.create({
        id: "timer-1",
        threadId: t.thread.id,
        callId: null,
        kind: "once",
        name: "Wake-up",
        cron: null,
        timezone: null,
        prompt: "Look again",
        influence: [],
        nextRunAt: new Date(Date.now() - 1000),
      });
      other.clock.now = new Date();
      const path = `/threads/${t.thread.id}/schedules/timer-1${action === "pause" ? "/pause" : ""}`;
      const [fired, res] = await Promise.all([
        other.schedules.tick(),
        t.api(action === "pause" ? "POST" : "DELETE", path, t.ada.cookie),
      ]);
      const row = (await t.scheduleStore.find("timer-1"))!;
      if (fired === 1) {
        expect(row.status).toBe("completed");
        expect(res.status).toBe(409);
      } else {
        expect(row.status).toBe(action === "pause" ? "paused" : "deleted");
        expect(res.status).toBe(200);
      }
      if (fired === 1) {
        await t.start();
        await t.answer(t.thread.id);
        await t.worker.idle();
      }
    });
  }
});

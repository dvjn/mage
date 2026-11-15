// Schedules and wake-up timers as their clients meet them: the agent sets them, they tell it when
// their time comes, and people pause, resume and delete them. Everything is arranged and read
// through the API and through what the model is sent; time moves when the test says.

import { describe, it } from "vite-plus/test";

import { expect, MINUTE, type World, world } from "@/server/testing/contract.ts";

const HOUR = 60 * MINUTE;

// The thread's schedules and timers as the reader's tray shows them.
async function scheduled(w: World, who = w.ada) {
  return (await w.activity(who)).flatMap((item) =>
    item.work.schedule
      ? [
          {
            title: item.title,
            status: item.work.status,
            kind: item.work.schedule.kind,
            fired: item.work.schedule.fired,
            canChange: item.work.schedule.canChange,
          },
        ]
      : [],
  );
}

describe("a wake-up timer", () => {
  it("wakes the agent once when its time comes, and is then done", async () => {
    const w = await world();
    const timer = await w.wakeUp(600, "Check the build");
    expect(timer.id).toBeTruthy();
    expect(await scheduled(w)).toEqual([
      { title: "Check the build", status: "scheduled", kind: "once", fired: 0, canChange: true },
    ]);
    expect(await w.later(5 * MINUTE)).toBe(0);
    expect(await w.later(6 * MINUTE)).toBe(1);
    const told = await w.answers(w.threadId, "Checked.");
    expect(told.texts.at(-1)).toContain("Wake-up timer went off");
    expect(told.texts.at(-1)).toContain("Check the build");
    await w.settled();
    expect((await w.shown()).rows.slice(-2)).toEqual([
      expect.stringMatching(/^schedule\.fired: /),
      "agent (completed): Checked.",
    ]);
    expect(await w.later(HOUR)).toBe(0);
  });
});

describe("a schedule", () => {
  it("tells the agent each time it comes due, with its prompt", async () => {
    const w = await world();
    const schedule = await w.schedule("Digest", "0 * * * *", "Write the digest");
    expect(await scheduled(w)).toEqual([
      { title: "Digest", status: "scheduled", kind: "cron", fired: 0, canChange: true },
    ]);
    expect((await scheduled(w, w.alan))[0]).toMatchObject({ canChange: false });

    expect(await w.later(HOUR)).toBe(1);
    const first = await w.answers(w.threadId, "Written.");
    expect(first.texts.at(-1)).toContain("Write the digest");
    await w.settled();
    expect(await w.later(HOUR)).toBe(1);
    await w.answers(w.threadId, "Written again.");
    await w.settled();

    expect(await scheduled(w)).toMatchObject([{ title: "Digest", status: "scheduled", fired: 2 }]);
    const history = await w.history(w.ada, "schedules", schedule.id);
    expect(history).toMatchObject({ total: 2, offset: 0 });
    expect(history.entries).toHaveLength(2);
  });

  it("fires once for all the times it missed", async () => {
    const w = await world();
    await w.schedule("Digest", "0 * * * *", "Write the digest");
    expect(await w.later(5 * HOUR)).toBe(1);
    await w.answers(w.threadId, "Written.");
    await w.settled();
    expect(await w.later(0)).toBe(0);
    expect(await scheduled(w)).toMatchObject([{ fired: 1 }]);
  });

  it("is paused, resumed and deleted by those who may post, and the agent reads of it quietly", async () => {
    const w = await world();
    const { id } = await w.schedule("Digest", "0 * * * *", "Write the digest");
    const calls = w.modelCalls();

    expect(await w.act(w.alan, "POST", `/schedules/${id}/pause`)).toBe(403);
    expect(await w.act(w.grace, "POST", `/schedules/${id}/pause`)).toBe(200);
    expect(await scheduled(w)).toMatchObject([{ status: "paused" }]);
    expect(await w.later(3 * HOUR)).toBe(0);
    // Pausing what is paused, and resuming what runs, change nothing.
    expect(await w.act(w.grace, "POST", `/schedules/${id}/pause`)).toBe(200);

    expect(await w.act(w.grace, "POST", `/schedules/${id}/resume`)).toBe(200);
    expect(await w.act(w.grace, "POST", `/schedules/${id}/resume`)).toBe(200);
    expect(await scheduled(w)).toMatchObject([{ status: "scheduled" }]);
    // Its next time is counted from when it was resumed, with nothing owed for the pause.
    expect(await w.later(0)).toBe(0);
    expect(await w.later(HOUR)).toBe(1);
    await w.answers(w.threadId, "Written.");
    await w.settled();

    expect(await w.act(w.ada, "DELETE", `/schedules/${id}`)).toBe(200);
    expect(await scheduled(w)).toEqual([]);
    expect(await w.later(3 * HOUR)).toBe(0);
    expect(await w.act(w.ada, "DELETE", `/schedules/${id}`)).toBe(404);

    // None of that started the agent; it reads of each with what next does.
    expect(w.modelCalls()).toBe(calls + 1);
    expect((await w.shown()).rows.filter((row) => row.startsWith("change: "))).toHaveLength(3);
  });
});

describe("a timer or schedule over its life", () => {
  // SC1
  it("fires at the next tick when a paused timer is resumed after its time has passed", async () => {
    const w = await world();
    const timer = await w.wakeUp(600, "Check the build");
    expect(await w.act(w.ada, "POST", `/schedules/${timer.id}/pause`)).toBe(200);
    expect(await w.later(20 * MINUTE)).toBe(0);
    expect(await w.act(w.ada, "POST", `/schedules/${timer.id}/resume`)).toBe(200);
    expect(await w.later(0)).toBe(1);
    await w.answers(w.threadId, "Checked.");
    await w.settled();
    expect(await w.later(HOUR)).toBe(0);
  });

  // SC2
  it("refuses to pause, resume or delete a timer that has gone off, and finds no deleted one", async () => {
    const w = await world();
    const timer = await w.wakeUp(60, "Check the build");
    expect(await w.later(2 * MINUTE)).toBe(1);
    await w.answers(w.threadId, "Checked.");
    await w.settled();
    for (const [method, path] of [
      ["POST", "/pause"],
      ["POST", "/resume"],
      ["DELETE", ""],
    ] as const) {
      const res = await w.api(
        method,
        `/threads/${w.threadId}/schedules/${timer.id}${path}`,
        w.ada.cookie,
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "This timer has gone off" });
    }
    const other = await w.wakeUp(600, "Later");
    expect(await w.act(w.ada, "DELETE", `/schedules/${other.id}`)).toBe(200);
    expect(await w.act(w.ada, "DELETE", `/schedules/${other.id}`)).toBe(404);
  });

  // SC3
  it("lists what it fired a page at a time, newest first", async () => {
    const w = await world();
    const schedule = await w.schedule("Digest", "0 * * * *", "Write the digest");
    for (let fired = 0; fired < 12; fired += 1) {
      expect(await w.later(HOUR)).toBe(1);
      await w.answers(w.threadId, "Written.");
      await w.settled();
    }
    const page = async (offset: number) =>
      w.json<{ total: number; offset: number; entries: { id: string; at: string }[] }>(
        await w.api(
          "GET",
          `/threads/${w.threadId}/schedules/${schedule.id}/history?offset=${offset}`,
          w.ada.cookie,
        ),
      );
    const first = await page(0);
    const second = await page(10);
    expect(first).toMatchObject({ total: 12, offset: 0 });
    expect(first.entries).toHaveLength(10);
    expect(second).toMatchObject({ total: 12, offset: 10 });
    expect(second.entries).toHaveLength(2);
    const ats = [...first.entries, ...second.entries].map((entry) => entry.at);
    expect(ats).toEqual(ats.toSorted().toReversed());
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(12);
  });

  // SC4
  it("keeps what it fired when its thread is forked", async () => {
    const w = await world();
    const schedule = await w.schedule("Digest", "0 * * * *", "Write the digest");
    expect(await w.later(HOUR)).toBe(1);
    await w.answers(w.threadId, "Written.");
    await w.settled();
    const before = await w.history(w.ada, "schedules", schedule.id);
    const last = (await w.detail()).rows.at(-1)!;
    const forked = await w.json<{ id: string }>(
      await w.api("POST", `/threads/${w.threadId}/fork`, w.ada.cookie, { rowId: last.id }),
    );
    expect(forked.id).not.toBe(w.threadId);
    await w.settled();
    expect(await w.history(w.ada, "schedules", schedule.id)).toEqual(before);
    expect(await scheduled(w)).toMatchObject([{ fired: 1 }]);
  });

  // SC5
  it("is refused past the thread's limit, counting every kind, and by a name a webhook has", async () => {
    const w = await world();
    await w.post(w.ada, "Set twenty");
    await w.asks(
      w.threadId,
      ...Array.from({ length: 20 }, (_, index): [string, unknown] => [
        "schedules.wake_at",
        { in_seconds: 600 + index, note: `Timer ${index}` },
      ]),
    );
    await w.answers(w.threadId, "Set.");
    await w.settled();
    await w.post(w.ada, "One more");
    await w.asks(w.threadId, ["schedules.add", { name: "More", cron: "0 * * * *", prompt: "x" }]);
    const told = await w.answers(w.threadId, "Refused.");
    expect(told.texts.at(-1)).toBe(
      'result schedules.add: {"ok":false,"error":"This thread has 20 schedules and webhooks. Delete some with schedules.delete or webhooks.delete first."}',
    );
    await w.settled();
  });

  it("is refused by a name a live webhook has, whatever the case", async () => {
    const w = await world();
    await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Schedule it");
    await w.asks(w.threadId, [
      "schedules.add",
      { name: "deploys", cron: "0 * * * *", prompt: "x" },
    ]);
    const told = await w.answers(w.threadId, "Refused.");
    expect(told.texts.at(-1)).toBe(
      'result schedules.add: {"ok":false,"error":"A webhook named Deploys already exists here; pick another name."}',
    );
    await w.settled();
  });
});

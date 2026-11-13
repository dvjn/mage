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
      expect.stringMatching(/^trigger\.fired: /),
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
    const history = await w.history(w.ada, schedule.id);
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

    expect(await w.act(w.alan, "POST", `/triggers/${id}/pause`)).toBe(403);
    expect(await w.act(w.grace, "POST", `/triggers/${id}/pause`)).toBe(200);
    expect(await scheduled(w)).toMatchObject([{ status: "paused" }]);
    expect(await w.later(3 * HOUR)).toBe(0);
    // Pausing what is paused, and resuming what runs, change nothing.
    expect(await w.act(w.grace, "POST", `/triggers/${id}/pause`)).toBe(200);

    expect(await w.act(w.grace, "POST", `/triggers/${id}/resume`)).toBe(200);
    expect(await w.act(w.grace, "POST", `/triggers/${id}/resume`)).toBe(200);
    expect(await scheduled(w)).toMatchObject([{ status: "scheduled" }]);
    // Its next time is counted from when it was resumed, with nothing owed for the pause.
    expect(await w.later(0)).toBe(0);
    expect(await w.later(HOUR)).toBe(1);
    await w.answers(w.threadId, "Written.");
    await w.settled();

    expect(await w.act(w.ada, "DELETE", `/triggers/${id}`)).toBe(200);
    expect(await scheduled(w)).toEqual([]);
    expect(await w.later(3 * HOUR)).toBe(0);
    expect(await w.act(w.ada, "DELETE", `/triggers/${id}`)).toBe(404);

    // None of that started the agent; it reads of each with what next does.
    expect(w.modelCalls()).toBe(calls + 1);
    expect((await w.shown()).rows.filter((row) => row.startsWith("change: "))).toHaveLength(3);
  });
});

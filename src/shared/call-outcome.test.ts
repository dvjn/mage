import { describe, expect, it } from "vite-plus/test";

import { type CallOutcome, missesOf, outcomeOf, standingOf } from "@/shared/call-outcome.ts";

const many = (count: number, outcome: CallOutcome) => Array<CallOutcome>(count).fill(outcome);

describe("what became of a call", () => {
  it("reads a call by its state, denied and stale alike", () => {
    expect(outcomeOf({ state: "denied" })).toBe("denied");
    expect(outcomeOf({ state: "stale" })).toBe("denied");
    expect(outcomeOf({ state: "cancelled" })).toBe("stopped");
    expect(outcomeOf({ state: "skipped" })).toBe("skipped");
  });

  it("reads a job by where its job stands, a restart cutting it off as failed", () => {
    const job = (status: "completed" | "interrupted" | "queued") => ({
      state: "completed" as const,
      work: { kind: "job" as const, status, startedAt: null, canCancel: false },
    });
    expect(outcomeOf(job("completed"))).toBe("done");
    expect(outcomeOf(job("interrupted"))).toBe("failed");
    expect(outcomeOf(job("queued"))).toBe("running");
  });

  it("counts what did not run in one order", () => {
    expect(missesOf(["skipped", "done", "failed", "denied", "denied", "stopped"])).toEqual([
      "1 failed",
      "2 denied",
      "1 stopped",
      "1 skipped",
    ]);
  });
});

describe("a row that holds calls", () => {
  it("shows done when one of fifty failed", () => {
    expect(standingOf([...many(49, "done"), "failed"])).toBe("done");
  });

  it("shows failed only when every call ended badly", () => {
    expect(standingOf(["failed", "denied", "stopped"])).toBe("failed");
  });

  it("shows skipped when every call was skipped or ended badly, and some were skipped", () => {
    expect(standingOf(["skipped", "denied"])).toBe("skipped");
    expect(standingOf(["skipped", "done"])).toBe("done");
  });

  it("shows running while a call in it or under it runs", () => {
    expect(standingOf(["failed"], ["running"])).toBe("running");
  });

  it("shows waiting before running while a call under it waits", () => {
    expect(standingOf(["running"], ["waiting"])).toBe("waiting");
  });

  it("follows a script's own result where it caught a failed call and returned", () => {
    expect(standingOf(["done"], ["failed"])).toBe("done");
  });
});

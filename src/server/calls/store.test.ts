// Which moves the call machine allows from each state.

import { describe, expect, it } from "vite-plus/test";

import { callMachine } from "./schema.ts";

const EVENTS = [
  "allow",
  "deny",
  "skip",
  "start",
  "goStale",
  "complete",
  "fail",
  "interrupt",
  "cancel",
] as const;

describe("a call's machine", () => {
  it("moves each state only by the events that leave it", () => {
    const allowed = Object.fromEntries(
      callMachine.states.map((state) => [
        state,
        EVENTS.filter((event) => callMachine.allows(event, state)),
      ]),
    );
    expect(allowed).toEqual({
      ready: ["start", "goStale", "cancel"],
      waiting: ["allow", "deny", "skip", "goStale", "complete", "cancel"],
      running: ["complete", "fail", "interrupt", "cancel"],
      completed: [],
      failed: [],
      denied: [],
      skipped: [],
      stale: [],
      interrupted: [],
      cancelled: [],
    });
  });

  it("moves to one state by each event", () => {
    expect(EVENTS.map((event) => callMachine.to(event).status)).toEqual([
      "ready",
      "denied",
      "skipped",
      "running",
      "stale",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
    ]);
  });
});

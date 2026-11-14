import { describe, expect, it } from "vite-plus/test";

import { webhookMachine } from "@/server/webhooks/schema.ts";

import { scheduleMachine } from "./schema.ts";

// Each event with the states it moves a row from.
function table<S extends string, E extends string>(
  machine: { states: readonly S[]; allows(event: E, state: S): boolean },
  events: readonly E[],
) {
  return events.flatMap((event) =>
    machine.states
      .filter((state) => machine.allows(event, state))
      .map((state) => `${event} ${state}`),
  );
}

describe("the machines of what wakes the agent later", () => {
  it("move a schedule only from the states each event leaves", () => {
    expect(
      table(scheduleMachine, ["pause", "resume", "fire", "finish", "remove"] as const),
    ).toEqual([
      "pause active",
      "resume paused",
      "fire active",
      "finish active",
      "remove active",
      "remove paused",
    ]);
  });

  it("move a webhook only from the states each event leaves", () => {
    expect(table(webhookMachine, ["pause", "resume", "remove"] as const)).toEqual([
      "pause active",
      "resume paused",
      "remove active",
      "remove paused",
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  type AnyThreadEvent,
  eventDataSchemas,
  threadEventSchema,
} from "@/shared/threads/events.ts";
import { createFold } from "@/shared/transcript.ts";

import { threadFixtures } from "./threads.ts";

// What the log reads as: its rows, each with its place in the agent's turn, and what waits.
function folded(events: readonly AnyThreadEvent[]) {
  const fold = createFold();
  for (const event of events) fold.add(event);
  const { rows, ...rest } = fold.transcript();
  return { rows: rows.map((row, index) => ({ ...row, turn: fold.turnAt(index) })), ...rest };
}

describe("thread fixtures", () => {
  for (const [name, events] of Object.entries(threadFixtures)) {
    it(`${name} folds into the rows kept for it`, async () => {
      await expect(`${JSON.stringify(folded(events), null, 2)}\n`).toMatchFileSnapshot(
        `./golden/${name}.json`,
      );
    });
  }

  it("hold every event type", () => {
    const held = new Set(
      Object.values(threadFixtures).flatMap((events) => events.map((e) => e.type)),
    );
    expect(Object.keys(eventDataSchemas).filter((type) => !held.has(type))).toEqual([]);
  });

  it("hold only events the schema reads, but for those made to be unreadable", () => {
    for (const [name, events] of Object.entries(threadFixtures)) {
      if (name === "unknown") continue;
      const unread = events.filter((event) => !threadEventSchema.safeParse(event).success);
      expect(unread.map((event) => `${name}: ${event.type} ${event.id}`)).toEqual([]);
    }
  });

  it("read the same folded one event at a time as all at once", () => {
    for (const events of Object.values(threadFixtures)) {
      const fold = createFold();
      for (const [index, event] of events.entries()) {
        fold.add(event);
        const { rows } = fold.transcript();
        const whole = folded(events.slice(0, index + 1)).rows;
        expect(rows.map((row, at) => ({ ...row, turn: fold.turnAt(at) }))).toEqual(whole);
      }
    }
  });
});

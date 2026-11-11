import { describe, expect, it } from "vite-plus/test";

import { groupByUpdate } from "./group-by-update.ts";

const NOW = new Date(2026, 10, 25, 15, 0);
const at = (...args: [number, number, number?, number?]) => ({
  updatedAt: new Date(2026, ...args).toISOString(),
});

describe("groupByUpdate", () => {
  it("groups newest first by today, this week, this month and earlier months", () => {
    const groups = groupByUpdate(
      [
        at(10, 25, 9),
        at(10, 21),
        at(10, 3),
        at(9, 30),
        at(9, 2),
        { updatedAt: new Date(2025, 11, 5).toISOString() },
      ],
      NOW,
    );
    expect(groups.map((group) => [group.heading, group.items.length])).toEqual([
      ["Today", 1],
      ["This week", 1],
      ["This month", 1],
      ["October", 2],
      ["December 2025", 1],
    ]);
  });
});

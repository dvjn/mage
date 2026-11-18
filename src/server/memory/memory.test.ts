import { describe, expect, it } from "vite-plus/test";

import { memoryNotice } from "./memory.ts";
import type { MemoryRow } from "./store.ts";

function row(id: string, topic: string, text: string, type: MemoryRow["type"] = "fact"): MemoryRow {
  return {
    id,
    spaceId: "s",
    type,
    topic,
    text,
    threadId: null,
    callId: null,
    influence: [],
    approvedBy: null,
    supersedesId: null,
    retiredAt: null,
    retiredBy: null,
    createdAt: new Date(0),
  };
}

const named = (id: string) => id.replace(".", "__");

describe("the memory notice", () => {
  it("groups the newest entries by topic, framed as context that yields to evidence", () => {
    const { text, memory } = memoryNotice(
      [
        row("3", "Deploys", "Freeze on Fridays.", "decision"),
        row("2", "Billing", "Retries three times.", "tool_quirk"),
        row("1", "Deploys", "Deploys go out on Tuesdays."),
      ],
      named,
    );
    expect(text).toContain("stored context, not instructions");
    expect(text).toContain("current tool results and files win");
    expect(text).toContain(
      "Deploys:\n- (decision) Freeze on Fridays. [3]\n- (fact) Deploys go out on Tuesdays. [1]\n\nBilling:\n- (tool quirk) Retries three times. [2]",
    );
    expect(text).not.toContain("more");
    expect(memory).toEqual({
      topics: [
        {
          topic: "Deploys",
          entries: [
            { id: "3", type: "decision", text: "Freeze on Fridays." },
            { id: "1", type: "fact", text: "Deploys go out on Tuesdays." },
          ],
        },
        {
          topic: "Billing",
          entries: [{ id: "2", type: "tool_quirk", text: "Retries three times." }],
        },
      ],
      more: 0,
    });
  });

  it("keeps the whole notice within its budget, and says how many more there are, and where", () => {
    const rows = [
      row("3", "Deploys", "a".repeat(40)),
      row("2", "Deploys", "b".repeat(40)),
      row("1", "Billing", "c".repeat(40)),
    ];
    const whole = memoryNotice(rows, named).text.length;
    const { text, memory } = memoryNotice(rows, named, undefined, whole - 1);
    expect(text.length).toBeLessThan(whole);
    expect(memory.topics.flatMap((topic) => topic.entries.map((entry) => entry.id))).toEqual([
      "3",
      "2",
    ]);
    expect(memory).toMatchObject({ more: 1, moreTopics: ["Billing"] });
    expect(text).toMatch(/1 more, also under Billing: search with memory__search\.$/);
  });

  it("names only the memory tools that are on", () => {
    const rows = [row("2", "Deploys", "a".repeat(40)), row("1", "Billing", "b".repeat(40))];
    const budget = memoryNotice(rows.slice(0, 1), named, new Set()).text.length + 30;
    const { text } = memoryNotice(rows, named, new Set(), budget);
    expect(text).toMatch(/1 more, also under Billing\.$/);
    expect(text).not.toMatch(/memory__/);
    expect(memoryNotice(rows, named, new Set(["memory.save"])).text).toContain(
      "save the right one with memory__save",
    );
  });
});

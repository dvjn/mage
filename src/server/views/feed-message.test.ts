import { describe, expect, it } from "vite-plus/test";

import { feedMessage } from "./routes.ts";

describe("feedMessage", () => {
  it("names each kind of item as its own event", () => {
    expect(feedMessage({ kind: "activity", list: { items: [] } })).toEqual({
      event: "activity",
      data: '{"items":[]}',
    });
    expect(
      feedMessage({
        kind: "tasks",
        list: { tasks: [], canEdit: true, subagents: [], assignees: [] },
      }).event,
    ).toBe("tasks");
  });

  it("refuses an item of an unknown kind without sending undefined data", () => {
    expect(() => feedMessage({ kind: "other" } as never)).toThrow("unhandled thread feed item");
  });
});

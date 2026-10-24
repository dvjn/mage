import { describe, expect, it } from "vite-plus/test";

import type { SharedThread } from "@/shared/guests.ts";
import type { ThreadListItem } from "@/shared/threads.ts";
import { withSeen, withSharedThread, without, withThread } from "@/web/lib/inbox.ts";

function item(
  id: string,
  updatedAt: string,
  changes: Partial<ThreadListItem> = {},
): ThreadListItem {
  return {
    id,
    spaceId: "s1",
    folderId: null,
    title: id,
    untitled: false,
    model: null,
    effort: null,
    lastEventSeq: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    shownModel: null,
    participants: { people: [], total: 0 },
    activity: {
      run: null,
      lastNotableSeq: 1,
      lastNotableBy: null,
      failed: null,
      lastSeenSeq: 0,
      canApprove: false,
    },
    ...changes,
  };
}

const older = item("a", "2026-10-02T00:00:00.000Z");
const newer = item("b", "2026-10-03T00:00:00.000Z");

describe("the inbox's changes to cached lists", () => {
  it("put a changed thread in its place by when it was last active", () => {
    const moved = { ...older, updatedAt: "2026-10-04T00:00:00.000Z", title: "Renamed" };
    expect(withThread([newer, older], moved).map((t) => [t.id, t.title])).toEqual([
      ["a", "Renamed"],
      ["b", "b"],
    ]);
    const added = item("c", "2026-10-05T00:00:00.000Z");
    expect(withThread([newer, older], added).map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("change a shared thread they have, keeping where it is, and ask for the list without it", () => {
    const shared: SharedThread = {
      ...older,
      spaceName: "Ada's Space",
      orgName: "Ada",
      place: "Ada's Space",
      accessUntil: null,
    };
    const changed = withSharedThread([shared], { ...older, title: "Renamed" });
    expect(changed?.[0]).toMatchObject({ title: "Renamed", place: "Ada's Space" });
    expect(withSharedThread([shared], newer)).toBeNull();
  });

  it("move how far a thread was seen only forward, and drop a thread that is gone", () => {
    const seen = withSeen([older], "a", 3);
    expect(seen[0]?.activity.lastSeenSeq).toBe(3);
    expect(withSeen(seen, "a", 2)[0]?.activity.lastSeenSeq).toBe(3);
    expect(without([older, newer], "a").map((t) => t.id)).toEqual(["b"]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";
import {
  withChangedRows,
  withEarlier,
  withFreshRead,
  withUpdate,
} from "@/web/threads/thread-rows.ts";

function row(order: number, seq = order + 1, text = `Note ${order}`): ShownRow {
  return {
    kind: "human",
    id: `r${order}`,
    order,
    seq,
    turn: null,
    author: { kind: "user", userId: "ada", name: "Ada Lovelace" },
    postedAt: "2026-11-01T00:00:00.000Z",
    text,
    quiet: true,
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(from + i));

function detail(rows: ShownRow[], before: number | null, lastEventSeq = 0): ThreadDetail {
  return {
    thread: {
      id: "t1",
      spaceId: "s1",
      title: "Notes",
      untitled: false,
      model: null,
      effort: null,
      lastEventSeq: lastEventSeq || (rows.at(-1)?.seq ?? 0),
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    access: { via: "space", role: "owner" },
    archived: false,
    agentName: "Agent",
    can: { post: true, arrange: true, share: true, move: true, delete: true },
    levels: {},
    tools: [],
    defaults: { model: null, effort: null },
    model: null,
    rows,
    before,
    newFrom: null,
    pending: [],
    run: null,
  };
}

const orders = (rows: ShownRow[]) => rows.map((each) => each.order);

describe("withChangedRows", () => {
  it("replaces rows by id, adds newer ones in order, and leaves out those before the first", () => {
    const rows = range(10, 13);
    const merged = withChangedRows(rows, [row(14), row(11, 20, "Changed"), row(13), row(2)]);

    expect(orders(merged)).toEqual([10, 11, 12, 13, 14]);
    expect(merged[1]).toMatchObject({ text: "Changed", seq: 20 });
  });

  it("keeps a newer row, and lets the reader's parts of a row change without its seq", () => {
    const rows = [row(1, 9, "Newer")];

    expect(withChangedRows(rows, [row(1, 5, "Older")])[0]).toMatchObject({ text: "Newer" });
    expect(withChangedRows(rows, [row(1, 9, "Same seq")])[0]).toMatchObject({ text: "Same seq" });
    expect(withChangedRows(rows, [row(1, 9, "Same seq")], false)[0]).toMatchObject({
      text: "Newer",
    });
  });
});

describe("withUpdate", () => {
  it("takes the rows, waiting messages and run the stream sent, and the newest seq", () => {
    const shown = detail(range(0, 3), null);
    const run = { id: "run", createdAt: "2026-11-01T00:00:00.000Z", waiting: null };

    const updated = withUpdate(shown, { seq: 7, rows: [row(3, 7)], pending: [], run });

    expect(orders(updated.rows)).toEqual([0, 1, 2, 3]);
    expect(updated.run).toEqual(run);
    expect(updated.thread.lastEventSeq).toBe(7);
  });
});

describe("withEarlier", () => {
  it("puts the earlier page before the rows here", () => {
    const shown = detail(range(100, 200), 100);

    const more = withEarlier(shown, { rows: range(0, 100), before: null });

    expect(orders(more.rows)).toEqual(range(0, 200).map((each) => each.order));
    expect(more.before).toBeNull();
  });
});

describe("withFreshRead", () => {
  it("keeps the earlier pages read and the live rows newer than the read", () => {
    const shown = detail([...range(50, 160), row(160, 170)], 50, 170);
    const fetched = detail(range(60, 160), 60);

    const merged = withFreshRead(fetched, shown);

    expect(orders(merged.rows)).toEqual(range(50, 161).map((each) => each.order));
    expect(merged.before).toBe(50);
    expect(merged.thread.lastEventSeq).toBe(170);
  });

  it("drops pages that no longer meet the newest rows", () => {
    const shown = detail(range(0, 100), null);
    const fetched = detail(range(300, 400), 300);

    const merged = withFreshRead(fetched, shown);

    expect(merged).toBe(fetched);
  });
});

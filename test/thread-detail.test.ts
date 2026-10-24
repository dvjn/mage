import { describe, expect, it } from "vite-plus/test";

import type { AnyThreadEvent, ThreadDetail } from "@/shared/threads.ts";
import { withEvents, withLiveEvents } from "@/web/lib/thread-detail.ts";

function event(seq: number): AnyThreadEvent {
  return {
    id: `e${seq}`,
    threadId: "t1",
    seq,
    actor: { kind: "agent" },
    createdAt: "2026-10-21T00:00:00.000Z",
    type: "message",
    data: { parts: [{ type: "text", text: `event ${seq}` }] },
  };
}

function detail(seqs: number[], title = "Engines"): ThreadDetail {
  return {
    thread: {
      id: "t1",
      spaceId: "s1",
      folderId: null,
      title,
      untitled: false,
      model: null,
      effort: null,
      lastEventSeq: seqs.at(-1) ?? 0,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    },
    events: seqs.map(event),
    access: { via: "space", role: "owner" },
    levels: {},
    defaults: { model: null, effort: null },
    model: null,
  };
}

const seqs = (d: ThreadDetail) => d.events.map((e) => e.seq);

describe("withEvents", () => {
  it("adds the events not known yet, in seq order, and moves the last seq", () => {
    const merged = withEvents(detail([1, 2, 3]), [event(5), event(3), event(4)]);
    expect(seqs(merged)).toEqual([1, 2, 3, 4, 5]);
    expect(merged.thread.lastEventSeq).toBe(5);
  });

  it("returns the same detail when every event is known", () => {
    const shown = detail([1, 2]);
    expect(withEvents(shown, [event(1), event(2)])).toBe(shown);
  });

  it("fills a gap between the cached events and the stream", () => {
    const merged = withEvents(detail([1, 4]), [event(2), event(3)]);
    expect(seqs(merged)).toEqual([1, 2, 3, 4]);
    expect(merged.thread.lastEventSeq).toBe(4);
  });
});

describe("withLiveEvents", () => {
  it("keeps the live events newer than the read and takes the server's thread", () => {
    const shown = withEvents(detail([1, 2], "Old title"), [event(3), event(4)]);
    const fetched = detail([1, 2, 3], "New title");
    const merged = withLiveEvents(fetched, shown);
    expect(seqs(merged)).toEqual([1, 2, 3, 4]);
    expect(merged.thread.title).toBe("New title");
    expect(merged.thread.lastEventSeq).toBe(4);
  });

  it("lets the server drop events the cache still had before its last", () => {
    const merged = withLiveEvents(detail([1, 3]), detail([1, 2, 3], "Gone"));
    expect(seqs(merged)).toEqual([1, 3]);
    expect(merged.thread.title).toBe("Engines");
  });

  it("returns the read itself when the cache has nothing newer", () => {
    const fetched = detail([1, 2, 3]);
    expect(withLiveEvents(fetched, detail([1, 2]))).toBe(fetched);
  });
});

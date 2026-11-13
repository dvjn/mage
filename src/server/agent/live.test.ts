import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createTransact, openDatabase } from "@/server/db/db.ts";
import type { LiveChunk, ThreadFeedItem } from "@/shared/threads/events.ts";

import { LIVE_CHARS, LIVE_FLUSH_MS, createLive } from "./live.ts";
import { createLiveStore } from "./live-store.ts";

function setup() {
  const db = openDatabase(":memory:");
  // Threads of their own for the calls to report in, of a space that is not there.
  db.$client.pragma("foreign_keys = OFF");
  db.$client.exec(
    "insert into thread (id, space_id, current_branch_id) values ('t', 's', 'b'), ('u', 's', 'b')",
  );
  db.$client.pragma("foreign_keys = ON");
  const sent: LiveChunk[] = [];
  const holding = { now: true };
  const live = createLive({
    store: createLiveStore(db),
    transact: createTransact(db),
    bus: {
      publish: (_threadId: string, item: ThreadFeedItem) => {
        if (item.kind === "live") sent.push(item.live);
      },
    },
  });
  const open = (threadId: string, callId: string) => live.open(threadId, callId, () => holding.now);
  return { db, live, sent, holding, open };
}

describe("live output", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("stores and passes on the first piece at once and gathers what follows", () => {
    const { live, sent, open } = setup();
    const call = open("t", "c");
    call.output("one\n");
    expect(sent).toEqual([{ callId: "c", offset: 0, text: "one\n", from: 0 }]);
    call.output("two\n");
    call.output("three\n");
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(sent[1]).toEqual({ callId: "c", offset: 4, text: "two\nthree\n", from: 0 });
    expect(live.of("c")).toEqual({ text: "one\ntwo\nthree\n" });
  });

  it("stores at most ten pieces a second for a call", () => {
    const { live, sent, open } = setup();
    const call = open("t", "c");
    for (let tick = 0; tick < 1000; tick += 5) {
      call.output("x");
      vi.advanceTimersByTime(5);
    }
    expect(sent.length).toBeLessThanOrEqual(11);
    expect(sent.map((chunk) => chunk.text).join("")).toHaveLength(200);
    expect(live.of("c")!.text).toHaveLength(200);
  });

  it("keeps the end of the output, dropping the pieces before it, and says where it starts", () => {
    const { db, live, sent, open } = setup();
    const call = open("t", "c");
    call.output("a".repeat(LIVE_CHARS / 2));
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("b".repeat(LIVE_CHARS / 2));
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("c".repeat(10));
    expect(sent.at(-1)).toMatchObject({ offset: LIVE_CHARS, from: 10 });
    const [tail] = live.inThread("t");
    expect(tail).toMatchObject({ callId: "c", offset: 10, from: 10 });
    expect(tail!.text).toHaveLength(LIVE_CHARS);
    expect(tail!.text.endsWith("c".repeat(10))).toBe(true);

    // The piece the cut falls in stays; those wholly before it go.
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("d".repeat(LIVE_CHARS / 2));
    const offsets = db.$client
      .prepare("select offset from call_output_chunk order by offset")
      .pluck()
      .all();
    expect(offsets).toEqual([LIVE_CHARS / 2, LIVE_CHARS, LIVE_CHARS + 10]);
    expect(live.inThread("t")[0]).toMatchObject({ from: LIVE_CHARS / 2 + 10 });
  });

  it("cuts one piece over the cap to its end", () => {
    const { live, sent, open } = setup();
    open("t", "c").output(`${"a".repeat(LIVE_CHARS)}end`);
    expect(sent[0]).toMatchObject({ offset: 3, from: 3 });
    expect(sent[0]!.text).toHaveLength(LIVE_CHARS);
    expect(live.inThread("t")[0]).toMatchObject({ offset: 3, from: 3 });
  });

  it("carries progress with the output, and alone when only it changed", () => {
    const { live, sent, open } = setup();
    const call = open("t", "c");
    call.progress({ progress: 1, total: 4, message: "Reading" });
    expect(sent[0]).toEqual({
      callId: "c",
      offset: 0,
      text: "",
      from: 0,
      progress: { progress: 1, total: 4, message: "Reading" },
    });
    call.progress({ progress: 2, total: 4 });
    call.progress({ progress: 3, total: 4 });
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.progress).toEqual({ progress: 3, total: 4 });
    expect(live.of("c")).toEqual({ text: "", progress: { progress: 3, total: 4 } });
  });

  it("drops a call's output as it ends, and takes nothing it reports after", () => {
    const { live, sent, open } = setup();
    const call = open("t", "c");
    call.output("one");
    call.output("two");
    live.end("c");
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("three");
    expect(sent).toHaveLength(1);
    expect(live.inThread("t")).toEqual([]);
    expect(live.of("c")).toBeNull();
  });

  it("stores nothing once the call is no longer this instance's", () => {
    const { live, sent, holding, open } = setup();
    const call = open("t", "c");
    call.output("one");
    holding.now = false;
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("two");
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    holding.now = true;
    call.output("three");
    expect(sent).toHaveLength(1);
    expect(live.of("c")).toEqual({ text: "one" });
  });

  it("keeps what a call printed when it goes on under another id", () => {
    const { live, sent, open } = setup();
    const call = open("t", "run-call");
    call.output("one\n");
    live.move("run-call", "job", () => true);
    live.moved("t", "job");
    expect(sent.at(-1)).toEqual({ callId: "job", offset: 0, text: "one\n", from: 0 });
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    call.output("two\n");
    expect(sent.at(-1)).toEqual({ callId: "job", offset: 4, text: "two\n", from: 0 });
    expect(live.of("run-call")).toBeNull();
    expect(live.of("job")).toEqual({ text: "one\ntwo\n" });
  });

  it("gives each thread its own calls", () => {
    const { live, open } = setup();
    open("t", "c").output("here");
    open("u", "d").output("there");
    expect(live.inThread("t").map((chunk) => chunk.callId)).toEqual(["c"]);
  });
});

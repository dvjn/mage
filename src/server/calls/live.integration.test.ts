import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { createSync } from "@/server/sync/sync.ts";
import { openTestDatabase } from "@/server/testing/database.ts";
import type { ThreadHint } from "@/server/sync/signals.ts";
import type { LiveChunk } from "@/shared/threads/events.ts";

import { LIVE_CHARS, LIVE_FLUSH_MS, createLive } from "./live.ts";
import { createLiveStore } from "./live-store.ts";

async function setup() {
  const sync = createSync({ db: openTestDatabase().db, logger: createLogger({ write() {} }) });
  const { db } = sync;
  // Threads of their own for the calls to report in, of a space that is not there: nothing
  // checks what they link to while they are written.
  await db.execute(sql`set session_replication_role = replica`);
  await db.execute(
    sql`insert into thread (id, space_id, current_branch_id) values ('t', 's', 'b'), ('u', 's', 'b')`,
  );
  await db.execute(sql`set session_replication_role = default`);
  // What a follower is sent: on each hint, what is kept of the call, past what it was sent before.
  // A hint is heard once the write that published it commits, as the real signals deliver it.
  const sent: LiveChunk[] = [];
  const told = new Map<string, number>();
  let reading: Promise<void> = Promise.resolve();
  const holding = { now: true };
  const made = createLive({
    store: createLiveStore(db),
    transact: sync.transact,
    afterCommit: sync.afterCommit,
    ordered: sync.ordered,
    signals: {
      publish: (_threadId: string, hint: ThreadHint) => {
        if (hint.kind !== "live") return;
        sync.afterCommit(() => {
          reading = reading.then(async () => {
            const chunk = await made.tail(hint.callId);
            if (!chunk) return;
            const known = Math.max(0, (told.get(chunk.callId) ?? 0) - chunk.offset);
            const text = chunk.text.slice(known);
            if (!text && !chunk.progress) return;
            told.set(
              chunk.callId,
              Math.max(told.get(chunk.callId) ?? 0, chunk.offset + chunk.text.length),
            );
            sent.push({ ...chunk, offset: chunk.offset + known, text });
          });
        });
      },
    },
  });
  const live = {
    ...made,
    async settled() {
      await made.settled();
      await reading;
    },
    async moved(threadId: string, callId: string) {
      await made.moved(threadId, callId);
      await reading;
    },
  };
  // The id each call is stored under while it is held here: its own, or the one it moved to.
  const ids = new Map<string, string>();
  const open = (threadId: string, callId: string) =>
    live.open(threadId, callId, async () => (holding.now ? (ids.get(callId) ?? callId) : null));
  return { db, live, sent, holding, open, ids };
}

// Moves the clock on, and waits for what the timers it set off store.
async function advance(live: { settled(): Promise<void> }, ms: number) {
  vi.advanceTimersByTime(ms);
  await live.settled();
}

describe("live output", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("stores and passes on the first piece at once and gathers what follows", async () => {
    const { live, sent, open } = await setup();
    const call = open("t", "c");
    call.output("one\n");
    await live.settled();
    expect(sent).toEqual([{ callId: "c", offset: 0, text: "one\n", from: 0 }]);
    call.output("two\n");
    call.output("three\n");
    expect(sent).toHaveLength(1);
    await advance(live, LIVE_FLUSH_MS);
    expect(sent[1]).toEqual({ callId: "c", offset: 4, text: "two\nthree\n", from: 0 });
    expect(await live.of("c")).toEqual({ text: "one\ntwo\nthree\n" });
  });

  it("stores at most ten pieces a second for a call", async () => {
    const { live, sent, open } = await setup();
    const call = open("t", "c");
    for (let tick = 0; tick < 1000; tick += 5) {
      call.output("x");
      await advance(live, 5);
    }
    expect(sent.length).toBeLessThanOrEqual(11);
    expect(sent.map((chunk) => chunk.text).join("")).toHaveLength(200);
    expect((await live.of("c"))!.text).toHaveLength(200);
  });

  it("keeps the end of the output, dropping the pieces before it, and says where it starts", async () => {
    const { db, live, sent, open } = await setup();
    const call = open("t", "c");
    call.output("a".repeat(LIVE_CHARS / 2));
    await advance(live, LIVE_FLUSH_MS);
    call.output("b".repeat(LIVE_CHARS / 2));
    await advance(live, LIVE_FLUSH_MS);
    call.output("c".repeat(10));
    await live.settled();
    // A follower may read two pieces stored close together at once: what it was sent ends at the
    // end of all that was printed, kept from where the cut falls.
    const last = sent.at(-1)!;
    expect(last.offset + last.text.length).toBe(LIVE_CHARS + 10);
    expect(last.from).toBe(10);
    expect(last.text.endsWith("c".repeat(10))).toBe(true);
    const [tail] = await live.inThread("t");
    expect(tail).toMatchObject({ callId: "c", offset: 10, from: 10 });
    expect(tail!.text).toHaveLength(LIVE_CHARS);
    expect(tail!.text.endsWith("c".repeat(10))).toBe(true);

    // The piece the cut falls in stays; those wholly before it go.
    await advance(live, LIVE_FLUSH_MS);
    call.output("d".repeat(LIVE_CHARS / 2));
    await live.settled();
    const { rows } = await db.execute<{ offset: number }>(
      sql`select "offset" from call_output_chunk order by "offset"`,
    );
    const offsets = rows.map((row) => row.offset);
    expect(offsets).toEqual([LIVE_CHARS / 2, LIVE_CHARS, LIVE_CHARS + 10]);
    expect((await live.inThread("t"))[0]).toMatchObject({ from: LIVE_CHARS / 2 + 10 });
  });

  it("cuts one piece over the cap to its end", async () => {
    const { live, sent, open } = await setup();
    open("t", "c").output(`${"a".repeat(LIVE_CHARS)}end`);
    await live.settled();
    expect(sent[0]).toMatchObject({ offset: 3, from: 3 });
    expect(sent[0]!.text).toHaveLength(LIVE_CHARS);
    expect((await live.inThread("t"))[0]).toMatchObject({ offset: 3, from: 3 });
  });

  it("carries progress with the output, and alone when only it changed", async () => {
    const { live, sent, open } = await setup();
    const call = open("t", "c");
    call.progress({ progress: 1, total: 4, message: "Reading" });
    await live.settled();
    expect(sent[0]).toEqual({
      callId: "c",
      offset: 0,
      text: "",
      from: 0,
      progress: { progress: 1, total: 4, message: "Reading" },
    });
    call.progress({ progress: 2, total: 4 });
    call.progress({ progress: 3, total: 4 });
    await advance(live, LIVE_FLUSH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.progress).toEqual({ progress: 3, total: 4 });
    expect(await live.of("c")).toEqual({ text: "", progress: { progress: 3, total: 4 } });
  });

  it("drops a call's output as it ends, and takes nothing it reports after", async () => {
    const { live, sent, open } = await setup();
    const call = open("t", "c");
    call.output("one");
    await live.settled();
    call.output("two");
    await live.end("c");
    await advance(live, LIVE_FLUSH_MS);
    call.output("three");
    expect(sent).toHaveLength(1);
    expect(await live.inThread("t")).toEqual([]);
    expect(await live.of("c")).toBeNull();
  });

  it("stores nothing once the call is no longer this instance's", async () => {
    const { live, sent, holding, open } = await setup();
    const call = open("t", "c");
    call.output("one");
    await live.settled();
    holding.now = false;
    await advance(live, LIVE_FLUSH_MS);
    call.output("two");
    await advance(live, LIVE_FLUSH_MS);
    holding.now = true;
    call.output("three");
    await live.settled();
    expect(sent).toHaveLength(1);
    expect(await live.of("c")).toEqual({ text: "one" });
  });

  it("keeps what a call printed when it goes on under another id", async () => {
    const { live, sent, open, ids } = await setup();
    const call = open("t", "run-call");
    call.output("one\n");
    await live.settled();
    await live.move("run-call", "job");
    ids.set("run-call", "job");
    await live.moved("t", "job");
    expect(sent.at(-1)).toEqual({ callId: "job", offset: 0, text: "one\n", from: 0 });
    await advance(live, LIVE_FLUSH_MS);
    call.output("two\n");
    await live.settled();
    expect(sent.at(-1)).toEqual({ callId: "job", offset: 4, text: "two\n", from: 0 });
    expect(await live.of("run-call")).toBeNull();
    expect(await live.of("job")).toEqual({ text: "one\ntwo\n" });
  });

  it("drops a piece stored after the call it went on as ended, and forgets its reporter", async () => {
    const { live, sent, open, ids, holding } = await setup();
    const call = open("t", "run-call");
    call.output("one\n");
    await live.settled();
    await live.move("run-call", "job");
    ids.set("run-call", "job");
    // The job ended elsewhere: nothing here holds it any more.
    holding.now = false;
    await live.end("job");
    await advance(live, LIVE_FLUSH_MS);
    call.output("two\n");
    await live.settled();
    holding.now = true;
    await advance(live, LIVE_FLUSH_MS);
    call.output("three\n");
    await live.settled();
    expect(sent).toHaveLength(1);
    expect(await live.of("job")).toBeNull();
  });

  it("gives each thread its own calls", async () => {
    const { live, open } = await setup();
    open("t", "c").output("here");
    open("u", "d").output("there");
    await live.settled();
    expect((await live.inThread("t")).map((chunk) => chunk.callId)).toEqual(["c"]);
  });
});

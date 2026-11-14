// What running tool calls print while they run, and how far they have come, for the people watching
// them. The instance running a call gathers what it prints and stores it at most a few times a
// second, keeping the end of it up to a cap, and tells the thread's followers each piece stored, on
// every instance, as reply pieces are told. Someone who starts following later is given the end
// kept. The model is not given it; the call's result is the record of it, and what was kept goes
// in the write that records the result.

import type { AfterCommit, Sync, Transact } from "@/server/sync/sync.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { LiveChunk, LiveProgress } from "@/shared/threads/events.ts";

import type { LiveStore } from "./live-store.ts";

// How many characters of a call's output are kept, about 800 lines of 80 columns.
export const LIVE_CHARS = 64_000;
// The least time between two pieces of one call stored.
export const LIVE_FLUSH_MS = 100;

// What a tool reports while its call runs.
export interface LiveReporter {
  // Adds to what the call printed.
  output(text: string): void;
  // Says how far the call has come.
  progress(progress: LiveProgress): void;
}

export interface LiveOptions {
  store: LiveStore;
  bus: Pick<Signals, "publish">;
  transact: Transact;
  // What a write changes here waits for it to be kept, so a write run again changes it once.
  afterCommit: AfterCommit;
  ordered: Sync["ordered"];
  now?: () => number;
}

export type Live = ReturnType<typeof createLive>;

// A call reporting here, by the id it was opened with.
interface Reporting {
  callId: string;
  threadId: string;
  // The id to store what it prints under while this instance carries it out, read in the write
  // that stores a piece: its own, or the job's it went on as; null once it is no longer here.
  where: () => Promise<string | null>;
  // The id its last piece was stored under.
  storedAs: string;
  // How many characters were printed in all, and what of them is not stored yet.
  total: number;
  unsent: string;
  progress?: LiveProgress;
  changed: boolean;
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  // The storing of its pieces, one after another, so they are kept and told in order.
  storing: Promise<void>;
}

// The last characters of the text, up to the cap.
function capped(text: string) {
  return text.length > LIVE_CHARS ? text.slice(-LIVE_CHARS) : text;
}

// Where what is kept starts, of the total printed.
function keptFrom(total: number) {
  return Math.max(0, total - LIVE_CHARS);
}

export function createLive(options: LiveOptions) {
  const { store, bus, transact, afterCommit, ordered, now = Date.now } = options;
  // The calls reporting here, by their id now.
  const reporting = new Map<string, Reporting>();

  function forget(call: Reporting) {
    clearTimeout(call.timer);
    call.timer = undefined;
    if (reporting.get(call.callId) === call) reporting.delete(call.callId);
  }

  // The call reporting here whose pieces go under the id, as opened or as it went on.
  function reportingAs(callId: string) {
    return (
      reporting.get(callId) ?? [...reporting.values()].find((call) => call.storedAs === callId)
    );
  }

  // Takes what is new and stores it, unless the call is no longer this instance's to carry out,
  // after the pieces taken before it, then tells the thread's followers.
  function flush(call: Reporting) {
    clearTimeout(call.timer);
    call.timer = undefined;
    if (!call.unsent && !call.changed) return call.storing;
    const piece = { offset: call.total - call.unsent.length, text: call.unsent };
    const report = { total: call.total, keepFrom: keptFrom(call.total), progress: call.progress };
    call.unsent = "";
    call.changed = false;
    call.sentAt = now();
    const stored = call.storing.then(() => store1(call, piece, report));
    // A piece that cannot be stored is lost to those watching; the next is tried all the same.
    call.storing = stored.catch(() => {});
    return stored;
  }

  async function store1(
    call: Reporting,
    piece: { offset: number; text: string },
    { total, keepFrom, progress }: { total: number; keepFrom: number; progress?: LiveProgress },
  ) {
    // Inside a hold on the thread, so a piece is stored before the write that ends the call or not
    // at all, under the id the call goes by then.
    const stored = await transact(async () => {
      await ordered("thread", [call.threadId], async ([id]) => store.lock(id!));
      if (reporting.get(call.callId) !== call) return null;
      const as = await call.where();
      if (!as) return null;
      await store.write(call.threadId, as, {
        total,
        ...(progress && { progress }),
        piece,
        keepFrom,
      });
      bus.publish(call.threadId, { kind: "live", callId: as });
      return as;
    });
    if (stored) call.storedAs = stored;
    else forget(call);
  }

  // Stores what is new at once when the call has been quiet, or else once the least time between
  // two pieces has passed.
  function schedule(call: Reporting) {
    if (call.timer) return;
    const wait = call.sentAt + LIVE_FLUSH_MS - now();
    if (wait <= 0) {
      void flush(call).catch(() => {});
      return;
    }
    call.timer = setTimeout(() => void flush(call).catch(() => {}), wait);
    call.timer.unref?.();
  }

  // All that is kept of what the call printed, as one piece, with its progress; none when it has
  // neither.
  async function tail(callId: string): Promise<LiveChunk | null> {
    const kept = await store.tail(callId, LIVE_CHARS);
    if (!kept || (!kept.text && !kept.progress)) return null;
    const { from, text, progress } = kept;
    return { callId, offset: from, text, from, ...(progress && { progress }) };
  }

  return {
    // What the call reports with until it ends, stored under the id `where` gives while this
    // instance carries it out. Nothing is stored for a call that reports nothing.
    // Resolves once every piece being stored is.
    async settled() {
      await Promise.all([...reporting.values()].map((call) => call.storing));
    },

    open(threadId: string, callId: string, where: () => Promise<string | null>): LiveReporter {
      const call: Reporting = {
        callId,
        threadId,
        where,
        storedAs: callId,
        total: 0,
        unsent: "",
        changed: false,
        sentAt: 0,
        storing: Promise.resolve(),
      };
      reporting.set(callId, call);
      const mine = () => reporting.get(call.callId) === call;
      return {
        output(text) {
          if (!text || !mine()) return;
          call.total += text.length;
          call.unsent = capped(call.unsent + text);
          schedule(call);
        },
        progress(progress) {
          if (!mine()) return;
          call.progress = progress;
          call.changed = true;
          schedule(call);
        },
      };
    },

    // Keeps what the call printed under the id it goes on with, as when it is moved to the
    // background, inside the write that moves it; its reporter's `where` gives that id from then
    // on.
    async move(from: string, to: string) {
      await store.move(from, to);
    },

    // Tells followers what was kept of a call that goes on under another id, once that is written.
    async moved(threadId: string, callId: string) {
      if (await tail(callId)) bus.publish(threadId, { kind: "live", callId });
    },

    tail,

    // Stops taking what the call reports here, where it ended without this instance.
    close(callId: string) {
      const call = reportingAs(callId);
      if (call) forget(call);
    },

    // Drops what the call printed: inside the write that records its result, so it never shows
    // alongside it.
    async end(callId: string) {
      await store.remove(callId);
      afterCommit(() => {
        const call = reportingAs(callId);
        if (call) forget(call);
      });
    },

    // The end of what a running call printed so far and its progress, for the agent to check.
    async of(callId: string) {
      const tail = await store.tail(callId, LIVE_CHARS);
      return tail && { text: tail.text, ...(tail.progress && { progress: tail.progress }) };
    },

    // What each of the thread's running calls printed so far, as one piece each.
    async inThread(threadId: string): Promise<LiveChunk[]> {
      return store.inThread(threadId, LIVE_CHARS);
    },
  };
}

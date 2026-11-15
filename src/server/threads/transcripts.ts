// Threads' transcripts folded from their logs, one branch at a time. While a thread is held, as
// when someone follows it or its agent runs, the folds of its branches read stay in memory, so
// each new event is folded in once however many read it; every read brings a fold up to date from
// the log first, and a thread nobody holds is folded afresh each time. A fold once read never
// changes: newer events are folded into a fork of it, which is kept in its place, so a reader
// holding one sees one moment of the thread however long it takes. A read inside a write folds in
// the write's events too, on a fork kept for none but it, since no one else may see them yet;
// should a fold kept be of events since replaced, the next read finds the newest one gone and
// folds the branch afresh. Rows name their writers as they were when folded, so held folds are
// dropped when people leave an org, to show them as former.
// What a call gave back is not folded in when it is large: its row names it, and a reader that
// needs the results themselves, as the model does, asks for the rows whole.

import type { Signals } from "@/server/sync/signals.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import { createFold, type TranscriptFold, type TranscriptRow } from "@/shared/transcript.ts";

import { eventSummary } from "./log.ts";
import type { ThreadStore } from "./types.ts";

export type Transcripts = ReturnType<typeof createTranscripts>;

interface Held {
  fold: TranscriptFold;
  // The id of the newest event folded in.
  lastId: string | null;
}

export function createTranscripts(
  threads: Pick<ThreadStore, "eventsAfter" | "eventAt" | "find" | "results">,
  signals?: Pick<Signals, "peopleLeft" | "onPeopleLeft" | "onGap">,
  hooks?: Pick<Hooks, "on">,
  // Whether the caller is inside a write.
  writing: () => boolean = () => false,
) {
  const held = new Map<string, { folds: Map<string, Held>; holders: number }>();
  // Told through the signals, so every instance's folds go, whichever saw people leave.
  hooks?.on("org.membersSettled", ({ left }) => {
    if (left.length > 0) signals?.peopleLeft();
  });
  signals?.onPeopleLeft(() => {
    for (const entry of held.values()) entry.folds.clear();
  });
  // So are they after a gap in what this instance heard, which may have missed people leaving.
  signals?.onGap(() => {
    for (const entry of held.values()) entry.folds.clear();
  });

  return {
    // The transcript of the branch, the thread's current one when none is named, up to its
    // newest event.
    async of(threadId: string, branchId?: string): Promise<TranscriptFold> {
      const branch = branchId ?? (await threads.find(threadId))?.currentBranchId ?? threadId;
      const folds = held.get(threadId)?.folds;
      let entry = folds?.get(branch);
      if (
        entry &&
        entry.fold.last > 0 &&
        (await threads.eventAt(threadId, entry.fold.last))?.id !== entry.lastId
      ) {
        entry = undefined;
      }
      const events = await threads.eventsAfter(threadId, entry?.fold.last ?? 0, branch);
      if (entry && events.length === 0) return entry.fold;
      const fold = entry ? entry.fold.fork() : createFold();
      let lastId = entry?.lastId ?? null;
      for (const event of events) {
        fold.add(eventSummary(event));
        lastId = event.id;
      }
      // Kept for others, unless another read kept a newer one meanwhile.
      const kept = folds?.get(branch);
      if (folds && !writing() && (!kept || kept.fold.last <= fold.last)) {
        folds.set(branch, { fold, lastId });
      }
      return fold;
    },

    // The rows with the results kept apart from the log read back into them.
    async whole<Row extends TranscriptRow>(rows: readonly Row[]): Promise<readonly Row[]> {
      const large = rows.flatMap((row) =>
        row.kind === "tool" && row.output?.ok && row.output.large ? [row.output.large.id] : [],
      );
      if (large.length === 0) return rows;
      const results = await threads.results(large);
      return rows.map((row) =>
        row.kind === "tool" && row.output?.ok && row.output.large
          ? { ...row, output: { ok: true, value: results.get(row.output.large.id) ?? null } }
          : row,
      );
    },

    // Keeps the thread's folds in memory until the function returned is called.
    hold(threadId: string) {
      const entry = held.get(threadId) ?? { folds: new Map(), holders: 0 };
      entry.holders += 1;
      held.set(threadId, entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.holders -= 1;
        if (entry.holders === 0 && held.get(threadId) === entry) held.delete(threadId);
      };
    },
  };
}

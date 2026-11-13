// Threads' transcripts folded from their logs, one branch at a time. While a thread is held, as
// when someone follows it or its agent runs, the folds of its branches read stay in memory, so
// each new event is folded in once however many read it; every read brings a fold up to date from
// the log first, and a thread nobody holds is folded afresh each time. A read inside a write folds
// in the write's events too; should the write be rolled back, the next read finds the newest
// event folded gone or replaced and folds the branch afresh. Rows name their writers as they
// were when folded, so held folds are dropped when people leave an org, to show them as former.
// What a call gave back is not folded in when it is large: its row names it, and a reader that
// needs the results themselves, as the model does, asks for the rows whole.

import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import { createFold, type TranscriptFold, type TranscriptRow } from "@/shared/transcript.ts";

import { eventSummary } from "./log.ts";
import type { ThreadStore } from "./service.ts";

export type Transcripts = ReturnType<typeof createTranscripts>;

interface Held {
  fold: TranscriptFold;
  // The id of the newest event folded in.
  lastId: string | null;
}

export function createTranscripts(
  threads: Pick<ThreadStore, "eventsAfter" | "eventAt" | "find" | "results">,
  bus?: Pick<EventBus, "peopleLeft" | "onPeopleLeft">,
  hooks?: Pick<Hooks, "on">,
) {
  const held = new Map<string, { folds: Map<string, Held>; holders: number }>();
  // Told through the bus, so every instance's folds go, whichever saw people leave.
  hooks?.on("org.membersSettled", ({ left }) => {
    if (left.length > 0) bus?.peopleLeft();
  });
  bus?.onPeopleLeft(() => {
    for (const entry of held.values()) entry.folds.clear();
  });

  return {
    // The transcript of the branch, the thread's current one when none is named, up to its
    // newest event.
    of(threadId: string, branchId?: string): TranscriptFold {
      const branch = branchId ?? threads.find(threadId)?.currentBranchId ?? threadId;
      const folds = held.get(threadId)?.folds;
      let entry = folds?.get(branch);
      if (
        entry &&
        entry.fold.last > 0 &&
        threads.eventAt(threadId, entry.fold.last)?.id !== entry.lastId
      ) {
        entry = undefined;
      }
      entry ??= { fold: createFold(), lastId: null };
      folds?.set(branch, entry);
      for (const event of threads.eventsAfter(threadId, entry.fold.last, branch)) {
        entry.fold.add(eventSummary(event));
        entry.lastId = event.id;
      }
      return entry.fold;
    },

    // The rows with the results kept apart from the log read back into them.
    whole<Row extends TranscriptRow>(rows: readonly Row[]): readonly Row[] {
      const large = rows.flatMap((row) =>
        row.kind === "tool" && row.output?.ok && row.output.large ? [row.output.large.id] : [],
      );
      if (large.length === 0) return rows;
      const results = threads.results(large);
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

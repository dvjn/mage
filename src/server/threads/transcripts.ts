// Threads' transcripts folded from their logs, one branch at a time. While someone follows a
// thread the folds of its branches read stay in memory, so each new event is folded in once
// however many follow it; every read brings a fold up to date from the log first, and a thread
// nobody follows is folded afresh each time.

import { createFold, type TranscriptFold } from "@/shared/transcript.ts";

import { eventSummary } from "./log.ts";
import type { ThreadStore } from "./service.ts";

export type Transcripts = ReturnType<typeof createTranscripts>;

export function createTranscripts(threads: Pick<ThreadStore, "eventsAfter" | "find">) {
  const held = new Map<string, { folds: Map<string, TranscriptFold>; holders: number }>();

  return {
    // The transcript of the branch, the thread's current one when none is named, up to its
    // newest event.
    of(threadId: string, branchId?: string): TranscriptFold {
      const branch = branchId ?? threads.find(threadId)?.currentBranchId ?? threadId;
      const folds = held.get(threadId)?.folds;
      const fold = folds?.get(branch) ?? createFold();
      folds?.set(branch, fold);
      for (const event of threads.eventsAfter(threadId, fold.last, branch)) {
        fold.add(eventSummary(event));
      }
      return fold;
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

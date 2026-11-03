// Threads' transcripts folded from their logs. While someone follows a thread its fold stays in
// memory, so each new event is folded in once however many follow it; every read brings a fold up
// to date from the log first, and a thread nobody follows is folded afresh each time.

import { createFold, type TranscriptFold } from "@/shared/transcript.ts";

import { eventSummary } from "./log.ts";
import type { ThreadStore } from "./service.ts";

export type Transcripts = ReturnType<typeof createTranscripts>;

export function createTranscripts(threads: Pick<ThreadStore, "eventsAfter">) {
  const held = new Map<string, { fold: TranscriptFold; holders: number }>();

  return {
    // The thread's transcript up to its newest event.
    of(threadId: string): TranscriptFold {
      const fold = held.get(threadId)?.fold ?? createFold();
      for (const event of threads.eventsAfter(threadId, fold.last)) fold.add(eventSummary(event));
      return fold;
    },

    // Keeps the thread's fold in memory until the function returned is called.
    hold(threadId: string) {
      const entry = held.get(threadId) ?? { fold: createFold(), holders: 0 };
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

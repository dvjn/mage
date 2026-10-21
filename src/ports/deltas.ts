// The pieces of text agent replies have streamed so far, of their answers and their reasoning, kept
// until each reply completes, so a reconnecting reader and a recovering worker can rebuild a reply
// in progress.

import type { DeltaBatch } from "@/shared/threads.ts";

export interface DeltaStore {
  append(threadId: string, batch: DeltaBatch): void;
  // The thread's stored pieces in order, one batch per run of answer or reasoning pieces of each
  // reply in progress, from its first piece.
  inThread(threadId: string): DeltaBatch[];
  // The reply's answer and reasoning so far.
  partsOf(messageId: string): { text: string; reasoning: string };
  remove(messageId: string): void;
}

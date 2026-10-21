// The pieces of text agent replies have streamed so far, kept until each reply completes, so a
// reconnecting reader and a recovering worker can rebuild a reply in progress.

import type { DeltaBatch } from "@/shared/threads.ts";

export interface DeltaStore {
  append(threadId: string, batch: DeltaBatch): void;
  // The thread's stored pieces, one batch per reply in progress, each from its first piece.
  inThread(threadId: string): DeltaBatch[];
  // The reply's text so far.
  textOf(messageId: string): string;
  remove(messageId: string): void;
}

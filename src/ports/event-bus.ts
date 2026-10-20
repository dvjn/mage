// Tells everyone following a thread about each event as it is appended.

import type { ThreadEventSummary } from "@/shared/threads.ts";

export interface EventBus {
  publish(threadId: string, event: ThreadEventSummary): void;
  // Calls `listener` with each event published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (event: ThreadEventSummary) => void): () => void;
}

// Tells everyone following a thread about each event as it is appended, and the agent worker
// when a thread may have work for it.

import type { ThreadEventSummary } from "@/shared/threads.ts";

export interface EventBus {
  publish(threadId: string, event: ThreadEventSummary): void;
  // Calls `listener` with each event published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (event: ThreadEventSummary) => void): () => void;
  // Says the thread may have a run to start or stop.
  wake(threadId: string): void;
  // Calls `listener` with each woken thread until unsubscribed.
  onWake(listener: (threadId: string) => void): () => void;
}

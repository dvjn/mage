// Tells everyone following a thread about each event as it is appended and each piece of a reply
// as it is stored, and the agent worker when a thread may have work for it.

import type { ThreadFeedItem } from "@/shared/threads.ts";

export interface EventBus {
  publish(threadId: string, item: ThreadFeedItem): void;
  // Calls `listener` with each item published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (item: ThreadFeedItem) => void): () => void;
  // Says the thread may have a run to start or stop.
  wake(threadId: string): void;
  // Calls `listener` with each woken thread until unsubscribed.
  onWake(listener: (threadId: string) => void): () => void;
}

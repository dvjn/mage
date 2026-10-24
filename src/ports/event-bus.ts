// Tells everyone following a thread about each event as it is appended and each piece of a reply
// as it is stored, the agent worker when a thread may have work for it, and people's inboxes when
// what a thread holds for its readers may have changed.

import type { ThreadFeedItem } from "@/shared/threads.ts";

// A thread whose list entry may read differently now; with `read`, only that someone saw it up to
// a seq; with `gone`, it was deleted, and who could read it: its space's members and its guests.
export interface ActivityChange {
  threadId: string;
  read?: { userId: string; seq: number };
  gone?: { spaceId: string; guests: string[] };
}

export interface EventBus {
  publish(threadId: string, item: ThreadFeedItem): void;
  // Calls `listener` with each item published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (item: ThreadFeedItem) => void): () => void;
  // Says the thread may have a run to start or stop.
  wake(threadId: string): void;
  // Calls `listener` with each woken thread until unsubscribed.
  onWake(listener: (threadId: string) => void): () => void;
  // Says what a thread holds for its readers may have changed.
  activity(change: ActivityChange): void;
  // Calls `listener` with each change until unsubscribed.
  onActivity(listener: (change: ActivityChange) => void): () => void;
}

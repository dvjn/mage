// Thread events, reply pieces, wake-ups and changes for inboxes passed between requests and the
// agent worker in this process with an event emitter.

import { EventEmitter } from "node:events";

import type { ThreadFeedItem } from "@/shared/threads/events.ts";

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

// Thread ids are ULIDs, so no thread's channel is named this.
const WAKE = "wake";
const ACTIVITY = "activity";

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  // Every open thread view is a listener.
  emitter.setMaxListeners(0);
  return {
    publish(threadId, item) {
      emitter.emit(threadId, item);
    },

    subscribe(threadId, listener) {
      emitter.on(threadId, listener);
      return () => emitter.off(threadId, listener);
    },

    wake(threadId) {
      emitter.emit(WAKE, threadId);
    },

    onWake(listener) {
      emitter.on(WAKE, listener);
      return () => emitter.off(WAKE, listener);
    },

    activity(change) {
      emitter.emit(ACTIVITY, change);
    },

    onActivity(listener) {
      emitter.on(ACTIVITY, listener);
      return () => emitter.off(ACTIVITY, listener);
    },
  };
}

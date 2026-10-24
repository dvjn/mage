// Thread events, reply pieces, wake-ups and changes for inboxes passed between requests and the
// agent worker in this process with an event emitter.

import { EventEmitter } from "node:events";

import type { EventBus } from "@/ports/event-bus.ts";

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

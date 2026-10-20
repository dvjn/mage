// Thread events passed between requests in this process with an event emitter.

import { EventEmitter } from "node:events";

import type { EventBus } from "@/ports/event-bus.ts";

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  // Every open thread view is a listener.
  emitter.setMaxListeners(0);
  return {
    publish(threadId, event) {
      emitter.emit(threadId, event);
    },

    subscribe(threadId, listener) {
      emitter.on(threadId, listener);
      return () => emitter.off(threadId, listener);
    },
  };
}

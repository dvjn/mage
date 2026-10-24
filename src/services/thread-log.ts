// Writes to threads' event logs: appends events in one transaction, then tells the thread's
// followers about each, so nothing is announced that was not stored, and people's inboxes that the
// thread may read differently now.

import type { EventBus } from "@/ports/event-bus.ts";
import type { NewEvent, StoredEvent, ThreadStore } from "@/ports/threads.ts";
import type { Transact } from "@/ports/transaction.ts";
import type { ThreadEventSummary } from "@/shared/threads.ts";

export interface ThreadLogOptions {
  threads: Pick<ThreadStore, "append">;
  bus: EventBus;
  transact: Transact;
}

export type ThreadLog = ReturnType<typeof createThreadLog>;

export const FORMER_MEMBER = "(former member)";

// Appends one event inside a write; `title` names the thread when it has no title yet.
export type Append = (event: NewEvent, title?: string) => StoredEvent;

export function eventSummary(event: StoredEvent): ThreadEventSummary {
  const { id, threadId, seq, type, data, actor, actorName, actorFormer } = event;
  return {
    id,
    threadId,
    seq,
    type,
    data,
    actor:
      actor.kind === "user"
        ? {
            kind: "user",
            userId: actor.userId,
            name: actorName ?? FORMER_MEMBER,
            ...(actorFormer && actorName && { former: true }),
          }
        : actor,
    createdAt: event.createdAt.toISOString(),
  } as ThreadEventSummary;
}

export function createThreadLog(options: ThreadLogOptions) {
  const { threads, bus, transact } = options;

  return {
    // Runs `work` in one transaction with the events it appends, then publishes them. Returns what
    // `work` returns and the events.
    write<T>(threadId: string, work: (append: Append) => T) {
      const appended: StoredEvent[] = [];
      const result = transact(() =>
        work((event, title) => {
          const stored = threads.append(threadId, event, title);
          appended.push(stored);
          return stored;
        }),
      );
      const events = appended.map(eventSummary);
      for (const event of events) bus.publish(threadId, { kind: "event", event });
      // Run changes made in the write, such as waiting for a decision, show too.
      bus.activity({ threadId });
      return { result, events };
    },
  };
}

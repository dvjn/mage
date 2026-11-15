// Writes to threads' event logs: appends events in one transaction, then tells the thread's
// followers about each, so nothing is announced that was not stored, and people's feeds that the
// thread may read differently now.

import type { Sync, Transact } from "@/server/sync/sync.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { ThreadEventSummary } from "@/shared/threads/events.ts";

import type { NewEvent, StoredEvent, ThreadStore } from "./types.ts";

export interface ThreadLogOptions {
  threads: Pick<ThreadStore, "append" | "lock">;
  signals: Signals;
  transact: Transact;
  ordered: Sync["ordered"];
}

export type ThreadLog = ReturnType<typeof createThreadLog>;

// Appends one event inside a write; `title` names the thread when it has no title yet, and
// `branchId` names the branch it goes to in place of the write's.
export type Append = (event: NewEvent, title?: string, branchId?: string) => Promise<StoredEvent>;

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
            name: actorName,
            former: actorFormer || actorName === null,
          }
        : actor,
    createdAt: event.createdAt.toISOString(),
  } as ThreadEventSummary;
}

export function createThreadLog(options: ThreadLogOptions) {
  const { threads, signals, transact, ordered } = options;

  return {
    // Runs `work` in one transaction with the events it appends, to the branch named or else the
    // thread's current one, then publishes them once it is kept. Returns what `work` returns and
    // the events. `also` names the other threads the work writes to, locked with this one in
    // order.
    async write<T>(
      threadId: string,
      work: (append: Append) => Promise<T>,
      branchId?: string,
      also: string[] = [],
    ) {
      let appended: StoredEvent[] = [];
      const result = await transact(async () => {
        appended = [];
        // Writes to one thread take turns, so what one reads of it holds until it is done.
        await ordered("thread", [threadId, ...also], async (ids) => threads.lock(ids));
        const result = await work(async (event, title, to) => {
          const stored = await threads.append(threadId, event, title, to ?? branchId);
          appended.push(stored);
          return stored;
        });
        // Told as the write commits, and only if it does.
        for (const event of appended) signals.publish(threadId, { kind: "event", seq: event.seq });
        // Run changes made in the write, such as waiting for a decision, show too.
        signals.changed({ threadId });
        return result;
      });
      return { result, events: appended.map(eventSummary) };
    },
  };
}

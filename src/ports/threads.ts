// Threads and their event logs. Appending is the only way a thread's content changes.

import type { MessageData } from "@/shared/threads.ts";

export type Actor = { kind: "user"; userId: string } | { kind: "agent" };

export interface Thread {
  id: string;
  spaceId: string;
  // Null until the first message names it or someone sets it.
  title: string | null;
  model: string | null;
  createdBy: string | null;
  parentThreadId: string | null;
  rootThreadId: string | null;
  lastEventSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewEvent = { type: "message"; actor: Actor; data: MessageData };

export type StoredEvent = NewEvent & {
  id: string;
  threadId: string;
  seq: number;
  // The acting user's name, or null once they are gone.
  actorName: string | null;
  createdAt: Date;
};

export interface ThreadStore {
  create(thread: { spaceId: string; model: string | null; createdBy: string }): Thread;
  find(id: string): Thread | null;
  // Most recently active first.
  listInSpace(spaceId: string): Thread[];
  anyInSpace(spaceId: string): boolean;
  update(id: string, changes: { title?: string; model?: string }): Thread;
  // Adds the event with the thread's next seq in one transaction. `title` names the thread when
  // it has no title yet.
  append(threadId: string, event: NewEvent, title?: string): StoredEvent;
  // The thread's events with seq above `after`, in order.
  eventsAfter(threadId: string, after: number): StoredEvent[];
}

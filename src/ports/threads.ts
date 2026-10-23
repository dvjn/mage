// Threads and their event logs. Appending is the only way a thread's content changes.

import type { Effort, EventDataMap } from "@/shared/threads.ts";

export type TitleSource = "message" | "agent" | "person";

export type Actor = { kind: "user"; userId: string } | { kind: "agent" };

export interface Thread {
  id: string;
  spaceId: string;
  // Null when the thread is at the space's top level.
  folderId: string | null;
  // Null until the first message names it or someone sets it.
  title: string | null;
  // Who named it: its first message, the agent after it, or a person.
  titleSource: TitleSource | null;
  // Null follows the space's default, then the org's.
  model: string | null;
  // Null follows the space's default, then the org's, then the model's usual effort.
  effort: Effort | null;
  createdBy: string | null;
  parentThreadId: string | null;
  rootThreadId: string | null;
  lastEventSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewEvent = {
  [Type in keyof EventDataMap]: { type: Type; actor: Actor; data: EventDataMap[Type] };
}[keyof EventDataMap];

export type StoredEvent = NewEvent & {
  id: string;
  threadId: string;
  seq: number;
  // The acting user's name, or null once they are gone.
  actorName: string | null;
  createdAt: Date;
};

export interface ThreadStore {
  create(thread: {
    spaceId: string;
    folderId: string | null;
    model: string | null;
    effort?: Effort | null;
    createdBy: string;
  }): Thread;
  find(id: string): Thread | null;
  // Most recently active first.
  listInSpace(spaceId: string): Thread[];
  anyInSpace(spaceId: string): boolean;
  // The newest message from a person or reply from the agent in each of the space's threads that
  // has one.
  lastMessagesInSpace(spaceId: string): StoredEvent[];
  // Threads in the spaces whose titles contain the text, ignoring case, most recently active
  // first, at most `limit` of them.
  // Untitled threads match as `untitled`.
  search(spaceIds: string[], text: string, limit: number, untitled: string): Thread[];
  update(
    id: string,
    changes: {
      title?: string;
      titleSource?: TitleSource;
      // Null follows the space's default.
      model?: string | null;
      effort?: Effort | null;
      folderId?: string | null;
    },
  ): Thread;
  // Deletes the thread with its events.
  delete(id: string): void;
  // Adds the event with the thread's next seq in one transaction. `title` names the thread, as
  // from its first message, when it has no title yet.
  append(threadId: string, event: NewEvent, title?: string): StoredEvent;
  // The thread's events with seq above `after`, in order.
  eventsAfter(threadId: string, after: number): StoredEvent[];
}

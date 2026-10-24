// Threads and their event logs, and how far into each thread each person has seen. Appending is the
// only way a thread's content changes.

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
  // The acting user was removed from the thread's org.
  actorFormer: boolean;
  createdAt: Date;
};

// What a thread's log says about what its readers have not seen: its newest notable event (a
// person's message, a finished reply or a failed run) and who wrote it, null for the agent; and its
// last run's failure when nothing has run since, with what went wrong.
export interface ThreadFacts {
  notable: { seq: number; by: string | null } | null;
  failed: { seq: number; error: string } | null;
}

// The people who have written in a thread, whoever wrote last first, each with their name while
// they still have one, and whether their last message was written as a guest of the thread.
export type ThreadWriters = { userId: string; name: string | null; guest: boolean }[];

// What a list of threads is narrowed to for its reader: those whose title, or the text named for
// each list, contains the text, ignoring case; and those with something new for the reader, or those
// that may need them, having failed since they looked or waiting on a decision, which may not be
// theirs to make.
export interface ThreadListFilter {
  text?: string;
  show?: "unread" | "maybe-needs-you";
}

// How many of a list's threads to take, after how many.
export interface ListWindow {
  limit: number;
  offset: number;
}

// A thread in a reader's list: whether its run waits on a decision, and whether its last run failed
// since the reader looked.
export interface ListedThread {
  thread: Thread;
  waiting: boolean;
  failed: boolean;
}

// The threads of a list a window takes, most recently active first, and how many match in all.
export interface Listed<T> {
  rows: T[];
  total: number;
}

// The threads a space's sidebar lists for a reader: the newest few of each folder and of the top of
// the space, and beside them the newest of each status the reader would see in each folder, every
// thread whose run waits on a decision and the newest few that failed since they looked; with how
// many threads each folder holds, the top of the space under null, and how many failed since they
// looked in all.
export interface SidebarThreads {
  rows: ListedThread[];
  counts: Map<string | null, number>;
  failed: number;
}

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
  // The space's threads for the reader, narrowed to one folder and by the filter, matching text in
  // their title or newest message; those the window takes, every match without one.
  listed(
    reader: string,
    spaceId: string,
    filter: ThreadListFilter & { folderId?: string },
    window?: ListWindow,
  ): Listed<ListedThread>;
  // The space's threads for the reader's sidebar, the newest `limit` of each kind.
  sidebar(reader: string, spaceId: string, limit: number): SidebarThreads;
  // The facts of each of the threads named that has any events.
  facts(threadIds: string[]): Map<string, ThreadFacts>;
  // Who has written in each of the threads named that anyone has.
  writers(threadIds: string[]): Map<string, ThreadWriters>;
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

export interface ThreadReadStore {
  // The seq each of the threads named was seen up to by the user, for those they have seen.
  seen(userId: string, threadIds: string[]): Map<string, number>;
  // Records the user saw the thread up to `seq`, never moving back; returns how far they have now.
  mark(userId: string, threadId: string, seq: number, at: Date): number;
}

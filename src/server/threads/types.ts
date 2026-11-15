// The shapes the thread systems share: a thread, its branches and events, and the stores that keep
// them, how far people have seen them and the pieces of replies in progress.

import type { ThreadRequest } from "@/server/execution/compaction.ts";
import type { OpenModel } from "@/server/models/service.ts";
import type { Aside } from "@/shared/threads/history.ts";
import type { BranchKind, DeltaBatch, EventDataMap } from "@/shared/threads/events.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import type { TranscriptRow } from "@/shared/transcript.ts";

export type TitleSource = "message" | "agent" | "person";

export type Actor = { kind: "user"; userId: string } | { kind: "agent" };

export interface Thread {
  id: string;
  spaceId: string;
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
  // The branch people see and the agent reads.
  currentBranchId: string;
  lastEventSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

// A side question asked, its answer still to write: the side question so far, and what writes the
// answer, each piece as it comes, until it is done, stopped or `signal` ends it.
export interface Asking {
  aside: Aside;
  answer(write: (text: string) => void, signal: AbortSignal): Promise<Aside>;
}

// A line of a thread's conversation: the root, or one that starts from its parent as it was up to
// the event `forkSeq`. One that writes a row again names it and the first row of the versions it
// joins; one restored from a row names that row.
export interface Branch {
  id: string;
  threadId: string;
  parentBranchId: string | null;
  forkSeq: number | null;
  kind: "root" | BranchKind;
  rowId: string | null;
  groupRowId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

export type NewEvent = {
  [Type in keyof EventDataMap]: {
    type: Type;
    actor: Actor;
    data: EventDataMap[Type];
    // When it happened, for one copied from another thread.
    createdAt?: Date;
  };
}[keyof EventDataMap];

export type StoredEvent = NewEvent & {
  id: string;
  threadId: string;
  branchId: string;
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
export type ThreadWriters = {
  userId: string;
  name: string | null;
  former: boolean;
  guest: boolean;
}[];

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

// The threads a space's sidebar lists for a reader: the newest few, and beside them the newest of
// each status the reader would see, every thread whose run waits on a decision and the newest few
// that failed since they looked; with how many threads the space holds and how many failed since
// they looked in all.
export interface SidebarThreads {
  rows: ListedThread[];
  total: number;
  failed: number;
}

export interface ThreadStore {
  // A person's name, or null when they are gone.
  userName(userId: string): Promise<string | null>;
  // A subagent's thread names the thread that started them all; its subagent row, the thread whose
  // agent started it.
  create(thread: {
    spaceId: string;
    model: string | null;
    effort?: Effort | null;
    createdBy: string | null;
    rootThreadId?: string;
    title?: string;
    titleSource?: TitleSource;
    // When it was made and last active, for one arranged at a time of its own; now when not given.
    at?: Date;
  }): Promise<Thread>;
  find(id: string): Promise<Thread | null>;
  // The threads in the spaces, or under the threads, that changed at or after `since`, or that
  // the person read then, each with the stamp of its last change or read; and the time from which
  // to ask again: the database's time now, or the start of the oldest transaction still open, whose
  // writes are stamped with it but seen only once it commits, though no further back than
  // `heldAtMost` milliseconds.
  changedSince(input: {
    spaceIds: readonly string[];
    threadIds: readonly string[];
    userId: string;
    since: Date;
    heldAtMost: number;
  }): Promise<{ changes: Map<string, string>; at: Date }>;
  // Those of the threads with the ids that exist, in no order.
  findAll(ids: readonly string[]): Promise<Thread[]>;
  // Most recently active first.
  listInSpace(spaceId: string): Promise<Thread[]>;
  anyInSpace(spaceId: string): Promise<boolean>;
  // The space's threads for the reader, narrowed by the filter, matching text in their title or
  // newest message; those the window takes, every match without one.
  listed(
    reader: string,
    spaceId: string,
    filter: ThreadListFilter,
    window?: ListWindow,
  ): Promise<Listed<ListedThread>>;
  // The space's threads for the reader's sidebar, the newest `limit` of each kind.
  sidebar(reader: string, spaceId: string, limit: number): Promise<SidebarThreads>;
  // The facts of each of the threads named that has any events.
  facts(threadIds: string[]): Promise<Map<string, ThreadFacts>>;
  // Who has written in each of the threads named that anyone has.
  writers(threadIds: string[]): Promise<Map<string, ThreadWriters>>;
  // Threads in the spaces whose titles contain the text, ignoring case, most recently active first,
  // at most `limit` of them. Untitled threads match as `untitled`.
  search(spaceIds: string[], text: string, limit: number, untitled: string): Promise<Thread[]>;
  update(
    id: string,
    changes: {
      title?: string;
      titleSource?: TitleSource;
      // Null follows the space's default.
      model?: string | null;
      effort?: Effort | null;
      // Moves it to another space.
      spaceId?: string;
    },
  ): Promise<Thread>;
  // Deletes the thread with its events, and its subagents' threads.
  delete(id: string): Promise<void>;
  // The threads of the subagents started under the thread, oldest first.
  children(id: string): Promise<Thread[]>;
  // Holds the thread for the transaction under way: another that would write to it waits.
  lock(ids: string[]): Promise<void>;
  // Adds the event with the thread's next seq in one transaction, to the branch, the current one
  // when none is named. `title` names the thread, as from its first message, when it has no title
  // yet. What a call gave back is kept apart from the log when it is large, and the event stored
  // says so in place of the value.
  append(
    threadId: string,
    event: NewEvent,
    title?: string,
    branchId?: string,
  ): Promise<StoredEvent>;
  // What the calls gave back that is kept apart from the log, by the id of the event that ended
  // each.
  results(eventIds: readonly string[]): Promise<Map<string, unknown>>;
  // One such result, with the thread its event is in.
  result(eventId: string): Promise<{ threadId: string; value: unknown } | null>;
  // The events of the branch, the thread's current one when none is named, with seq above
  // `after`, in order.
  eventsAfter(threadId: string, after: number, branchId?: string): Promise<StoredEvent[]>;
  // The thread's current branch's events of the type, in order.
  eventsOfType(threadId: string, type: StoredEvent["type"]): Promise<StoredEvent[]>;
  // The thread's event with the seq, in whichever branch.
  eventAt(threadId: string, seq: number): Promise<StoredEvent | null>;
  // The thread's events at the seqs, oldest first.
  eventsAt(threadId: string, seqs: readonly number[]): Promise<StoredEvent[]>;
  // The changes made to the messages on the branch, the thread's current one when none is named,
  // oldest first.
  changesOf(
    threadId: string,
    messageIds: readonly string[],
    branchId?: string,
  ): Promise<StoredEvent[]>;
  // The latest result recorded for the call on the thread's current branch.
  lastRan(threadId: string, callId: string): Promise<StoredEvent | null>;
  // The thread's branches, oldest first.
  branches(threadId: string): Promise<Branch[]>;
  branch(id: string): Promise<Branch | null>;
  // The branches whose events the branch takes, itself among them, each up to the seq given.
  sources(branchId: string): Promise<{ branchId: string; untilSeq: number | null }[]>;
  addBranch(branch: {
    threadId: string;
    parentBranchId: string;
    forkSeq: number;
    kind: BranchKind;
    rowId: string;
    groupRowId: string | null;
    createdBy: string;
  }): Promise<Branch>;
  // Makes the branch the one people see and the agent reads.
  setCurrent(threadId: string, branchId: string): Promise<Thread>;
}

export interface DeltaStore {
  append(threadId: string, batch: DeltaBatch): Promise<void>;
  // The thread's stored pieces in order, one batch per run of answer or reasoning pieces of each
  // reply in progress, from its first piece.
  inThread(threadId: string): Promise<DeltaBatch[]>;
  // The reply's stored pieces from the one numbered `index`, batched as `inThread` batches them.
  from(messageId: string, index: number): Promise<DeltaBatch[]>;
  // The reply's answer and reasoning so far.
  partsOf(messageId: string): Promise<{ text: string; reasoning: string }>;
  remove(messageId: string): Promise<void>;
}

// The thread's model, opened, and what its next call would send were the branch to end at the row,
// or at its last; for asking from outside its runs.
export type ThreadAsk = (
  threadId: string,
  branchId: string,
  rowId?: string,
) => Promise<{
  model: OpenModel;
  ref: string;
  rows: readonly TranscriptRow[];
  request: ThreadRequest;
}>;

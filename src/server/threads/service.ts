// Threads in the spaces a person can see: starting them, naming them after their first message,
// finding them by title, moving them between spaces, deleting them, posting messages to their event
// logs, and reading them back as each reader sees them: their transcript's rows, a page at a time
// from the newest, with what the reader may do from each, and as the log grows the rows each new
// event changed, with the pieces of replies in progress. A message posted while the agent is idle
// wakes it at once; one posted while it is busy steers the run, waits for the next one, or
// interrupts the run, and its author can change it until the agent takes it in. Anyone who can post
// can stop the run, or try the last one again when it failed or was stopped; a run waiting for a
// decision on a tool call is queued again to be stopped. Lists say each thread's model and its
// provider, who has written in it and what it holds for the reader: what the agent is doing in it,
// whether they may decide on the call it waits for, its newest notable event, its last run's
// failure, and how far they have seen it, which reading it and posting in it move on, and the one
// status all that shows them. Each reader's inbox follows those changes for every thread they can
// read. Who may do each is the thread access rule's; a thread's guests find it, and post in it,
// beside the threads of their own spaces. Threads of an archived space stay out of search and
// inboxes; its person opens them from the space itself, and may move them to a space where they can
// post. People who can post may send a message as one of the thread's commands, kept with what the
// agent reads for it, or ask for the thread to be compacted, once the run under way ends. A
// subagent's thread is read like any other, though nothing in it is ever new to anyone, and listed
// under the thread whose agent started it, which takes in the most pressing of its subagents'
// statuses; that thread's lines for starting each subagent show where it stands now, with the call
// it waits on as the reader would see it in the subagent's thread. Each subagent call links to
// where it had its effect, and each message another agent sent links back to the call that sent
// it, in the threads the reader may read. Stopping a thread's agent stops its subagents too, and a
// retired subagent's thread is read-only until someone who can post there brings it back.

import { anythingToCompact } from "@/server/agent/compaction.ts";
import { type Subagents, steeringLine } from "@/server/agent/subagents.ts";
import { type Run, type RunStore, startRun } from "@/server/agent/runs.ts";
import type { Tools } from "@/server/agent/tools.ts";
import type { GuestStore, GuestThread } from "@/server/guests/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { Models } from "@/server/models/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import type { Access, ThreadAccess, ThreadAction } from "@/server/spaces/thread-access.ts";
import { ASK_TOOL } from "@/shared/ask.ts";
import type { SharedThread } from "@/shared/guests.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { SEND_SUBAGENT_MESSAGE, START_SUBAGENT } from "@/shared/subagents.ts";
import type { Page, PageParams } from "@/shared/paging.ts";
import { plainText } from "@/shared/plain-text.ts";
import { statusOf, type ThreadShow, type ThreadStatus } from "@/shared/thread-status.ts";
import { COMPACT, type CommandInput, type ThreadCommand } from "@/shared/threads/commands.ts";
import type { ThreadCan, ThreadDetail, ThreadHead } from "@/shared/threads/detail.ts";
import {
  type Cause,
  type Delivery,
  QUIET_PREFIX,
  type ThreadFeedItem,
  type DeltaBatch,
  type EventDataMap,
} from "@/shared/threads/events.ts";
import type { InboxItem } from "@/shared/threads/inbox.ts";
import {
  type ListedSubagent,
  type ThreadActivity,
  type ThreadListItem,
  type ThreadParticipants,
  type ThreadSidebar,
  SIDEBAR_LIMIT,
  type ShownModel,
} from "@/shared/threads/list.ts";
import {
  type CallEffect,
  ROWS_PAGE,
  type RowsPage,
  type RowsUpdate,
  type ShownRow,
  type ShownRun,
} from "@/shared/threads/rows.ts";
import type { ThreadSearchResult } from "@/shared/threads/search.ts";
import { type Effort, UNTITLED, type ThreadSummary } from "@/shared/threads/thread.ts";
import { toolIdNow } from "@/shared/tools.ts";
import type {
  PendingMessage,
  RelayRow,
  SentCommand,
  ToolRow as TranscriptToolRow,
  Transcript,
  TranscriptFold,
} from "@/shared/transcript.ts";

import type { Commands } from "./commands.ts";
import type { Append, ThreadLog } from "./log.ts";
import type { Titles } from "./titles.ts";
import { createTranscripts } from "./transcripts.ts";

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
  // A subagent's thread names the thread whose agent started it, and the thread that started them
  // all.
  create(thread: {
    spaceId: string;
    model: string | null;
    effort?: Effort | null;
    createdBy: string | null;
    parentThreadId?: string;
    rootThreadId?: string;
    title?: string;
    titleSource?: TitleSource;
  }): Thread;
  find(id: string): Thread | null;
  // Most recently active first.
  listInSpace(spaceId: string): Thread[];
  anyInSpace(spaceId: string): boolean;
  // The space's threads for the reader, narrowed by the filter, matching text in their title or
  // newest message; those the window takes, every match without one.
  listed(
    reader: string,
    spaceId: string,
    filter: ThreadListFilter,
    window?: ListWindow,
  ): Listed<ListedThread>;
  // The space's threads for the reader's sidebar, the newest `limit` of each kind.
  sidebar(reader: string, spaceId: string, limit: number): SidebarThreads;
  // The facts of each of the threads named that has any events.
  facts(threadIds: string[]): Map<string, ThreadFacts>;
  // Who has written in each of the threads named that anyone has.
  writers(threadIds: string[]): Map<string, ThreadWriters>;
  // Threads in the spaces whose titles contain the text, ignoring case, most recently active first,
  // at most `limit` of them. Untitled threads match as `untitled`.
  search(spaceIds: string[], text: string, limit: number, untitled: string): Thread[];
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
  ): Thread;
  // Deletes the thread with its events, and its subagents' threads.
  delete(id: string): void;
  // The threads of the subagents started under the thread, oldest first.
  children(id: string): Thread[];
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

export interface DeltaStore {
  append(threadId: string, batch: DeltaBatch): void;
  // The thread's stored pieces in order, one batch per run of answer or reasoning pieces of each
  // reply in progress, from its first piece.
  inThread(threadId: string): DeltaBatch[];
  // The reply's answer and reasoning so far.
  partsOf(messageId: string): { text: string; reasoning: string };
  remove(messageId: string): void;
}

export interface ThreadsOptions {
  spaces: Spaces;
  // Reads a thread's space for its defaults, whoever reads the thread.
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can" | "of" | "require">;
  guests: Pick<GuestStore, "threadsOf" | "sharedListed" | "activeIn">;
  threads: ThreadStore;
  // How far each person has seen each thread.
  reads: ThreadReadStore;
  runs: Pick<
    RunStore,
    "active" | "activeIn" | "activeInSpace" | "create" | "latest" | "requestCancel" | "resume"
  >;
  deltas: Pick<DeltaStore, "inThread">;
  models: Pick<Models, "defaults" | "requireModel" | "replyModel" | "shownModels">;
  log: ThreadLog;
  bus: EventBus;
  // Names threads after their first message, when given.
  titles?: Pick<Titles, "name">;
  // The commands people send in threads, when given.
  commands?: Pick<Commands, "list" | "expand">;
  // The agent's tools, for each reader's level for them.
  tools: Pick<
    Tools,
    "levelsFor" | "canDecide" | "asks" | "riskForCall" | "definitions" | "connectionFor" | "namesIn"
  >;
  // What the agent of the space's threads goes by where people see it; the usual name when not
  // given.
  agentNameIn?: (space: Space) => string;
  // The subagents threads' agents start, when given.
  subagents?: Pick<
    Subagents,
    "find" | "summaryOf" | "ofParents" | "reach" | "stopAll" | "unarchive"
  >;
  now?: () => Date;
}

export type Threads = ReturnType<typeof createThreads>;

// What a thread's follower is told: the rows the log's new events changed, with the waiting
// messages and the run as they now are; the pieces of a reply in progress; and the thread itself
// once it is renamed, moved or set to another model.
export type ThreadFollowItem =
  | { kind: "rows"; update: RowsUpdate }
  | { kind: "delta"; delta: DeltaBatch }
  | { kind: "thread"; head: ThreadHead };

// Who reads a thread and what they may do in it, for the parts of its rows that are theirs.
interface Reader {
  principal: Principal;
  userId: string;
  thread: Thread;
  space: Space | null;
  // The model the run under way replies with, by which a waiting call's risk is worked out.
  model: string | null;
  can: ThreadCan;
  // What each tool call is called where it shows.
  names: ReturnType<Tools["namesIn"]>;
  // Other threads' transcripts read for this reader's rows, each read once.
  folds: Map<string, TranscriptFold>;
}

// The subagent tools whose calls act on one subagent.
const SUBAGENT_ACTIONS = new Set([
  START_SUBAGENT,
  "subagents.stop",
  "subagents.archive",
  "subagents.unarchive",
]);

const causeKey = (call: Cause) => `${call.threadId}:${call.callId}`;

// The parts of a row that are the reader's, which can change while the row itself does not.
function readerPartsOf(row: ShownRow) {
  if (row.kind === "tool") {
    return JSON.stringify([
      row.risk,
      row.actions,
      row.canAnswer,
      row.connection,
      row.steering,
      row.subagent,
      row.subagentCall,
    ]);
  }
  if (row.kind === "failure" || row.kind === "stop") return JSON.stringify([row.canRetry]);
  return "";
}

// A command as its message shows it: what the person typed, without what the agent reads for it.
function shownCommand(command: SentCommand | undefined) {
  return command && { command: { name: command.name, args: command.args } };
}

// The messages waiting for the agent as readers see them.
function shownPending(pending: readonly PendingMessage[]) {
  return pending.map(({ command, ...message }) => ({ ...message, ...shownCommand(command) }));
}

// The id of the subagent the call started, for one that started a subagent.
function startedSubagent(row: Transcript["rows"][number]) {
  if (row.kind !== "tool" || toolIdNow(row.toolId) !== START_SUBAGENT || !row.output?.ok)
    return null;
  const id = (row.output.value as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

// The rows whose reader's parts can change while they do not: the calls waiting for a decision or
// for answers, those that started a subagent, which show where it stands, and a last row from which
// a failed or stopped run is tried again.
function liveIndexes({ rows }: Transcript) {
  const live = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "tool" && row.state === "pending" && row.waits) live.add(index);
    if (startedSubagent(row)) live.add(index);
  });
  const last = rows.at(-1);
  if (last?.kind === "failure" || last?.kind === "stop") live.add(rows.length - 1);
  return live;
}

// The run under way, and whether it waits for answers to the agent's questions or for a decision.
function shownRun({ run, rows }: Transcript): ShownRun | null {
  if (!run) return null;
  const call = run.waitingOn ? rows.find((row) => row.id === run.waitingOn) : undefined;
  const waiting = !call
    ? null
    : call.kind === "tool" && call.toolId === ASK_TOOL
      ? "answer"
      : "decision";
  return {
    id: run.id,
    createdAt: run.createdAt,
    waiting,
    ...(run.compacting && { compacting: true as const }),
  };
}

// Mage's own command, which anyone who can post may send.
const COMPACT_COMMAND: ThreadCommand = {
  name: COMPACT,
  description: "Summarise earlier messages for the agent",
  argumentHint: "[focus]",
  kind: "builtin",
  tag: null,
};

// The index of the first row the reader had not seen up to `seen` that is not their own nor a
// reply still being written; -1 when there is none.
function newFromOf({ rows }: Transcript, seen: number, userId: string) {
  return rows.findIndex(
    (row) =>
      row.seq > seen &&
      !(row.kind === "human" && row.author.userId === userId) &&
      !(row.kind === "agent" && row.status === "streaming"),
  );
}

const TITLE_LENGTH = 60;
export const SEARCH_LIMIT = 200;
// How long an inbox gathers changes before telling them.
const INBOX_DELAY_MS = 50;

// A thread's title from its first message: its text without markdown, on one line, cut to about
// 60 characters.
export function titleFrom(text: string) {
  const line = plainText(text).replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// How pressing each status is that a thread takes in from its subagents.
const PRESSING: ThreadStatus[] = ["waiting", "working", "paused"];

// The thread's own status, or the most pressing of its subagents' where that presses more.
function withSubagents(own: ThreadStatus, subagents: readonly ListedSubagent[]): ThreadStatus {
  if (own === "waiting" || own === "failed") return own;
  const shown = subagents.filter((subagent) => subagent.state !== "archived");
  const pressing = PRESSING.find((status) => shown.some((subagent) => subagent.status === status));
  if (!pressing) return own;
  return own === "working" && pressing === "paused" ? own : pressing;
}

// The most people a list names of those who have written in a thread.
const PARTICIPANT_LIMIT = 3;
const FORMER_MEMBER = "(former member)";

// The few who wrote in the thread most recently, each saying whether they wrote as a guest, and how
// many have.
function participantsOf(writers: ThreadWriters = []): ThreadParticipants {
  return {
    people: writers
      .slice(0, PARTICIPANT_LIMIT)
      .map(({ userId, name, guest }) => ({ userId, name: name ?? FORMER_MEMBER, guest })),
    total: writers.length,
  };
}

export function threadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    spaceId: thread.spaceId,
    title: thread.title ?? UNTITLED,
    untitled: thread.title === null,
    model: thread.model,
    effort: thread.effort,
    lastEventSeq: thread.lastEventSeq,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function createThreads(options: ThreadsOptions) {
  const {
    spaces,
    spaceStore,
    access,
    guests,
    threads,
    runs,
    deltas,
    models,
    log,
    bus,
    titles,
    tools,
    reads,
    commands,
    subagents,
  } = options;
  const now = options.now ?? (() => new Date());
  const agentNameOf = options.agentNameIn ?? (() => DEFAULT_AGENT_NAME);
  const transcripts = createTranscripts(threads);

  // Asks the thread's active run to stop, queueing it again when it waits for a decision so that a
  // worker ends it; null when there is none.
  function stopRun(threadId: string, userId: string) {
    const run = runs.requestCancel(threadId, userId, new Date());
    if (run?.status === "waiting") runs.resume(run.id);
    return run;
  }

  // The thread's active run as its list shows it, and whether the reader may decide on the call it
  // waits for.
  function runActivity(userId: string, thread: Thread, run: Run | undefined) {
    if (!run) return { run: null, canApprove: false };
    const since = (run.startedAt ?? run.createdAt).toISOString();
    if (run.status !== "waiting") {
      return {
        run: {
          status: run.status === "queued" ? ("queued" as const) : ("running" as const),
          since,
        },
        canApprove: false,
      };
    }
    const transcript = transcripts.of(run.threadId).transcript();
    const call = transcript.rows.find(
      (row) => row.kind === "tool" && row.id === transcript.run?.waitingOn,
    );
    const toolId = call?.kind === "tool" ? call.toolId : undefined;
    const space = toolId ? spaceStore.find(thread.spaceId) : null;
    return {
      run: {
        status: "waiting" as const,
        since: call?.kind === "tool" ? call.requestedAt : since,
        ...(toolId && { toolId }),
      },
      canApprove:
        call?.kind === "tool" &&
        !!space &&
        tools.canDecide(userId, call, transcript.rows, thread, space, run.model),
    };
  }

  // The model each thread's row shows, its own or the default it follows; reads each space and
  // each org's connections once.
  function shownModelOf() {
    const spacesById = new Map<string, Space | null>();
    const byOrg = new Map<string, (ref: string) => ShownModel>();
    return (thread: Thread): ShownModel | null => {
      if (!spacesById.has(thread.spaceId)) {
        spacesById.set(thread.spaceId, spaceStore.find(thread.spaceId));
      }
      const space = spacesById.get(thread.spaceId);
      if (!space) return null;
      const ref = thread.model ?? models.defaults(space).model;
      if (!ref) return null;
      const shown = byOrg.get(space.orgId) ?? models.shownModels(space.orgId);
      byOrg.set(space.orgId, shown);
      return shown(ref);
    };
  }

  // The subagents the threads' agents started, as the reader's lists show them under each.
  function subagentsUnder(userId: string, list: Thread[]): Map<string, ListedSubagent[]> {
    const under = new Map<string, ListedSubagent[]>();
    const found = subagents?.ofParents(list.map((thread) => thread.id)) ?? [];
    if (found.length === 0) return under;
    const childThreads = found.flatMap(({ record }) => threads.find(record.threadId) ?? []);
    const items = new Map(
      itemsOf(
        userId,
        childThreads,
        runs.activeIn(childThreads.map((thread) => thread.id)),
        false,
      ).map((item) => [item.id, item]),
    );
    for (const { record, summary } of found) {
      const item = items.get(record.threadId);
      if (!item) continue;
      const listed = under.get(record.parentThreadId) ?? [];
      listed.push({
        ...summary,
        // A subagent goes by its label, whatever its thread is called.
        title: record.name,
        untitled: false,
        updatedAt: item.updatedAt,
        shownModel: item.shownModel,
        participants: item.participants,
        activity: item.activity,
        status: item.status,
      });
      under.set(record.parentThreadId, listed);
    }
    return under;
  }

  // The threads as the reader's lists show them: each with its model, who has written in it, what
  // it holds for them, and its subagents.
  function itemsOf(userId: string, list: Thread[], active: Run[], nested = true): ThreadListItem[] {
    const ids = list.map((thread) => thread.id);
    const shownModel = shownModelOf();
    const facts = threads.facts(ids);
    const writers = threads.writers(ids);
    const seen = reads.seen(userId, ids);
    const runOf = new Map(active.map((run) => [run.threadId, run]));
    const under = nested ? subagentsUnder(userId, list) : new Map<string, ListedSubagent[]>();
    return list.map((thread) => {
      // Nobody is expected to read a subagent's thread, so nothing in it is ever new to them.
      const fact = thread.parentThreadId
        ? { ...facts.get(thread.id), notable: null }
        : facts.get(thread.id);
      const activity: ThreadActivity = {
        ...runActivity(userId, thread, runOf.get(thread.id)),
        lastNotableSeq: fact?.notable?.seq ?? 0,
        lastNotableBy: fact?.notable?.by ?? null,
        failed: fact?.failed ?? null,
        lastSeenSeq: seen.get(thread.id) ?? 0,
      };
      const subagentsOf = under.get(thread.id);
      const status = statusOf(activity, userId);
      return {
        ...threadSummary(thread),
        shownModel: shownModel(thread),
        participants: participantsOf(writers.get(thread.id)),
        activity,
        status: subagentsOf ? withSubagents(status, subagentsOf) : status,
        ...(subagentsOf && { subagents: subagentsOf }),
      };
    });
  }

  // How the reader comes to the thread, when they can read it and its space is not archived.
  function listedAccess(principal: Principal, thread: Thread) {
    const via = access.of(principal, thread);
    return via && !spaces.isArchived(thread.spaceId) ? via : null;
  }

  // The thread as the reader's inbox tells it, or null when it is not in their inbox. A subagent's
  // thread is told as the thread its subagents are listed under.
  function inboxItem(principal: Principal, id: string): InboxItem | null {
    const found = threads.find(id);
    const thread = found?.rootThreadId ? threads.find(found.rootThreadId) : found;
    id = thread?.id ?? id;
    const via = thread && listedAccess(principal, thread);
    if (!thread || !via) return null;
    const [item] = itemsOf(principal.userId, [thread], runs.activeIn([id]));
    return { kind: "thread", thread: item!, shared: via.via === "guest" };
  }

  // Whether the principal may still read the thread.
  function readable(principal: Principal, id: string) {
    const thread = threads.find(id);
    return !!thread && access.can(principal, thread, "read");
  }

  // The thread when the principal may take the action in it.
  function visible(principal: Principal, id: string, action: ThreadAction = "read"): Thread {
    return access.require(principal, id, action).thread;
  }

  // Whether the thread is a retired subagent's, which nobody posts in.
  function retired(thread: Thread) {
    return !!thread.parentThreadId && !!subagents?.find(thread.id)?.archivedAt;
  }

  function canIn(principal: Principal, thread: Thread): ThreadCan {
    return {
      post: access.can(principal, thread, "post") && !retired(thread),
      arrange: access.can(principal, thread, "arrange"),
      share: access.can(principal, thread, "share"),
    };
  }

  function readerOf(principal: Principal, thread: Thread): Reader {
    const space = spaceStore.find(thread.spaceId);
    return {
      principal,
      userId: principal.userId,
      thread,
      space,
      model: runs.active(thread.id)?.model ?? null,
      can: canIn(principal, thread),
      names: tools.namesIn(space),
      folds: new Map(),
    };
  }

  // The row at `index` as the reader sees it: with its place, the last event that changed it, its
  // turn, for a call what its tool is called, and what they may do from it. A call waiting for a decision says what they may decide,
  // none while it waits on others, under the risk its tool's policy gives it now, with their own
  // connection for a call that would run with it, and nobody else's; one waiting for answers, whether
  // they may give them; and the last row of a run that failed or was stopped, whether they may try
  // it again, which they may while nothing else runs or waits to.
  function shownRow(
    fold: TranscriptFold,
    transcript: Transcript,
    index: number,
    reader: Reader,
  ): ShownRow {
    const row = transcript.rows[index]!;
    const place = { order: index, seq: fold.changedAt(index), turn: fold.turnAt(index) };
    const { space, userId, thread, model } = reader;
    if (row.kind === "tool") {
      const started = startedSubagent(row);
      const subagent = started ? subagents?.summaryOf(started) : null;
      const subagentCall = subagent?.needs && waitingIn(subagent.threadId, reader.principal);
      const effects = effectsOf(row, reader);
      const call = {
        ...row,
        ...place,
        ...reader.names(row),
        ...(subagent && { subagent }),
        ...(subagentCall && { subagentCall }),
        ...(effects.length > 0 && { effects }),
      };
      if (row.state !== "pending" || !row.waits || !space) return call;
      const may = tools.canDecide(userId, row, transcript.rows, thread, space, model);
      // Where other agents' messages steered the call, whose words they carried.
      const steering =
        transcript.rows.some((other) => other.kind === "relay") &&
        steeringLine(
          transcript.rows,
          subagents?.find(thread.id)?.name ?? agentNameOf(space),
          agentNameOf(space),
        );
      const waiting = { ...call, ...(steering && { steering }) };
      if (tools.asks(row, space)) return { ...waiting, canAnswer: may };
      const risk = tools.riskForCall(row, space, model);
      const connection = tools.connectionFor(space, row.toolId, userId, row.input);
      const forNow = risk === "normal" ? (["allow_for_now"] as const) : [];
      return {
        ...waiting,
        risk,
        actions: may ? ["allow", ...forNow, "deny"] : [],
        ...(connection && { connection }),
      };
    }
    if (row.kind === "failure" || row.kind === "stop") {
      const last = index === transcript.rows.length - 1;
      const idle = !transcript.run && transcript.pending.length === 0;
      return { ...row, ...place, canRetry: last && idle && reader.can.post };
    }
    if (row.kind === "human") {
      const { command, ...message } = row;
      return { ...message, ...place, ...shownCommand(command) };
    }
    if (row.kind === "relay") {
      const { steeredBy: _steeredBy, call: _call, rowId, ...message } = row;
      const sentBy = sentByOf(row, reader);
      const source =
        rowId && readable(reader.principal, row.from.threadId)
          ? { threadId: row.from.threadId, rowId }
          : null;
      return { ...message, ...place, ...(sentBy && { sentBy }), ...(source && { source }) };
    }
    return { ...row, ...place };
  }

  // The messages subagent calls sent to each thread, by the call, as far as its log was read; each
  // read takes in only what was added since.
  const sentTo = new Map<string, { last: number; byCall: Map<string, string[]> }>();
  function messagesSentBy(threadId: string, call: Cause) {
    const known = sentTo.get(threadId) ?? { last: 0, byCall: new Map<string, string[]>() };
    for (const event of threads.eventsAfter(threadId, known.last)) {
      known.last = event.seq;
      const sent =
        event.type === "agent.message"
          ? event.data.call
          : event.type === "notification" && event.data.source.callId
            ? { threadId: event.data.source.threadId, callId: event.data.source.callId }
            : undefined;
      if (!sent) continue;
      const key = causeKey(sent);
      known.byCall.set(key, [...(known.byCall.get(key) ?? []), event.id]);
    }
    sentTo.set(threadId, known);
    return known.byCall.get(causeKey(call)) ?? [];
  }

  // Where the reader's thread's subagent call had its effect, in the threads they may read: the
  // task a start gave, each message a send delivered, and the thread a stop or archive acted on.
  function effectsOf(row: TranscriptToolRow, reader: Reader): CallEffect[] {
    if (!subagents || !row.output?.ok) return [];
    const tool = toolIdNow(row.toolId);
    const value = (row.output.value ?? {}) as { id?: unknown; name?: unknown; sent?: unknown };
    const call = { threadId: reader.thread.id, callId: row.id };
    const effects: CallEffect[] = [];
    if (SUBAGENT_ACTIONS.has(tool) && typeof value.id === "string") {
      const name = typeof value.name === "string" ? value.name : "";
      if (tool !== START_SUBAGENT) effects.push({ kind: "thread", threadId: value.id, name });
      for (const rowId of tool === START_SUBAGENT ? messagesSentBy(value.id, call) : []) {
        effects.push({ kind: "task", threadId: value.id, rowId, name });
      }
    } else if (tool === SEND_SUBAGENT_MESSAGE && Array.isArray(value.sent)) {
      const reach = subagents.reach(reader.thread.id);
      const agentName = reader.space ? agentNameOf(reader.space) : DEFAULT_AGENT_NAME;
      for (const label of value.sent) {
        for (const to of reach.filter((one) => one.name === label)) {
          for (const rowId of messagesSentBy(to.threadId, call)) {
            const name = to.main ? agentName : to.name;
            effects.push({ kind: "message", threadId: to.threadId, rowId, name });
          }
        }
      }
    }
    return effects.filter((effect) => readable(reader.principal, effect.threadId));
  }

  // The call that sent another agent's message, as the reader may follow it back: in a thread they
  // may read, named as its line there is.
  function sentByOf(row: RelayRow, reader: Reader) {
    const call = row.call;
    const thread = call && threads.find(call.threadId);
    if (!call || !thread || !access.can(reader.principal, thread, "read")) return null;
    const fold = reader.folds.get(thread.id) ?? transcripts.of(thread.id);
    reader.folds.set(thread.id, fold);
    const sending = fold.transcript().rows[fold.indexOf(call.callId)];
    if (sending?.kind !== "tool") return null;
    const { title, toolset } = reader.names(sending);
    return {
      threadId: thread.id,
      rowId: sending.id,
      title,
      toolset,
      thread: subagents?.find(thread.id)?.name ?? thread.title ?? UNTITLED,
    };
  }

  // The call the subagent's run waits on, as the reader sees it in the subagent's thread.
  function waitingIn(threadId: string, principal: Principal) {
    const thread = threads.find(threadId);
    if (!thread) return null;
    const fold = transcripts.of(threadId);
    const transcript = fold.transcript();
    const index = transcript.rows.findIndex((row) => row.id === transcript.run?.waitingOn);
    if (index === -1) return null;
    const shown = shownRow(fold, transcript, index, readerOf(principal, thread));
    return shown.kind === "tool" && shown.state === "pending" && shown.waits ? shown : null;
  }

  // The thread as the reader sees it, without its rows: what they may do in it, the defaults it
  // follows, and the model it names and the one that replies, which differ while the one it names
  // is turned off.
  async function headOf(principal: Principal, thread: Thread, via: Access): Promise<ThreadHead> {
    const space = spaceStore.find(thread.spaceId);
    const defaults = space ? models.defaults(space) : { model: null, effort: null };
    // The default that replies, with its effort.
    const following = space && (await models.replyModel(space, { model: null, effort: null }));
    const used = following?.used ? { used: following.used, effort: following.effort } : null;
    const subagent = subagentOf(principal, thread);
    return {
      ...(subagent && { subagent }),
      agentName: space ? agentNameOf(space) : DEFAULT_AGENT_NAME,
      thread: threadSummary(thread),
      access: via,
      archived: spaces.isArchived(thread.spaceId),
      can: canIn(principal, thread),
      levels: space ? tools.levelsFor(principal.userId, thread, space) : {},
      tools: space ? tools.definitions(space) : [],
      defaults: { ...defaults, used: used && { ...used.used, effort: used.effort } },
      // The thread's own org decides, whoever reads it.
      model: space
        ? await models.replyModel(space, { model: thread.model, effort: thread.effort })
        : null,
    };
  }

  // For a subagent's thread, the subagent as it is now and the thread that started it.
  function subagentOf(principal: Principal, thread: Thread) {
    const summary = thread.parentThreadId ? subagents?.summaryOf(thread.id) : null;
    if (!summary) return null;
    const parent = threads.find(thread.parentThreadId!);
    return {
      ...summary,
      parent: { id: thread.parentThreadId!, title: parent?.title ?? UNTITLED },
      canUnarchive: summary.state === "archived" && access.can(principal, thread, "post"),
    };
  }

  // Stores the message, with the command it was sent as. When it is not quiet and the agent is
  // idle, a run starts that takes it in; while a run is under way it waits to steer that run or to
  // start the next one, and an interrupt also asks the run under way to stop.
  function post(
    principal: Principal,
    thread: Thread,
    text: string,
    mode: Delivery,
    guest = false,
    command?: SentCommand,
  ) {
    if (retired(thread)) throw new ServiceError(409, "This subagent is archived");
    const quiet = !command && text.startsWith(QUIET_PREFIX);
    let first = false;
    const { events } = log.write(thread.id, (append) => {
      first = threads.find(thread.id)?.title === null;
      const message = append(
        {
          type: "message",
          actor: { kind: "user", userId: principal.userId },
          data: {
            parts: [{ type: "text", text }],
            quiet,
            mode,
            ...(guest && { guest }),
            ...(command && { command }),
          },
        },
        // Names the thread when nothing has yet.
        titleFrom(text),
      );
      // The author has seen what they answered.
      reads.mark(principal.userId, thread.id, message.seq, now());
      if (quiet) return;
      if (!runs.active(thread.id)) {
        startRun(
          runs,
          append,
          { threadId: thread.id, triggerSeq: message.seq, createdBy: principal.userId },
          [message.id],
        );
      } else if (mode === "interrupt") {
        stopRun(thread.id, principal.userId);
      }
    });
    if (!quiet) bus.wake(thread.id);
    if (first) void titles?.name(principal.orgId, thread.id, text);
    return events[0]!;
  }

  // Appends the author's change to one of their messages the agent has not taken in yet.
  function changePending(
    principal: Principal,
    id: string,
    messageId: string,
    change: (append: Append, message: PendingMessage) => void,
  ) {
    const thread = visible(principal, id, "post");
    const { events } = log.write(thread.id, (append) => {
      const pending = transcripts.of(thread.id).transcript().pending;
      const message = pending.find((m) => m.id === messageId);
      if (!message) throw new ServiceError(409, "The agent has already taken this message in");
      if (message.author.userId !== principal.userId) {
        throw new ServiceError(403, "Only its author can change a message");
      }
      change(append, message);
    });
    bus.wake(thread.id);
    return events[0]!;
  }

  // The space's threads, each with who has written in it.
  function listIn(principal: Principal, spaceId: string): ThreadListItem[] {
    spaces.require(principal, spaceId);
    return itemsOf(principal.userId, threads.listInSpace(spaceId), runs.activeInSpace(spaceId));
  }

  // The threads the principal is a guest in, as their lists show them, with their spaces' and orgs'
  // names.
  function sharedItems(principal: Principal, shared: GuestThread[]): SharedThread[] {
    const items = itemsOf(
      principal.userId,
      shared.map(({ thread }) => thread),
      runs.activeIn(shared.map(({ thread }) => thread.id)),
    );
    return shared.map((shared, index) => {
      const { shownModel, participants, activity, status } = items[index]!;
      return {
        ...threadSummary(shared.thread),
        spaceName: shared.spaceName,
        orgName: shared.orgName,
        place: shared.spaceNamedForOrg
          ? shared.spaceName
          : `${shared.spaceName} · ${shared.orgName}`,
        accessUntil: shared.accessUntil?.toISOString() ?? null,
        shownModel,
        participants,
        activity,
        status,
      };
    });
  }

  // Those of a list's threads, each with whether its run waits and whether it failed since the
  // reader looked, that the page asks for, and how many match in all. Whether the reader may decide
  // on a waiting run, which makes it need them, is worked out here, for the few that wait.
  function pageOfListed<T extends ListedThread>(
    userId: string,
    params: PageParams & { show?: ThreadShow },
    read: (filter: ThreadListFilter, window?: ListWindow) => Listed<T>,
  ): Listed<T> {
    const window = { limit: params.limit, offset: params.offset ?? 0 };
    const text = params.q;
    if (params.show !== "needs-you") {
      return read({ ...(text && { text }), ...(params.show && { show: params.show }) }, window);
    }
    const { rows } = read({ ...(text && { text }), show: "maybe-needs-you" });
    const asking = rows.filter((row) => row.waiting && !row.failed).map((row) => row.thread);
    const yours = new Set(
      itemsOf(userId, asking, runs.activeIn(asking.map((thread) => thread.id)))
        .filter((item) => item.status === "waiting")
        .map((item) => item.id),
    );
    const needing = rows.filter((row) => row.failed || yours.has(row.thread.id));
    return {
      rows: needing.slice(window.offset, window.offset + window.limit),
      total: needing.length,
    };
  }

  return {
    visible,

    list: listIn,

    // A page of the space's threads, by when they were last active, narrowed to those whose title
    // or newest message contains the text, and to those the reader's status shows.
    listPage(
      principal: Principal,
      spaceId: string,
      params: PageParams & { show?: ThreadShow },
    ): Page<ThreadListItem> {
      spaces.require(principal, spaceId);
      const { rows, total } = pageOfListed(principal.userId, params, (filter, window) =>
        threads.listed(principal.userId, spaceId, filter, window),
      );
      const list = rows.map((row) => row.thread);
      return {
        items: itemsOf(principal.userId, list, runs.activeIn(list.map((thread) => thread.id))),
        nextCursor: null,
        total,
      };
    },

    // The space's threads for the reader's sidebar: the newest few, with those that need the
    // reader; how many the space holds; and how many need the reader in all.
    sidebar(principal: Principal, spaceId: string): ThreadSidebar {
      spaces.require(principal, spaceId);
      const { rows, total, failed } = threads.sidebar(principal.userId, spaceId, SIDEBAR_LIMIT);
      const list = rows.map((row) => row.thread);
      const items = itemsOf(principal.userId, list, runs.activeIn(list.map((thread) => thread.id)));
      const waitingOnYou = items.filter((item) => item.status === "waiting").length;
      return { threads: items, total, needsYou: failed + waitingOnYou };
    },

    // Threads whose titles contain the text, ignoring case, untitled ones as "Untitled", every one
    // without text, in every space the principal can see and among those they are a guest in: the
    // most recently active first, at most 200, each with the model it shows and what it holds for
    // them.
    search(principal: Principal, text: string): ThreadSearchResult[] {
      const names = new Map(
        spaces
          .list(principal)
          .filter((space) => !space.archived && spaces.canSee(principal, space))
          .map((space) => [space.id, space.name]),
      );
      const needle = text.toLowerCase();
      const shared = guests
        .threadsOf(principal.userId, now())
        .filter(({ thread }) => !names.has(thread.spaceId))
        .filter(({ thread }) => !spaces.isArchived(thread.spaceId))
        .filter(({ thread }) => (thread.title ?? UNTITLED).toLowerCase().includes(needle))
        .map(({ thread, spaceName }) => ({ thread, spaceName, shared: true }));
      const found = [
        ...threads
          .search([...names.keys()], text, SEARCH_LIMIT, UNTITLED)
          .map((thread) => ({ thread, spaceName: names.get(thread.spaceId) ?? "", shared: false })),
        ...shared,
      ]
        .toSorted(
          (a, b) =>
            b.thread.updatedAt.getTime() - a.thread.updatedAt.getTime() ||
            b.thread.id.localeCompare(a.thread.id),
        )
        .slice(0, SEARCH_LIMIT);
      const list = found.map(({ thread }) => thread);
      const items = itemsOf(principal.userId, list, runs.activeIn(list.map(({ id }) => id)));
      return found.map(({ thread, spaceName, shared }, index) => ({
        ...threadSummary(thread),
        spaceName,
        shared,
        shownModel: items[index]!.shownModel,
        activity: items[index]!.activity,
        status: items[index]!.status,
      }));
    },

    // The threads the principal is a guest in, most recently active first.
    shared(principal: Principal): SharedThread[] {
      return sharedItems(principal, guests.threadsOf(principal.userId, now()));
    },

    // A page of the threads the principal is a guest in, narrowed to those whose title or place
    // contains the text, and to those their status shows.
    sharedPage(
      principal: Principal,
      params: PageParams & { show?: ThreadShow },
    ): Page<SharedThread> {
      const { rows, total } = pageOfListed(principal.userId, params, (filter, window) =>
        guests.sharedListed(principal.userId, now(), filter, window),
      );
      return { items: sharedItems(principal, rows), nextCursor: null, total };
    },

    // Starts a thread on the model and effort chosen for it, or those its space's defaults, then
    // its org's, give at this moment, so later changes to them leave it be; with its first message
    // when there is one. A chosen model must be one the org can use.
    async create(
      principal: Principal,
      spaceId: string,
      input: { text?: string; model?: string; effort?: Effort } = {},
    ) {
      const { text } = input;
      spaces.require(principal, spaceId, "message");
      if (input.model) await models.requireModel(principal.orgId, input.model);
      // Seen again after the model check, which waits on providers.
      const space = spaces.require(principal, spaceId, "message");
      const defaults = models.defaults(space);
      const thread = threads.create({
        spaceId,
        model: input.model ?? defaults.model,
        effort: input.effort ?? defaults.effort,
        createdBy: principal.userId,
      });
      if (text) post(principal, thread, text, "steer");
      return threadSummary(threads.find(thread.id) ?? thread);
    },

    // The thread as the reader sees it, with its newest rows, reaching back to the first they had
    // not seen, the messages waiting for the agent and the run under way.
    async get(principal: Principal, id: string): Promise<ThreadDetail> {
      const { thread, access: via } = access.require(principal, id);
      const head = await headOf(principal, thread, via);
      // Read after the models, which wait on providers, so the rows are the newest.
      const fold = transcripts.of(id);
      const transcript = fold.transcript();
      const reader = readerOf(principal, threads.find(id) ?? thread);
      const seen = reads.seen(principal.userId, [id]).get(id) ?? 0;
      // A subagent's thread has nothing new in it, and opens at its newest.
      const from = thread.parentThreadId ? -1 : newFromOf(transcript, seen, principal.userId);
      const total = transcript.rows.length;
      const start = Math.min(Math.max(0, total - ROWS_PAGE), from === -1 ? total : from);
      const rows = [];
      for (let index = start; index < total; index++) {
        rows.push(shownRow(fold, transcript, index, reader));
      }
      return {
        ...head,
        thread: { ...head.thread, lastEventSeq: Math.max(head.thread.lastEventSeq, fold.last) },
        rows,
        before: start > 0 ? start : null,
        newFrom: from === -1 ? null : transcript.rows[from]!.id,
        pending: shownPending(transcript.pending),
        run: shownRun(transcript),
      };
    },

    // The rows before the place `before`, at most `limit` of them, or with `at` as many as reach
    // back to the row with that id when it is before them, as the reader sees them.
    rows(
      principal: Principal,
      id: string,
      before: number,
      limit = ROWS_PAGE,
      at?: string,
    ): RowsPage {
      const thread = visible(principal, id);
      const fold = transcripts.of(id);
      const transcript = fold.transcript();
      const reader = readerOf(principal, thread);
      const end = Math.min(before, transcript.rows.length);
      const target = at === undefined ? -1 : fold.indexOf(at);
      const start = Math.max(0, Math.min(end - limit, target === -1 ? end : target));
      const rows = [];
      for (let index = start; index < end; index++) {
        rows.push(shownRow(fold, transcript, index, reader));
      }
      return { rows, before: start > 0 ? start : null };
    },

    readable,

    async update(
      principal: Principal,
      id: string,
      changes: {
        title?: string;
        model?: string | null;
        effort?: Effort | null;
      },
    ) {
      visible(principal, id, "arrange");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      visible(principal, id, "arrange");
      const updated = threads.update(id, {
        ...changes,
        ...(changes.title !== undefined && { titleSource: "person" as const }),
      });
      bus.activity({ threadId: id });
      return threadSummary(updated);
    },

    // Moves the thread to another space of the org where the principal can post; its events and
    // guests go with it.
    move(principal: Principal, id: string, spaceId: string) {
      const thread = visible(principal, id, "move");
      if (thread.spaceId === spaceId) throw new ServiceError(409, "The thread is already there");
      spaces.require(principal, spaceId, "message");
      if (thread.parentThreadId)
        throw new ServiceError(409, "A subagent's thread moves with its own");
      const children = threads.children(id);
      if ([id, ...children.map((child) => child.id)].some((one) => runs.active(one))) {
        throw new ServiceError(409, "Stop the agent before moving this thread");
      }
      const moved = threads.update(id, { spaceId });
      for (const child of children) threads.update(child.id, { spaceId });
      bus.activity({ threadId: id });
      return threadSummary(moved);
    },

    // Its events go with it.
    remove(principal: Principal, id: string) {
      const thread = visible(principal, id, "delete");
      const guestIds = guests.activeIn(id, now()).map((guest) => guest.userId);
      threads.delete(id);
      bus.activity({ threadId: id, gone: { spaceId: thread.spaceId, guests: guestIds } });
    },

    // Records the reader saw the thread up to `seq`, at most its newest event, never moving back,
    // and tells their inboxes.
    markRead(principal: Principal, id: string, seq: number) {
      const thread = visible(principal, id);
      const seen = reads.mark(principal.userId, id, Math.min(seq, thread.lastEventSeq), now());
      bus.activity({ threadId: id, read: { userId: principal.userId, seq: seen } });
      return { seq: seen };
    },

    // Delivers what changes for the principal in the threads they can read: each such thread as it
    // now reads for them, a few at a time, how far they saw a thread, then that thread again with the
    // status it now has for them, and each thread they can no
    // longer read, deleted, with their access ended or in a space now archived. `recheck` finds the
    // threads they lost without anything happening in them. Returns the function that stops it.
    inbox(principal: Principal, deliver: (item: InboxItem) => void) {
      // The threads they could read when last looked at; their shared ones from the start.
      const known = new Set(
        guests.threadsOf(principal.userId, now()).map(({ thread }) => thread.id),
      );
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      function flush() {
        timer = undefined;
        for (const id of pending) {
          const item = inboxItem(principal, id);
          if (item) {
            known.add(id);
            deliver(item);
          } else if (known.delete(id)) {
            deliver({ kind: "gone", threadId: id });
          }
        }
        pending.clear();
      }
      const unsubscribe = bus.onActivity((change) => {
        const { threadId, read, gone } = change;
        if (read) {
          if (read.userId !== principal.userId) return;
          deliver({ kind: "read", threadId, seq: read.seq });
          // Its status for them follows from how far they saw it.
          pending.add(threadId);
          timer ??= setTimeout(flush, INBOX_DELAY_MS);
          return;
        }
        if (gone) {
          pending.delete(threadId);
          const had =
            known.delete(threadId) ||
            gone.guests.includes(principal.userId) ||
            !!spaces.findVisible(principal, gone.spaceId);
          if (had) deliver({ kind: "gone", threadId });
          return;
        }
        pending.add(threadId);
        // Changes that come together, as a run's steps do, are told once.
        timer ??= setTimeout(flush, INBOX_DELAY_MS);
      });
      return {
        stop() {
          unsubscribe();
          clearTimeout(timer);
        },
        recheck() {
          for (const id of known) {
            const thread = threads.find(id);
            if (thread && listedAccess(principal, thread)) continue;
            known.delete(id);
            deliver({ kind: "gone", threadId: id });
          }
        },
      };
    },

    // The commands the reader may send in the thread; none for those who may not post.
    commands(principal: Principal, id: string): ThreadCommand[] {
      const thread = visible(principal, id);
      const space = spaceStore.find(thread.spaceId);
      if (!space || !access.can(principal, thread, "post")) return [];
      const others = (commands?.list(space, principal.userId) ?? []).filter(
        (command) => command.name !== COMPACT,
      );
      return [COMPACT_COMMAND, ...others];
    },

    postMessage(principal: Principal, id: string, text: string, mode: Delivery = "steer") {
      const { thread, access: via } = access.require(principal, id, "post");
      return post(principal, thread, text, mode, via.via === "guest");
    },

    // Posts the message as the command it starts with, kept with what the agent reads for it; one
    // naming a command the thread does not have is refused.
    async postCommand(
      principal: Principal,
      id: string,
      text: string,
      mode: Delivery,
      command: CommandInput,
    ) {
      const { thread, access: via } = access.require(principal, id, "post");
      if (command.name === COMPACT) {
        // Compacting waits for the run under way; with nothing to summarise it is not asked for.
        const rows = transcripts.of(thread.id).transcript().rows;
        if (!runs.active(thread.id) && !anythingToCompact(rows)) {
          throw new ServiceError(409, "There is nothing to compact yet");
        }
        const delivery = mode === "steer" ? "queue" : mode;
        return post(principal, thread, text, delivery, via.via === "guest", command);
      }
      const space = spaceStore.find(thread.spaceId);
      const expanded =
        space && commands ? await commands.expand(space, principal.userId, command, text) : null;
      if (expanded === null) throw new ServiceError(400, `There is no /${command.name} here`);
      // Seen again after the command, which may wait on an MCP server.
      const again = access.require(principal, id, "post");
      return post(principal, again.thread, text, mode, again.access.via === "guest", {
        ...command,
        text: expanded,
      });
    },

    // Changes the text of a waiting message, or whether it steers or waits for the next run.
    changeMessage(
      principal: Principal,
      id: string,
      messageId: string,
      change: { text?: string; mode?: "steer" | "queue" },
    ) {
      return changePending(principal, id, messageId, (append, message) => {
        if (change.text !== undefined && message.command) {
          throw new ServiceError(409, "A command can't be edited; remove it and send it again");
        }
        append({
          type: "message.changed",
          actor: { kind: "user", userId: principal.userId },
          data: {
            messageId,
            ...(change.text !== undefined && { parts: [{ type: "text", text: change.text }] }),
            ...(change.mode && { mode: change.mode }),
          },
        });
      });
    },

    // Takes back a waiting message.
    withdrawMessage(principal: Principal, id: string, messageId: string) {
      return changePending(principal, id, messageId, (append) =>
        append({
          type: "message.withdrawn",
          actor: { kind: "user", userId: principal.userId },
          data: { messageId },
        }),
      );
    },

    // Asks the run under way to stop, and those of the subagents the agent started; the agent keeps
    // what it has written.
    stop(principal: Principal, id: string) {
      const thread = visible(principal, id, "post");
      const own = !!stopRun(thread.id, principal.userId);
      const theirs = subagents?.stopAll(thread.id, principal.userId) ?? false;
      if (!own && !theirs) {
        throw new ServiceError(409, "The agent is not replying");
      }
      bus.wake(thread.id);
      bus.activity({ threadId: thread.id });
    },

    // Brings a retired subagent back, for someone who can post in its thread.
    unarchive(principal: Principal, id: string) {
      const thread = visible(principal, id, "post");
      if (!thread.parentThreadId || !subagents) throw new ServiceError(404, "Subagent not found");
      subagents.unarchive(thread.id);
    },

    // Starts a run that tries the thread's last run again, when it failed or was stopped and
    // nothing has run since.
    retry(principal: Principal, id: string, runId: string) {
      const thread = visible(principal, id, "post");
      const { events } = log.write(thread.id, (append) => {
        if (runs.active(thread.id)) throw new ServiceError(409, "The agent is already replying");
        const last = runs.latest(thread.id);
        if (last?.id !== runId || (last.status !== "failed" && last.status !== "cancelled")) {
          throw new ServiceError(409, "Only the last reply can be tried again");
        }
        startRun(runs, append, {
          threadId: thread.id,
          triggerSeq: last.triggerSeq,
          createdBy: principal.userId,
          continuesRunId: last.id,
          reason: "retry",
        });
      });
      bus.wake(thread.id);
      return events[0]!;
    },

    // Delivers, as the reader sees them, the rows events with seq above `after` changed, then the
    // pieces stored so far of the replies in progress, then the rows each new event changes and
    // each piece as it is stored, each exactly once. With the rows go the waiting messages and the
    // run, and any row whose parts that are the reader's changed while the row did not, as when
    // someone else writes and a call can no longer be allowed for now. The thread itself is
    // delivered again once it is renamed, moved or set to another model. Listening starts before
    // the stored ones are read, so none falls between the two. Returns the function that stops it.
    follow(
      principal: Principal,
      id: string,
      after: number,
      deliver: (item: ThreadFollowItem) => void,
    ): () => void {
      const first = visible(principal, id);
      const release = transcripts.hold(id);
      let stopped = false;
      let last = after;
      // The reader's parts of each live row as last delivered, by row id.
      const told = new Map<string, string>();
      // The next piece number to send, by reply.
      const pieces = new Map<string, number>();
      let replaying = true;
      const held: ThreadFeedItem[] = [];
      function sendRows() {
        const thread = threads.find(id);
        if (!thread) return;
        const fold = transcripts.of(id);
        const transcript = fold.transcript();
        const reader = readerOf(principal, thread);
        const live = liveIndexes(transcript);
        const rows: ShownRow[] = [];
        transcript.rows.forEach((row, index) => {
          const changed = fold.changedAt(index) > last;
          if (!changed && !live.has(index) && !told.has(row.id)) return;
          const shown = shownRow(fold, transcript, index, reader);
          const parts = readerPartsOf(shown);
          if (changed || told.get(row.id) !== parts) rows.push(shown);
          if (live.has(index)) told.set(row.id, parts);
          else told.delete(row.id);
        });
        if (fold.last <= last && rows.length === 0) return;
        last = Math.max(last, fold.last);
        const run = shownRun(transcript);
        const pending = shownPending(transcript.pending);
        deliver({ kind: "rows", update: { seq: last, rows, pending, run } });
      }
      function send(item: ThreadFeedItem) {
        if (item.kind === "event") {
          if (item.event.seq > last) sendRows();
          return;
        }
        const { messageId, index, texts } = item.delta;
        const sent = Math.max(0, (pieces.get(messageId) ?? 0) - index);
        if (sent >= texts.length) return;
        pieces.set(messageId, index + texts.length);
        deliver({
          kind: "delta",
          delta: { ...item.delta, index: index + sent, texts: texts.slice(sent) },
        });
      }
      // What the thread was named, set to and where it was, as last delivered.
      const placeOf = (thread: Thread) =>
        JSON.stringify([
          thread.title,
          thread.model,
          thread.effort,
          thread.spaceId,
          thread.parentThreadId && subagents?.summaryOf(thread.id),
        ]);
      let place = placeOf(first);
      const unsubscribe = bus.subscribe(id, (item) => {
        if (replaying) held.push(item);
        else send(item);
      });
      // The subagents started here, each of which shows where it stands on the line that started
      // it; a start writes here, so they are read again when this thread changes.
      const subagentsOf = () => new Set(threads.children(id).map((child) => child.id));
      let started = subagentsOf();
      const stopActivity = bus.onActivity((change) => {
        if (change.read || change.gone) return;
        if (change.threadId !== id) {
          if (started.has(change.threadId)) sendRows();
          return;
        }
        started = subagentsOf();
        const thread = threads.find(id);
        if (!thread || placeOf(thread) === place) return;
        place = placeOf(thread);
        const via = access.of(principal, thread);
        if (!via) return;
        void headOf(principal, thread, via).then(
          (head) => {
            if (!stopped) deliver({ kind: "thread", head });
          },
          () => {},
        );
      });
      sendRows();
      for (const delta of deltas.inThread(id)) send({ kind: "delta", delta });
      replaying = false;
      for (const item of held) send(item);
      return () => {
        stopped = true;
        unsubscribe();
        stopActivity();
        release();
      };
    },
  };
}

// Threads in the spaces a person can see: starting them, naming them after their first message,
// finding them by title, moving them between the space's folders, deleting them, posting messages
// to their event logs, reading them back with each event's author and following new events and
// reply pieces as they are stored. A message posted while the agent is idle wakes it at once; one
// posted while it is busy steers the run, waits for the next one, or interrupts the run, and its
// author can change it until the agent takes it in. Anyone who can post can stop the run, or try
// the last one again when it failed or was stopped; a run waiting for a decision on a tool call is
// queued again to be stopped. Lists say each thread's model and its provider, who has written in
// it and what it holds for the reader: what the agent is doing in it, whether they may decide on
// the call it waits for, its newest notable event, its last run's failure, and how far they have
// seen it, which reading it and posting in it move on. Each reader's inbox follows those changes
// for every thread they can read. Who may do each is the thread access rule's; a thread's guests
// find it, and post in it, beside the threads of their own spaces.

import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { GuestStore, GuestThread } from "@/server/guests/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import { type Run, type RunStore, startRun } from "@/server/agent/runs.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Folders } from "@/server/folders/service.ts";
import type { Tools } from "@/server/agent/tools.ts";
import type { Models } from "@/server/models/service.ts";
import type { ThreadAccess, ThreadAction } from "@/server/spaces/thread-access.ts";
import type { SharedThread } from "@/shared/guests.ts";
import type { Page, PageParams } from "@/shared/paging.ts";
import { plainText } from "@/shared/plain-text.ts";
import { statusOf, type ThreadShow } from "@/shared/thread-status.ts";
import {
  type Delivery,
  type Effort,
  QUIET_PREFIX,
  UNTITLED,
  type InboxItem,
  type ThreadActivity,
  type ThreadDetail,
  type ThreadFeedItem,
  type ThreadListItem,
  type ThreadParticipants,
  type ThreadSidebar,
  SIDEBAR_LIMIT,
  type ThreadSearchResult,
  type ThreadSummary,
  type ShownModel,
  type DeltaBatch,
  type EventDataMap,
} from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import type { Titles } from "./titles.ts";
import { type Append, eventSummary, type ThreadLog } from "./log.ts";

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
  // Threads in the spaces, and in the folder when one is given, whose titles contain the text,
  // ignoring case, most recently active first, at most `limit` of them.
  // Untitled threads match as `untitled`.
  search(
    spaceIds: string[],
    text: string,
    limit: number,
    untitled: string,
    folderId?: string,
  ): Thread[];
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
  folders: Pick<Folders, "requireIn">;
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
  // The agent's tools, for each reader's level for them.
  tools: Pick<Tools, "levelsFor" | "canDecide" | "riskForCall" | "definitions">;
  now?: () => Date;
}

export type Threads = ReturnType<typeof createThreads>;

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
    folderId: thread.folderId,
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
    folders,
    threads,
    runs,
    deltas,
    models,
    log,
    bus,
    titles,
    tools,
    reads,
  } = options;
  const now = options.now ?? (() => new Date());

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
    const transcript = transcriptOf(threads.eventsAfter(run.threadId, 0).map(eventSummary));
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

  // The threads as the reader's lists show them: each with its model, who has written in it, and
  // what it holds for them.
  function itemsOf(userId: string, list: Thread[], active: Run[]): ThreadListItem[] {
    const ids = list.map((thread) => thread.id);
    const shownModel = shownModelOf();
    const facts = threads.facts(ids);
    const writers = threads.writers(ids);
    const seen = reads.seen(userId, ids);
    const runOf = new Map(active.map((run) => [run.threadId, run]));
    return list.map((thread) => {
      const fact = facts.get(thread.id);
      const activity: ThreadActivity = {
        ...runActivity(userId, thread, runOf.get(thread.id)),
        lastNotableSeq: fact?.notable?.seq ?? 0,
        lastNotableBy: fact?.notable?.by ?? null,
        failed: fact?.failed ?? null,
        lastSeenSeq: seen.get(thread.id) ?? 0,
      };
      return {
        ...threadSummary(thread),
        shownModel: shownModel(thread),
        participants: participantsOf(writers.get(thread.id)),
        activity,
      };
    });
  }

  // The thread as the reader's inbox tells it, or null when they cannot read it.
  function inboxItem(principal: Principal, id: string): InboxItem | null {
    const thread = threads.find(id);
    const via = thread && access.of(principal, thread);
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

  // Stores the message. When it is not quiet and the agent is idle, a run starts that takes it in;
  // while a run is under way it waits to steer that run or to start the next one, and an interrupt
  // also asks the run under way to stop.
  function post(principal: Principal, thread: Thread, text: string, mode: Delivery, guest = false) {
    const quiet = text.startsWith(QUIET_PREFIX);
    let first = false;
    const { events } = log.write(thread.id, (append) => {
      first = threads.find(thread.id)?.title === null;
      const message = append(
        {
          type: "message",
          actor: { kind: "user", userId: principal.userId },
          data: { parts: [{ type: "text", text }], quiet, mode, ...(guest && { guest }) },
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
    change: (append: Append) => void,
  ) {
    const thread = visible(principal, id, "post");
    const { events } = log.write(thread.id, (append) => {
      const pending = transcriptOf(threads.eventsAfter(thread.id, 0).map(eventSummary)).pending;
      const message = pending.find((m) => m.id === messageId);
      if (!message) throw new ServiceError(409, "The agent has already taken this message in");
      if (message.author.userId !== principal.userId) {
        throw new ServiceError(403, "Only its author can change a message");
      }
      change(append);
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
      const { shownModel, participants, activity } = items[index]!;
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
        .filter((item) => statusOf(item.activity, userId) === "waiting")
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

    // A page of the space's threads, by when they were last active, narrowed to one folder, to
    // those whose title or newest message contains the text, and to those the reader's status shows.
    listPage(
      principal: Principal,
      spaceId: string,
      params: PageParams & { folder?: string; show?: ThreadShow },
    ): Page<ThreadListItem> {
      spaces.require(principal, spaceId);
      const { rows, total } = pageOfListed(principal.userId, params, (filter, window) =>
        threads.listed(
          principal.userId,
          spaceId,
          { ...filter, ...(params.folder && { folderId: params.folder }) },
          window,
        ),
      );
      const list = rows.map((row) => row.thread);
      return {
        items: itemsOf(principal.userId, list, runs.activeIn(list.map((thread) => thread.id))),
        nextCursor: null,
        total,
      };
    },

    // The space's threads for the reader's sidebar: the newest few of each folder and of the top of
    // the space, with those that say what each folder holds and those that need the reader; how
    // many each folder holds and the top of the space; and how many need the reader in all.
    sidebar(principal: Principal, spaceId: string): ThreadSidebar {
      spaces.require(principal, spaceId);
      const { rows, counts, failed } = threads.sidebar(principal.userId, spaceId, SIDEBAR_LIMIT);
      const list = rows.map((row) => row.thread);
      const items = itemsOf(principal.userId, list, runs.activeIn(list.map((thread) => thread.id)));
      const waitingOnYou = items.filter(
        (item) => statusOf(item.activity, principal.userId) === "waiting",
      ).length;
      const { null: loose = 0, ...folders } = Object.fromEntries(counts);
      return { threads: items, loose, folders, needsYou: failed + waitingOnYou };
    },

    // Threads whose titles contain the text, ignoring case, untitled ones as "Untitled", every one
    // without text, in every space the principal can see and among those they are a guest in, or
    // only in the folder given: the most recently active first, at most 200, each with the model it
    // shows and what it holds for them.
    search(principal: Principal, text: string, folderId?: string): ThreadSearchResult[] {
      const names = new Map(
        spaces
          .list(principal)
          .filter((space) => spaces.canSee(principal, space))
          .map((space) => [space.id, space.name]),
      );
      const needle = text.toLowerCase();
      const shared = folderId
        ? []
        : guests
            .threadsOf(principal.userId, now())
            .filter(({ thread }) => !names.has(thread.spaceId))
            .filter(({ thread }) => (thread.title ?? UNTITLED).toLowerCase().includes(needle))
            .map(({ thread, spaceName }) => ({ thread, spaceName, shared: true }));
      const found = [
        ...threads
          .search([...names.keys()], text, SEARCH_LIMIT, UNTITLED, folderId)
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
    // its org's, give at this moment, so later changes to them leave it be; in a folder or at the
    // top of the space, with its first message when there is one. A chosen model must be one the
    // org can use.
    async create(
      principal: Principal,
      spaceId: string,
      input: { text?: string; folderId?: string | null; model?: string; effort?: Effort } = {},
    ) {
      const { text, folderId = null } = input;
      spaces.require(principal, spaceId, "message");
      if (input.model) await models.requireModel(principal.orgId, input.model);
      // Seen again after the model check, which waits on providers.
      const space = spaces.require(principal, spaceId, "message");
      folders.requireIn(spaceId, folderId);
      const defaults = models.defaults(space);
      const thread = threads.create({
        spaceId,
        folderId,
        model: input.model ?? defaults.model,
        effort: input.effort ?? defaults.effort,
        createdBy: principal.userId,
      });
      if (text) post(principal, thread, text, "steer");
      return threadSummary(threads.find(thread.id) ?? thread);
    },

    // The thread with its events, how far the reader had seen it, the defaults it follows, and the
    // model it names and the one that replies, which differ while the one it names is turned off.
    async get(principal: Principal, id: string): Promise<ThreadDetail> {
      const { thread, access: via } = access.require(principal, id);
      const space = spaceStore.find(thread.spaceId);
      const defaults = space ? models.defaults(space) : { model: null, effort: null };
      // The default that replies, with its effort.
      const following = space && (await models.replyModel(space, { model: null, effort: null }));
      const used = following?.used ? { used: following.used, effort: following.effort } : null;
      const events = threads.eventsAfter(id, 0).map(eventSummary);
      const rows = transcriptOf(events).rows;
      const activeRun = runs.active(id);
      return {
        thread: threadSummary(thread),
        events,
        access: via,
        seenSeq: reads.seen(principal.userId, [id]).get(id) ?? 0,
        pendingTools: Object.fromEntries(
          rows.flatMap((row) =>
            row.kind === "tool" && row.state === "pending" && row.waits && space
              ? [
                  [
                    row.id,
                    {
                      risk: tools.riskForCall(row, space, activeRun?.model ?? null),
                      canDecide: tools.canDecide(
                        principal.userId,
                        row,
                        rows,
                        thread,
                        space,
                        activeRun?.model ?? null,
                      ),
                    },
                  ],
                ]
              : [],
          ),
        ),
        levels: space ? tools.levelsFor(principal.userId, thread, space) : {},
        tools: space ? tools.definitions(space) : [],
        defaults: { ...defaults, used: used && { ...used.used, effort: used.effort } },
        // The thread's own org decides, whoever reads it.
        model: space
          ? await models.replyModel(space, { model: thread.model, effort: thread.effort })
          : null,
      };
    },

    readable,

    // A folder it moves to must be in its space; null moves it to the top of the space.
    async update(
      principal: Principal,
      id: string,
      changes: {
        title?: string;
        model?: string | null;
        effort?: Effort | null;
        folderId?: string | null;
      },
    ) {
      visible(principal, id, "arrange");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      const thread = visible(principal, id, "arrange");
      if (changes.folderId !== undefined) folders.requireIn(thread.spaceId, changes.folderId);
      const updated = threads.update(id, {
        ...changes,
        ...(changes.title !== undefined && { titleSource: "person" as const }),
      });
      bus.activity({ threadId: id });
      return threadSummary(updated);
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
    // now reads for them, a few at a time, how far they saw a thread, and each thread they can no
    // longer read, deleted or with their access ended. `recheck` finds the threads they lost access
    // to without anything happening in them. Returns the function that stops it.
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
          if (read.userId === principal.userId) deliver({ kind: "read", threadId, seq: read.seq });
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
            if (readable(principal, id)) continue;
            known.delete(id);
            deliver({ kind: "gone", threadId: id });
          }
        },
      };
    },

    postMessage(principal: Principal, id: string, text: string, mode: Delivery = "steer") {
      const { thread, access: via } = access.require(principal, id, "post");
      return post(principal, thread, text, mode, via.via === "guest");
    },

    // Changes the text of a waiting message, or whether it steers or waits for the next run.
    changeMessage(
      principal: Principal,
      id: string,
      messageId: string,
      change: { text?: string; mode?: "steer" | "queue" },
    ) {
      return changePending(principal, id, messageId, (append) =>
        append({
          type: "message.changed",
          actor: { kind: "user", userId: principal.userId },
          data: {
            messageId,
            ...(change.text !== undefined && { parts: [{ type: "text", text: change.text }] }),
            ...(change.mode && { mode: change.mode }),
          },
        }),
      );
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

    // Asks the run under way to stop; the agent keeps what it has written.
    stop(principal: Principal, id: string) {
      const thread = visible(principal, id, "post");
      if (!stopRun(thread.id, principal.userId)) {
        throw new ServiceError(409, "The agent is not replying");
      }
      bus.wake(thread.id);
      bus.activity({ threadId: thread.id });
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

    // Delivers the thread's events with seq above `after` in order, then the pieces stored so far
    // of the replies in progress, then each new event and piece as it is stored, each exactly
    // once. Listening starts before the stored ones are read, so none falls between the two.
    // Returns the function that stops it.
    follow(
      principal: Principal,
      id: string,
      after: number,
      deliver: (item: ThreadFeedItem) => void,
    ): () => void {
      visible(principal, id);
      let last = after;
      // The next piece number to send, by reply.
      const pieces = new Map<string, number>();
      let replaying = true;
      const held: ThreadFeedItem[] = [];
      function send(item: ThreadFeedItem) {
        if (item.kind === "event") {
          if (item.event.seq <= last) return;
          last = item.event.seq;
          deliver(item);
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
      const unsubscribe = bus.subscribe(id, (item) => {
        if (replaying) held.push(item);
        else send(item);
      });
      for (const event of threads.eventsAfter(id, after)) {
        send({ kind: "event", event: eventSummary(event) });
      }
      for (const delta of deltas.inThread(id)) send({ kind: "delta", delta });
      replaying = false;
      for (const item of held) send(item);
      return unsubscribe;
    },
  };
}

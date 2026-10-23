// Threads in the spaces a person can see: starting them, naming them after their first message,
// finding them by title, moving them between the space's folders, deleting them, posting messages
// to their event logs, reading them back with each event's author and following new events and
// reply pieces as they are stored. A message posted while the agent is idle wakes it at once; one
// posted while it is busy steers the run, waits for the next one, or interrupts the run, and its
// author can change it until the agent takes it in. Anyone who can post can stop the run, or try
// the last one again when it failed or was stopped. Who may do each is the thread access rule's;
// a thread's guests find it, and post in it, beside the threads of their own spaces.

import type { DeltaStore } from "@/ports/deltas.ts";
import type { EventBus } from "@/ports/event-bus.ts";
import type { GuestStore } from "@/ports/guests.ts";
import type { Principal } from "@/ports/identity.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { SpaceStore } from "@/ports/spaces.ts";
import type { StoredEvent, Thread, ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Titles } from "@/services/titles.ts";
import type { Models } from "@/services/models.ts";
import { startRun } from "@/services/runs.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { ThreadAccess, ThreadAction } from "@/services/thread-access.ts";
import { type Append, eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import type { SharedThread } from "@/shared/guests.ts";
import {
  type Delivery,
  type Effort,
  QUIET_PREFIX,
  type ThreadDetail,
  type ThreadFeedItem,
  type ThreadListItem,
  type ThreadSearchResult,
  type ThreadSummary,
} from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";

export interface ThreadsOptions {
  spaces: Spaces;
  // Reads a thread's space for its defaults, whoever reads the thread.
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can" | "require">;
  guests: Pick<GuestStore, "threadsOf">;
  folders: Pick<Folders, "requireIn">;
  threads: ThreadStore;
  runs: Pick<RunStore, "active" | "create" | "latest" | "requestCancel">;
  deltas: Pick<DeltaStore, "inThread">;
  models: Pick<Models, "defaults" | "requireModel" | "replyModel">;
  log: ThreadLog;
  bus: EventBus;
  // Names threads after their first message, when given.
  titles?: Pick<Titles, "name">;
  now?: () => Date;
}

export type Threads = ReturnType<typeof createThreads>;

// What an untitled thread is called, and found by.
export const UNTITLED = "Untitled";
const TITLE_LENGTH = 60;
export const SEARCH_LIMIT = 50;

// Markdown as the text it shows: without code fences, heading, quote and list markers, emphasis
// and inline code marks, and with links and images as their text.
export function plainText(markdown: string) {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|~~|\*|`+)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|\W)(__|_)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3");
}

// A thread's title from its first message: its text without markdown, on one line, cut to about
// 60 characters.
export function titleFrom(text: string) {
  const line = plainText(text).replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const PREVIEW_LENGTH = 120;

// Who wrote a message or reply, by first name, and the start of its text on one line.
function previewOf(event: StoredEvent) {
  const parts =
    event.type === "message" || event.type === "message.completed"
      ? event.data.parts.filter((part) => part.type === "text")
      : [];
  const text = plainText(parts.map((part) => part.text).join(" "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_LENGTH);
  const author =
    event.actor.kind === "agent" ? "Agent" : (event.actorName ?? "(former member)").split(" ")[0]!;
  return { author, text };
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
  } = options;
  const now = options.now ?? (() => new Date());

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
      if (quiet) return;
      if (!runs.active(thread.id)) {
        startRun(
          runs,
          append,
          { threadId: thread.id, triggerSeq: message.seq, createdBy: principal.userId },
          [message.id],
        );
      } else if (mode === "interrupt") {
        runs.requestCancel(thread.id, principal.userId, new Date());
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

  return {
    visible,

    // The space's threads, each with the start of its newest message or reply.
    list(principal: Principal, spaceId: string): ThreadListItem[] {
      spaces.require(principal, spaceId);
      const previews = new Map(
        threads.lastMessagesInSpace(spaceId).map((event) => [event.threadId, previewOf(event)]),
      );
      return threads
        .listInSpace(spaceId)
        .map((thread) => ({ ...threadSummary(thread), preview: previews.get(thread.id) ?? null }));
    },

    // Threads whose titles contain the text, ignoring case, untitled ones as "Untitled", in every
    // space the principal can see and among those they are a guest in: the most recently active
    // first, at most 50.
    search(principal: Principal, text: string): ThreadSearchResult[] {
      const names = new Map(
        spaces
          .list(principal)
          .filter((space) => spaces.canSee(principal, space))
          .map((space) => [space.id, space.name]),
      );
      const needle = text.toLowerCase();
      const shared = guests
        .threadsOf(principal.userId, now())
        .filter(({ thread }) => !names.has(thread.spaceId))
        .filter(({ thread }) => (thread.title ?? UNTITLED).toLowerCase().includes(needle))
        .map(({ thread, spaceName }) => ({ thread, spaceName, shared: true }));
      return [
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
        .slice(0, SEARCH_LIMIT)
        .map(({ thread, spaceName, shared }) => ({ ...threadSummary(thread), spaceName, shared }));
    },

    // The threads the principal is a guest in, with their spaces' and orgs' names.
    shared(principal: Principal): SharedThread[] {
      return guests.threadsOf(principal.userId, now()).map((shared) => ({
        ...threadSummary(shared.thread),
        spaceName: shared.spaceName,
        orgName: shared.orgName,
        place: shared.spaceNamedForOrg
          ? shared.spaceName
          : `${shared.spaceName} · ${shared.orgName}`,
        accessUntil: shared.accessUntil?.toISOString() ?? null,
      }));
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

    // The thread with its events, the defaults it follows, and the model it names and the one that
    // replies, which differ while the one it names is turned off.
    async get(principal: Principal, id: string): Promise<ThreadDetail> {
      const { thread, access: via } = access.require(principal, id);
      const space = spaceStore.find(thread.spaceId);
      const defaults = space ? models.defaults(space) : { model: null, effort: null };
      // The default that replies, with its effort.
      const following = space && (await models.replyModel(space, { model: null, effort: null }));
      const used = following?.used ? { used: following.used, effort: following.effort } : null;
      return {
        thread: threadSummary(thread),
        events: threads.eventsAfter(id, 0).map(eventSummary),
        access: via,
        defaults: { ...defaults, used: used && { ...used.used, effort: used.effort } },
        // The thread's own org decides, whoever reads it.
        model: space
          ? await models.replyModel(space, { model: thread.model, effort: thread.effort })
          : null,
      };
    },

    // Whether the principal may still read the thread.
    readable(principal: Principal, id: string) {
      const thread = threads.find(id);
      return !!thread && access.can(principal, thread, "read");
    },

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
      return threadSummary(
        threads.update(id, {
          ...changes,
          ...(changes.title !== undefined && { titleSource: "person" as const }),
        }),
      );
    },

    // Its events go with it.
    remove(principal: Principal, id: string) {
      visible(principal, id, "delete");
      threads.delete(id);
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
      if (!runs.requestCancel(thread.id, principal.userId, new Date())) {
        throw new ServiceError(409, "The agent is not replying");
      }
      bus.wake(thread.id);
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

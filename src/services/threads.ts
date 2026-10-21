// Threads in the spaces a person can see: starting them, finding them by title, moving them
// between the space's folders, deleting them, posting messages to their event logs, reading them
// back with each event's author and following new events and reply pieces as they are stored. A
// message posted while the agent is idle wakes it at once; one posted while it is busy steers the
// run, waits for the next one, or interrupts the run, and its author can change it until the
// agent takes it in. Anyone who can post can stop the run, or try the last one again when it failed
// or was stopped.

import type { DeltaStore } from "@/ports/deltas.ts";
import type { EventBus } from "@/ports/event-bus.ts";
import type { Principal } from "@/ports/identity.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { Thread, ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Models } from "@/services/models.ts";
import { startRun } from "@/services/runs.ts";
import type { SpaceAction, Spaces } from "@/services/spaces.ts";
import { type Append, eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import {
  type Delivery,
  type Effort,
  QUIET_PREFIX,
  type ThreadFeedItem,
  type ThreadSearchResult,
  type ThreadSummary,
} from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";

export interface ThreadsOptions {
  spaces: Spaces;
  folders: Pick<Folders, "requireIn">;
  threads: ThreadStore;
  runs: Pick<RunStore, "active" | "create" | "latest" | "requestCancel">;
  deltas: Pick<DeltaStore, "inThread">;
  models: Pick<Models, "defaultModel" | "requireModel">;
  log: ThreadLog;
  bus: EventBus;
}

export type Threads = ReturnType<typeof createThreads>;

const UNTITLED = "New thread";
const TITLE_LENGTH = 60;
export const SEARCH_LIMIT = 50;

// A thread's title from its first message: the text on one line, cut to about 60 characters.
export function titleFrom(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function threadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    spaceId: thread.spaceId,
    folderId: thread.folderId,
    title: thread.title ?? UNTITLED,
    model: thread.model,
    effort: thread.effort,
    lastEventSeq: thread.lastEventSeq,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function createThreads(options: ThreadsOptions) {
  const { spaces, folders, threads, runs, deltas, models, log, bus } = options;

  // The thread when the principal may take the action in its space; one in a space they cannot
  // see is not found.
  function visible(principal: Principal, id: string, action: SpaceAction = "read"): Thread {
    const thread = threads.find(id);
    if (!thread || !spaces.findVisible(principal, thread.spaceId)) {
      throw new ServiceError(404, "Thread not found");
    }
    spaces.require(principal, thread.spaceId, action);
    return thread;
  }

  // Stores the message. When it is not quiet and the agent is idle, a run starts that takes it in;
  // while a run is under way it waits to steer that run or to start the next one, and an interrupt
  // also asks the run under way to stop.
  function post(principal: Principal, thread: Thread, text: string, mode: Delivery) {
    const quiet = text.startsWith(QUIET_PREFIX);
    const { events } = log.write(thread.id, (append) => {
      const message = append(
        {
          type: "message",
          actor: { kind: "user", userId: principal.userId },
          data: { parts: [{ type: "text", text }], quiet, mode },
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
    return events[0]!;
  }

  // Appends the author's change to one of their messages the agent has not taken in yet.
  function changePending(
    principal: Principal,
    id: string,
    messageId: string,
    change: (append: Append) => void,
  ) {
    const thread = visible(principal, id, "message");
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

    list(principal: Principal, spaceId: string) {
      spaces.require(principal, spaceId);
      return threads.listInSpace(spaceId).map(threadSummary);
    },

    // Threads whose titles contain the text, ignoring case, in every space the principal can see:
    // the most recently active first, at most 50.
    search(principal: Principal, text: string): ThreadSearchResult[] {
      const names = new Map(
        spaces
          .list(principal)
          .filter((space) => spaces.canSee(principal, space))
          .map((space) => [space.id, space.name]),
      );
      return threads.search([...names.keys()], text, SEARCH_LIMIT).map((thread) => ({
        ...threadSummary(thread),
        spaceName: names.get(thread.spaceId) ?? "",
      }));
    },

    // Starts a thread on the org's default model, in a folder or at the top of the space, with its
    // first message when there is one.
    create(
      principal: Principal,
      spaceId: string,
      input: { text?: string; folderId?: string | null } = {},
    ) {
      const { text, folderId = null } = input;
      spaces.require(principal, spaceId, "message");
      folders.requireIn(spaceId, folderId);
      const thread = threads.create({
        spaceId,
        folderId,
        model: models.defaultModel(principal.orgId),
        createdBy: principal.userId,
      });
      if (text) post(principal, thread, text, "steer");
      return threadSummary(threads.find(thread.id) ?? thread);
    },

    get(principal: Principal, id: string) {
      const thread = visible(principal, id);
      return {
        thread: threadSummary(thread),
        events: threads.eventsAfter(id, 0).map(eventSummary),
      };
    },

    // A folder it moves to must be in its space; null moves it to the top of the space.
    async update(
      principal: Principal,
      id: string,
      changes: {
        title?: string;
        model?: string;
        effort?: Effort | null;
        folderId?: string | null;
      },
    ) {
      visible(principal, id, "message");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      const thread = visible(principal, id, "message");
      if (changes.folderId !== undefined) folders.requireIn(thread.spaceId, changes.folderId);
      return threadSummary(threads.update(id, changes));
    },

    // Its events go with it.
    remove(principal: Principal, id: string) {
      visible(principal, id, "manage");
      threads.delete(id);
    },

    postMessage(principal: Principal, id: string, text: string, mode: Delivery = "steer") {
      return post(principal, visible(principal, id, "message"), text, mode);
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
      const thread = visible(principal, id, "message");
      if (!runs.requestCancel(thread.id, principal.userId, new Date())) {
        throw new ServiceError(409, "The agent is not replying");
      }
      bus.wake(thread.id);
    },

    // Starts a run that tries the thread's last run again, when it failed or was stopped and
    // nothing has run since.
    retry(principal: Principal, id: string, runId: string) {
      const thread = visible(principal, id, "message");
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

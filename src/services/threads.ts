// Threads in the spaces a person can see: starting them, finding them by title, moving them
// between the space's folders, deleting them, posting messages to their event logs, reading them
// back with each event's author and following new events as they are appended. A message posted
// while the agent is idle wakes it at once; one posted while it is busy waits for it.

import type { EventBus } from "@/ports/event-bus.ts";
import type { Principal } from "@/ports/identity.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { Thread, ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Models } from "@/services/models.ts";
import { startRun } from "@/services/runs.ts";
import type { SpaceAction, Spaces } from "@/services/spaces.ts";
import { eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import {
  QUIET_PREFIX,
  type ThreadEventSummary,
  type ThreadSearchResult,
  type ThreadSummary,
} from "@/shared/threads.ts";

export interface ThreadsOptions {
  spaces: Spaces;
  folders: Pick<Folders, "requireIn">;
  threads: ThreadStore;
  runs: Pick<RunStore, "active" | "create">;
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
    lastEventSeq: thread.lastEventSeq,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function createThreads(options: ThreadsOptions) {
  const { spaces, folders, threads, runs, models, log, bus } = options;

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

  // Stores the message; when it is not quiet and the agent is idle, starts a run that takes it in.
  function post(principal: Principal, thread: Thread, text: string) {
    const quiet = text.startsWith(QUIET_PREFIX);
    const { events } = log.write(thread.id, (append) => {
      const message = append(
        {
          type: "message",
          actor: { kind: "user", userId: principal.userId },
          data: { parts: [{ type: "text", text }], quiet },
        },
        // Names the thread when nothing has yet.
        titleFrom(text),
      );
      if (!quiet && !runs.active(thread.id)) {
        startRun(
          runs,
          append,
          { threadId: thread.id, triggerSeq: message.seq, createdBy: principal.userId },
          [message.id],
        );
      }
    });
    if (!quiet) bus.wake(thread.id);
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
      if (text) post(principal, thread, text);
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
      changes: { title?: string; model?: string; folderId?: string | null },
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

    postMessage(principal: Principal, id: string, text: string) {
      return post(principal, visible(principal, id, "message"), text);
    },

    // Delivers the thread's events with seq above `after` in order, then each new one as it is
    // appended, each exactly once. Listening starts before the stored events are read, so none
    // falls between the two. Returns the function that stops it.
    follow(
      principal: Principal,
      id: string,
      after: number,
      deliver: (event: ThreadEventSummary) => void,
    ): () => void {
      visible(principal, id);
      let last = after;
      let replaying = true;
      const held: ThreadEventSummary[] = [];
      function send(event: ThreadEventSummary) {
        if (event.seq <= last) return;
        last = event.seq;
        deliver(event);
      }
      const unsubscribe = bus.subscribe(id, (event) => {
        if (replaying) held.push(event);
        else send(event);
      });
      for (const event of threads.eventsAfter(id, after)) send(eventSummary(event));
      replaying = false;
      for (const event of held.toSorted((a, b) => a.seq - b.seq)) send(event);
      return unsubscribe;
    },
  };
}

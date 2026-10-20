// Threads in the spaces a person can see: starting them, moving them between the space's folders,
// deleting them, posting messages to their event logs, reading them back with each event's author
// and following new events as they are appended.

import type { EventBus } from "@/ports/event-bus.ts";
import type { Principal } from "@/ports/identity.ts";
import type { StoredEvent, Thread, ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { ThreadEventSummary, ThreadSummary } from "@/shared/threads.ts";

export interface ThreadsOptions {
  spaces: Spaces;
  folders: Pick<Folders, "requireIn">;
  threads: ThreadStore;
  models: Pick<Models, "defaultModel" | "requireModel">;
  bus: EventBus;
}

export type Threads = ReturnType<typeof createThreads>;

const UNTITLED = "New thread";
const TITLE_LENGTH = 60;
export const FORMER_MEMBER = "(former member)";

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

export function eventSummary(event: StoredEvent): ThreadEventSummary {
  const { id, threadId, seq, type, data, actor, actorName } = event;
  return {
    id,
    threadId,
    seq,
    type,
    data,
    actor:
      actor.kind === "user"
        ? { kind: "user", userId: actor.userId, name: actorName ?? FORMER_MEMBER }
        : actor,
    createdAt: event.createdAt.toISOString(),
  };
}

export function createThreads(options: ThreadsOptions) {
  const { spaces, folders, threads, models, bus } = options;

  // The thread when the principal can see its space; otherwise it is not found.
  function visible(principal: Principal, id: string): Thread {
    const thread = threads.find(id);
    if (!thread || !spaces.findVisible(principal, thread.spaceId)) {
      throw new ServiceError(404, "Thread not found");
    }
    return thread;
  }

  function post(principal: Principal, thread: Thread, text: string) {
    const event = threads.append(
      thread.id,
      {
        type: "message",
        actor: { kind: "user", userId: principal.userId },
        data: { parts: [{ type: "text", text }] },
      },
      // Names the thread when nothing has yet.
      titleFrom(text),
    );
    const summary = eventSummary(event);
    // Only once the event is stored.
    bus.publish(thread.id, summary);
    return summary;
  }

  return {
    visible,

    list(principal: Principal, spaceId: string) {
      spaces.visible(principal, spaceId);
      return threads.listInSpace(spaceId).map(threadSummary);
    },

    // Starts a thread on the org's default model, in a folder or at the top of the space, with its
    // first message when there is one.
    create(
      principal: Principal,
      spaceId: string,
      input: { text?: string; folderId?: string | null } = {},
    ) {
      const { text, folderId = null } = input;
      spaces.visible(principal, spaceId);
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
      visible(principal, id);
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      const thread = visible(principal, id);
      if (changes.folderId !== undefined) folders.requireIn(thread.spaceId, changes.folderId);
      return threadSummary(threads.update(id, changes));
    },

    // Its events go with it.
    remove(principal: Principal, id: string) {
      visible(principal, id);
      threads.delete(id);
    },

    postMessage(principal: Principal, id: string, text: string) {
      return post(principal, visible(principal, id), text);
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

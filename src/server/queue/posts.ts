// A person's posts in a thread: a message, or a message sent as one of the thread's commands, kept
// with what the agent reads for it. A message that is not quiet starts the agent when it is idle;
// while a run is under way it waits to steer that run or to start the next one, and an interrupt
// also asks the run under way to stop. A retired subagent's thread takes no posts, the first post
// names an untitled thread and brings the notices that open it ahead of it, and whoever hears of
// posts does so in the write that stores them.

import type { Reader, ThreadAccess } from "@/server/access/access.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space } from "@/server/spaces/service.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import { type Titles, titleFrom } from "@/server/threads/titles.ts";
import type { Thread, ThreadStore } from "@/server/threads/types.ts";
import { BTW, COMPACT, type CommandInput, RELOAD } from "@/shared/threads/commands.ts";
import { type Delivery, QUIET_PREFIX } from "@/shared/threads/events.ts";
import type { SentCommand } from "@/shared/transcript.ts";

import { type Notice, reloadNotice } from "./notices.ts";
import type { Queue } from "./queue.ts";

export interface PostsOptions {
  queue: Pick<Queue, "enqueue">;
  access: Pick<ThreadAccess, "require">;
  log: ThreadLog;
  threads: Pick<ThreadStore, "find" | "hasMessage" | "userName">;
  // Whether compacting the thread, asked for now, has something to do.
  compactable: (threadId: string) => Promise<boolean>;
  // Whether the thread is a retired subagent's, which nobody posts in.
  retired: (thread: Thread) => Promise<boolean>;
  // What the agent reads for a command of the space's, sent with the text typed; null for one the
  // space does not have.
  expand?: (
    space: Space,
    userId: string,
    command: CommandInput,
    text: string,
  ) => Promise<string | null>;
  // Names threads after their first message, when given.
  titles?: Pick<Titles, "name">;
}

// What hears of a person's post, in the write that stores it.
export type PostListener = (post: { by: string; threadId: string; seq: number }) => Promise<void>;

// A notice a thread's first message brings ahead of it, or none: read before the write that stores
// the message, and told in that write unless another message came first.
export type Opening = (thread: Thread) => Promise<Notice | null>;

export type Posts = ReturnType<typeof createPosts>;

export function createPosts(options: PostsOptions) {
  const { queue, access, log, threads, compactable, retired, expand, titles } = options;
  const listeners: PostListener[] = [];
  const openings: Opening[] = [];

  async function post(
    principal: Pick<Principal, "userId" | "orgId">,
    thread: Thread,
    text: string,
    mode: Delivery,
    guest: boolean,
    command?: SentCommand,
  ) {
    if (await retired(thread)) throw new ServiceError(409, "This subagent is archived");
    const quiet = !command && text.startsWith(QUIET_PREFIX);
    const opening = (await threads.hasMessage(thread.id)) ? [] : await openingsOf(thread);
    let first = false;
    const { result: event } = await log.write(thread.id, async () => {
      first = (await threads.find(thread.id))?.title === null;
      if (opening.length > 0 && !(await threads.hasMessage(thread.id))) {
        for (const notice of opening) await queue.enqueue(thread.id, { kind: "notice", notice });
      }
      const { event } = await queue.enqueue(
        thread.id,
        {
          kind: "message",
          by: principal.userId,
          text,
          delivery: mode,
          quiet,
          ...(guest && { guest }),
          ...(command && { command }),
        },
        // Names the thread when nothing has yet.
        { origin: { kind: "person", id: principal.userId }, title: titleFrom(text) },
      );
      for (const listener of listeners) {
        await listener({ by: principal.userId, threadId: thread.id, seq: event.seq });
      }
      return event;
    });
    if (first) void titles?.name(principal.orgId, thread.id, text);
    return event;
  }

  // Has the agent read its space's tools and instructions again, told in the thread without
  // starting it; a thread with nothing posted yet has nothing to reload.
  async function reload(principal: Pick<Principal, "userId">, thread: Thread) {
    if (await retired(thread)) throw new ServiceError(409, "This subagent is archived");
    if (!(await threads.hasMessage(thread.id))) {
      throw new ServiceError(409, "There is nothing to reload yet");
    }
    const name = (await threads.userName(principal.userId)) ?? "Someone";
    const notice = reloadNotice(thread.id, { userId: principal.userId, name });
    const origin = { kind: "person" as const, id: principal.userId };
    const { result } = await log.write(thread.id, async () => {
      const { event } = await queue.enqueue(thread.id, { kind: "notice", notice }, { origin });
      for (const listener of listeners) {
        await listener({ by: principal.userId, threadId: thread.id, seq: event.seq });
      }
      return event;
    });
    return result;
  }

  // The notices a thread's first message brings ahead of it, as they stand now.
  async function openingsOf(thread: Thread) {
    return (await Promise.all(openings.map(async (open) => open(thread)))).filter(
      (notice) => notice !== null,
    );
  }

  return {
    // Posts the message as the reader, who may post in the thread.
    async message(
      reader: Pick<Reader, "principal" | "thread" | "via">,
      text: string,
      delivery: Delivery = "steer",
    ) {
      return post(reader.principal, reader.thread, text, delivery, reader.via?.via === "guest");
    },

    // Posts the message as the command it starts with, kept with what the agent reads for it; one
    // naming a command the thread does not have is refused. Compacting waits for the run under
    // way, and with nothing to summarise is not asked for.
    async command(
      principal: Principal,
      threadId: string,
      text: string,
      delivery: Delivery,
      command: CommandInput,
    ) {
      const reader = await access.require(principal, threadId, "post");
      const { thread } = reader;
      if (command.name === BTW) throw new ServiceError(400, "A side question is never posted");
      if (command.name === RELOAD) return reload(principal, thread);
      if (command.name === COMPACT) {
        if (!(await compactable(thread.id))) {
          throw new ServiceError(409, "There is nothing to compact yet");
        }
        const mode = delivery === "steer" ? "queue" : delivery;
        return post(principal, thread, text, mode, reader.via?.via === "guest", command);
      }
      const expanded =
        reader.space && expand ? await expand(reader.space, principal.userId, command, text) : null;
      if (expanded === null) throw new ServiceError(400, `There is no /${command.name} here`);
      // Seen again after the command, which may wait on an MCP server.
      const again = await access.require(principal, threadId, "post");
      return post(principal, again.thread, text, delivery, again.via?.via === "guest", {
        ...command,
        text: expanded,
      });
    },

    // Hears of every post, inside the write that stores it.
    onPosted(listener: PostListener) {
      listeners.push(listener);
    },

    // Adds a notice threads' first messages bring ahead of them.
    opens(opening: Opening) {
      openings.push(opening);
    },

    // The notices a thread's first message brings ahead of it, as it would bring them now.
    openingsOf,
  };
}

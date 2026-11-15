// Threads in the spaces a person can see: starting them on a model, with a first message or none,
// renaming them and setting their model and effort, which the agent is told of, moving them
// between spaces of the org with their subagents', deleting them, and starting new ones from a row
// of a branch, copied or summarised. What a call gave back that its row left out is read here too.

import { someAsync } from "@/server/kernel/async.ts";
import { summarise, tokensOf } from "@/server/execution/compaction.ts";
import type { RunReads } from "@/server/execution/execution.ts";
import { silentChange } from "@/server/queue/notices.ts";
import type { Posts } from "@/server/queue/posts.ts";
import type { Queue } from "@/server/queue/queue.ts";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { Models } from "@/server/models/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import { type Spaces } from "@/server/spaces/service.ts";
import type { ThreadAccess, ThreadAction } from "@/server/access/access.ts";
import type { CommandInput } from "@/shared/threads/commands.ts";
import type { Calls } from "@/server/calls/calls.ts";
import { type Change } from "@/shared/threads/events.ts";
import { type Effort, UNTITLED, type ThreadSummary } from "@/shared/threads/thread.ts";

import type { Branches } from "./branches.ts";
import type { NewEvent, StoredEvent, Thread, ThreadAsk, ThreadStore } from "./types.ts";
import { cutThrough, rowActions } from "./history.ts";
import type { ThreadLog } from "./log.ts";
import type { Transcripts } from "./transcripts.ts";

export interface ThreadsOptions {
  spaces: Spaces;
  access: Pick<ThreadAccess, "can" | "require">;
  threads: ThreadStore;
  runs: Pick<RunReads, "active">;
  models: Pick<Models, "defaults" | "requireModel" | "aliasOf">;
  log: ThreadLog;
  signals: Signals;
  // What tells the thread's agent what people change.
  queue: Pick<Queue, "enqueue" | "fromLog">;
  // People's posts, for a thread started with its first message.
  posts: Pick<Posts, "message" | "command">;
  // The thread's branches: which one a row is read on, and what the reader may do from it.
  branches: Pick<Branches, "branchIn" | "abilitiesIn">;
  transcripts: Pick<Transcripts, "of">;
  // The tool calls of a thread copied, when kept.
  calls?: Pick<Calls, "fromLog">;
  // The thread's model, opened, and what its next call would send were the branch to end at the
  // row, or at its last; for asking from outside its runs. Threads are not started from summaries
  // without it.
  ask?: ThreadAsk;
}

export type Threads = ReturnType<typeof createThreads>;

// The event as copied into another thread: what it says of messages and rows there, and of where a
// compaction cut, said of their copies; and what its call gave back, where that is kept apart from
// the log, from `results`, for the copy to keep its own.
function copiedEvent(
  event: StoredEvent,
  ids: ReadonlyMap<string, string>,
  seqs: ReadonlyMap<number, number>,
  results: ReadonlyMap<string, unknown>,
): NewEvent {
  const id = (old: string) => ids.get(old) ?? old;
  switch (event.type) {
    case "tool.ran": {
      if (!event.data.large) return event;
      const { large: _large, ...data } = event.data;
      return { ...event, data: { ...data, value: results.get(event.id) ?? null } };
    }
    case "message.admitted":
      return { ...event, data: { ...event.data, messageIds: event.data.messageIds.map(id) } };
    case "message.changed":
    case "message.withdrawn":
    case "message.dropped":
      return { ...event, data: { ...event.data, messageId: id(event.data.messageId) } } as NewEvent;
    case "branch.started":
      return {
        ...event,
        data: {
          ...event.data,
          rowId: id(event.data.rowId),
          ...(event.data.keep && { keep: event.data.keep.map(id) }),
        },
      };
    case "thread.compacted": {
      const { firstKeptSeq } = event.data;
      const after = [...seqs].filter(([old]) => old >= firstKeptSeq).map(([, copy]) => copy);
      const kept =
        seqs.get(firstKeptSeq) ??
        (after.length > 0 ? Math.min(...after) : Math.max(0, ...seqs.values()) + 1);
      return { ...event, data: { ...event.data, firstKeptSeq: kept } };
    }
    default:
      return event;
  }
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
    access,
    threads,
    runs,
    models,
    log,
    signals,
    queue,
    posts,
    branches,
    transcripts,
    calls,
  } = options;

  // Whether the principal may still read the thread.
  async function readable(principal: Principal, id: string) {
    const thread = await threads.find(id);
    return !!thread && (await access.can(principal, thread, "read"));
  }

  // The thread when the principal may take the action in it.
  async function visible(
    principal: Principal,
    id: string,
    action: ThreadAction = "read",
  ): Promise<Thread> {
    return (await access.require(principal, id, action)).thread;
  }

  return {
    visible,

    readable,

    // Starts a thread on the model and effort chosen for it, or those its space's defaults, then
    // its org's, give at this moment, so later changes to them leave it be; with its first message
    // when there is one. A chosen model must be one the org can use.
    async create(
      principal: Principal,
      spaceId: string,
      input: { text?: string; model?: string; effort?: Effort; command?: CommandInput } = {},
    ) {
      const { text, command } = input;
      await spaces.require(principal, spaceId, "message");
      if (input.model) await models.requireModel(principal.orgId, input.model);
      // Seen again after the model check, which waits on providers.
      const space = await spaces.require(principal, spaceId, "message");
      const defaults = await models.defaults(space);
      const thread = await threads.create({
        spaceId,
        model: input.model ?? defaults.model,
        effort: input.effort ?? defaults.effort,
        createdBy: principal.userId,
      });
      if (text && command) {
        // A command the space does not have leaves no thread behind.
        try {
          await posts.command(principal, thread.id, text, "steer", command);
        } catch (error) {
          await threads.delete(thread.id);
          throw error;
        }
      } else if (text) await posts.message({ principal, thread, via: null }, text);
      return threadSummary((await threads.find(thread.id)) ?? thread);
    },

    // What a call gave back that its row left out for its size, by the id the row names it by, for
    // whoever may read the call's thread.
    async result(principal: Principal, id: string): Promise<{ value: unknown }> {
      const kept = await threads.result(id);
      if (!kept) throw new ServiceError(404, "Result not found");
      await visible(principal, kept.threadId);
      return { value: kept.value };
    },

    async update(
      principal: Principal,
      id: string,
      changes: {
        title?: string;
        model?: string | null;
        effort?: Effort | null;
      },
    ) {
      await visible(principal, id, "arrange");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      const before = await visible(principal, id, "arrange");
      const updated = await threads.update(id, {
        ...changes,
        ...(changes.title !== undefined && { titleSource: "person" as const }),
      });
      signals.changed({ threadId: id });
      const who = (await threads.userName(principal.userId)) ?? "Someone";
      const did: { text: string; change?: Change }[] = [];
      if (changes.title && changes.title !== before.title) {
        did.push({
          text: `${who} renamed the thread to ${changes.title}`,
          change: {
            subject: { kind: "thread", name: changes.title },
            action: "rename",
            ...(before.title && { from: before.title }),
            to: changes.title,
          },
        });
      }
      if (changes.model !== undefined && changes.model !== before.model) {
        did.push({
          text: changes.model
            ? `${who} switched the model to ${await models.aliasOf(principal.orgId, changes.model)}`
            : `${who} set the model to the default`,
          change: {
            subject: { kind: "thread", name: updated.title ?? "Thread" },
            action: "model",
            ...(before.model && { from: before.model }),
            ...(changes.model && { to: changes.model }),
          },
        });
      }
      if (changes.effort !== undefined && changes.effort !== before.effort) {
        did.push({
          text: changes.effort
            ? `${who} set the effort to ${changes.effort}`
            : `${who} set the effort to the default`,
        });
      }
      for (const { text, change } of did)
        await queue.enqueue(
          id,
          {
            kind: "notice",
            notice: silentChange(
              id,
              who,
              text,
              undefined,
              { kind: "person", userId: principal.userId, name: who },
              change,
            ),
          },
          { origin: { kind: "person", id: principal.userId } },
        );
      return threadSummary(updated);
    },

    // Moves the thread to another space of the org where the principal can post; its events and
    // guests go with it.
    async move(principal: Principal, id: string, spaceId: string) {
      const thread = await visible(principal, id, "move");
      if (thread.spaceId === spaceId) throw new ServiceError(409, "The thread is already there");
      await spaces.require(principal, spaceId, "message");
      if (thread.parentThreadId)
        throw new ServiceError(409, "A subagent's thread moves with its own");
      const children = await threads.children(id);
      if (
        await someAsync([id, ...children.map((child) => child.id)], async (one) => runs.active(one))
      ) {
        throw new ServiceError(409, "Stop the agent before moving this thread");
      }
      const moved = await threads.update(id, { spaceId });
      for (const child of children) await threads.update(child.id, { spaceId });
      signals.changed({ threadId: id });
      return threadSummary(moved);
    },

    // Its events go with it.
    async remove(principal: Principal, id: string) {
      const thread = await visible(principal, id, "delete");
      await threads.delete(id);
      signals.changed({ threadId: id, gone: { spaceId: thread.spaceId } });
    },

    // Starts a thread in the same space from the conversation of a branch up to a row: its events
    // copied with their writers and times, then where it came from.
    async fork(principal: Principal, id: string, input: { rowId: string; branchId?: string }) {
      const thread = await visible(principal, id);
      const from = await branches.branchIn(thread, input.branchId);
      const fold = await transcripts.of(id, from);
      const { rows } = fold.transcript();
      const index = fold.indexOf(input.rowId);
      if (index === -1) throw new ServiceError(404, "Message not found");
      const abilities = await branches.abilitiesIn(principal, thread, from, rows);
      if (!rowActions(rows, index, abilities).includes("fork")) {
        throw new ServiceError(403, "Only the space's members who can message can fork threads");
      }
      const cut = cutThrough(fold, index);
      const events = (await threads.eventsAfter(id, 0, from)).filter((event) => event.seq <= cut);
      const results = await threads.results(
        events.flatMap((event) =>
          event.type === "tool.ran" && event.data.large ? [event.id] : [],
        ),
      );
      const forked = await threads.create({
        spaceId: thread.spaceId,
        model: thread.model,
        effort: thread.effort,
        createdBy: principal.userId,
        ...(thread.title && { title: thread.title, titleSource: thread.titleSource ?? "message" }),
      });
      await log.write(forked.id, async (append) => {
        const ids = new Map<string, string>();
        const seqs = new Map<number, number>();
        for (const event of events) {
          const copied = await append({
            ...copiedEvent(event, ids, seqs, results),
            createdAt: event.createdAt,
          });
          ids.set(event.id, copied.id);
          seqs.set(event.seq, copied.seq);
        }
        const actor = { kind: "user" as const, userId: principal.userId };
        await append({
          type: "thread.forked",
          actor,
          data: { threadId: id, rowId: input.rowId, title: thread.title ?? UNTITLED },
        });
        await queue.fromLog(forked.id);
        await calls?.fromLog(forked.id);
      });
      return threadSummary((await threads.find(forked.id)) ?? forked);
    },

    // Starts a thread in the same space from a summary of the conversation of a branch up to a
    // row, which its agent reads in place of that conversation, with where it came from.
    async fromSummary(
      principal: Principal,
      id: string,
      input: { rowId: string; branchId?: string },
    ) {
      const thread = await visible(principal, id);
      const from = await branches.branchIn(thread, input.branchId);
      const fold = await transcripts.of(id, from);
      const { rows } = fold.transcript();
      const index = fold.indexOf(input.rowId);
      if (index === -1) throw new ServiceError(404, "Message not found");
      const abilities = await branches.abilitiesIn(principal, thread, from, rows);
      if (!rowActions(rows, index, abilities).includes("fork")) {
        throw new ServiceError(403, "Only the space's members who can message can fork threads");
      }
      if (!options.ask) throw new ServiceError(409, "Summaries can't be written here");
      const asked = await options.ask(id, from, input.rowId);
      const written = await summarise({
        threadId: id,
        rows: asked.rows,
        model: asked.model,
        request: asked.request,
        signal: AbortSignal.timeout(120_000),
      });
      // Seen again after the model, which may take a while.
      await visible(principal, id);
      const forked = await threads.create({
        spaceId: thread.spaceId,
        model: thread.model,
        effort: thread.effort,
        createdBy: principal.userId,
        ...(thread.title && { title: thread.title, titleSource: thread.titleSource ?? "message" }),
      });
      const actor = { kind: "user" as const, userId: principal.userId };
      await log.write(forked.id, async (append) => {
        const at = await append({
          type: "thread.forked",
          actor,
          data: {
            threadId: id,
            rowId: input.rowId,
            title: thread.title ?? UNTITLED,
            summary: true,
          },
        });
        const used =
          written.usage.inputTokens + written.usage.outputTokens > 0 ||
          written.usage.cost !== undefined;
        await append({
          type: "thread.compacted",
          actor,
          data: {
            summary: written.summary,
            // Everything after the summary is read word for word.
            firstKeptSeq: at.seq + 2,
            tokensBefore: written.tokensBefore,
            tokensAfter: tokensOf(written.summary),
            ...(used && { usage: written.usage }),
          },
        });
      });
      return threadSummary((await threads.find(forked.id)) ?? forked);
    },
  };
}

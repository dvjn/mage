// Subagents: agents a thread's agent starts in the background, each in a child thread of its own
// with its own runs, approvals and compaction, and known everywhere by the label it was started
// with, unique among the thread's live subagents. A subagent is given its task as its first
// message, has its starter's tools but for those only the starter has, and may start from a copy of
// its starter's conversation. It works until it has nothing left to do and is idle; any message
// sent to it wakes it again. Messages between agents are notices, and nothing goes anywhere
// unless sent: a subagent's replies stay in its own thread, and results go to the thread's agent as
// messages. That agent is notified when a subagent ended a run without sending it anything, failed
// or was stopped; and, once, when the subagents a watch was set on are idle, as a subagent is of
// the others started with it. Only a few subagents
// of a thread run at once, and the rest queue; a thread has at most a dozen that are not retired.
// Subagents started by the same agent message each other, up to a limit for all of them together,
// past which the agent that started them is told and further messages between them are refused. A
// subagent is stopped, which keeps what it knows, or retired, which keeps its thread readable and
// refuses it messages, until someone brings it back. Whose words steer what an agent does carries
// over with each message and notice it is sent, so a call any agent makes runs directly only
// when every person behind it could have made it.

import { ulid } from "ulid";

import type { Reader, ThreadAccess } from "@/server/access/access.ts";
import { agentNameFrom } from "@/server/spaces/service.ts";
import type { CallEffect } from "@/shared/threads/rows.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import * as z from "zod";

import { failureSentence } from "@/server/execution/failure-text.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { Sync } from "@/server/sync/sync.ts";
import type { ModelMessage } from "@/server/models/gateway.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore } from "@/server/threads/types.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import {
  AGENT,
  CHOOSE_MODELS,
  SUBAGENTS_TOOLSET,
  SEND_SUBAGENT_MESSAGE,
  START_SUBAGENT,
  type SubagentNeeds,
  type SubagentState,
  type SubagentSummary,
} from "@/shared/subagents.ts";
import type {
  Cause,
  NoticeSource,
  SubagentTask,
  Sender,
  Influencer,
} from "@/shared/threads/events.ts";
import { type Effort, effortSchema, UNTITLED } from "@/shared/threads/thread.ts";
import { toolIdNow } from "@/shared/tools.ts";
import { LIST_MODELS } from "@/shared/models.ts";
import type { QueuedInput } from "@/server/queue/queue.ts";
import type { AgentRow, NoticeRow, ToolRow, TranscriptRow } from "@/shared/transcript.ts";

import { wholeWhereRead } from "@/server/execution/compaction.ts";
import { contextOf, framingMessage, type ToolsetGuidance } from "@/server/execution/context.ts";
import type { Notice } from "@/server/queue/notices.ts";
import type { Queue } from "@/server/queue/queue.ts";
import { WATCH_LIMIT, type Watch, type WatchStore } from "./watches.ts";
import type { Run, RunReads, StopTarget } from "@/server/execution/execution.ts";
import type {
  AnyToolSpec,
  CallPresentation,
  ToolContext,
  Toolset,
  ToolSpec,
} from "@/server/tools/registry.ts";
import { AGENT_NAME, influenceIn } from "@/server/calls/influence.ts";
import { filterAsync, mapAsync } from "@/server/kernel/async.ts";

export interface SubagentRecord {
  threadId: string;
  parentThreadId: string;
  name: string;
  // The call in its starter's thread that started it.
  callId: string | null;
  instructions: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface SubagentStore {
  create(
    subagent: Pick<SubagentRecord, "threadId" | "parentThreadId" | "name" | "callId"> & {
      instructions?: string | null;
    },
  ): Promise<SubagentRecord>;
  find(threadId: string): Promise<SubagentRecord | null>;
  // The subagents the threads' agents started, retired ones among them, oldest first.
  ofParents(parentThreadIds: string[]): Promise<SubagentRecord[]>;
  // Retires the subagent; null when it was retired already.
  archive(threadId: string, at: Date): Promise<SubagentRecord | null>;
  // Brings a retired subagent back; null when it was not retired.
  unarchive(threadId: string): Promise<SubagentRecord | null>;
}

// What another system adds to a subagent's start: whether the tasks a start names may be given,
// what follows once it is made, and what its framing says of it.
export interface SubagentExtension {
  // The reason the tasks cannot be given, or null when they can.
  check(parentId: string, taskIds: string[]): Promise<string | null>;
  // Inside the write that makes it.
  started(
    subagent: SubagentRecord,
    input: { tasks?: string[]; shareTasks: boolean },
  ): Promise<void>;
  framing(threadId: string): Promise<{ sharesTasks?: true }>;
}

// How many of a thread's subagents run at once; the rest wait their turn.
export const RUNNING_LIMIT = 4;
// How many subagents a thread has that are not retired.
export const LIVE_LIMIT = 12;
// How many messages a thread's subagents send each other in all.
export const MESSAGE_LIMIT = 30;
// What stands for the agent of a thread where its words carried on into a subagent's thread; no
// subagent may be labelled so.
export { AGENT_NAME };

// What the agent of a thread that can start subagents is told about them.
export const SUBAGENTS_GUIDANCE = [
  "Use a subagent to keep large work out of this conversation: exploring many files or results, a long investigation, or parts of a job that don't depend on each other. Each runs in the background in its own thread; its report, and runs that end without one, fail or are stopped, arrive as notices from [Subagent <label>].",
  "- Brief it as a peer who knows nothing: the goal, what you already know or ruled out, where to look, and what to return. The brief is all the context it has.\n- Ask for a short report: conclusions, decisions, ids and links, not raw data. Ask it to say what it verified and what it assumed.\n- Split work so subagents don't overlap, and run them in parallel. Plan tasks first, then start them with their task ids in tasks so they pick up and check off items on this thread's list (share_tasks alone shares the list).\n- Don't do the same work yourself while one runs. To wait, watch them and end your turn; a watch stays set until it fires, so don't set it again after each report.\n- Reuse a subagent that already has the context, archived or not, rather than starting another. Archive each once you've used its report, and all of them when the job is done.\n- Treat a report as a claim. Check anything that matters before acting on it.",
].join("\n\n");

export interface SubagentsOptions {
  subagents: SubagentStore;
  threads: Pick<
    ThreadStore,
    "create" | "find" | "findAll" | "eventsOfType" | "eventsAfter" | "eventsAfterEach"
  >;
  // Whether a person may read a thread, for where a subagent call had its effect.
  access: Pick<ThreadAccess, "can" | "canRead">;
  // The ref a model is stored under, given that or the alias the agent knows it by.
  modelRef?: (orgId: string, ref: string) => Promise<string>;
  transcripts: Pick<Transcripts, "of" | "whole">;
  runs: Pick<RunReads, "active" | "activeIn" | "activeOnCurrent" | "latest" | "latestIn">;
  // Asks the runs under way there to stop; a silent stop is not told to the starter.
  stop: (target: StopTarget, by: string | null, opts?: { silent?: boolean }) => Promise<Run[]>;

  log: ThreadLog;
  signals: Signals;
  // Whether the agent may choose the models of the subagents it starts in the space, and the
  // models the org can use there, each with whether it takes an effort.
  choosesModels?: (spaceId: string) => Promise<boolean>;
  modelsIn?: (
    orgId: string,
  ) => Promise<{ ref: string; alias?: string; name?: string; reasoning?: boolean }[]>;
  // The calls of the threads that wait for a person.
  calls: {
    waitingIn(threadIds: readonly string[]): Promise<(WaitingRow & { threadId: string })[]>;
  };
  // Runs a pass on every instance as time goes on.
  ticker?: Sync["ticker"];
  // Where notices to threads' agents go in, and where the inputs waiting for them stand. Its own
  // `mayStart` decides whether a notified thread's agent starts.
  queue: Pick<Queue, "enqueue" | "waiting" | "wakes" | "wakesIn">;
  // Agents waiting on subagents, as on tasks.
  watches: Pick<WatchStore, "add" | "on" | "setIn" | "count" | "end" | "open" | "due">;
  // The name the model calls each of a space's tools by, from its id.
  toolNames?: (spaceId: string) => Promise<(toolId: string) => string>;
  now?: () => Date;
}

export type Subagents = ReturnType<typeof createSubagents>;

const WATCH_SUBAGENTS = "subagents.watch";

// How often every open watch on subagents is looked at again.
const WATCH_PASS_MS = 30_000;

// The subagent tools whose calls act on one subagent.
const SUBAGENT_ACTIONS = new Set([
  START_SUBAGENT,
  "subagents.stop",
  "subagents.archive",
  "subagents.unarchive",
]);

const causeKey = (call: Cause) => `${call.threadId}:${call.callId}`;
const UNARCHIVE_SUBAGENT = "subagents.unarchive";

// The tools only the agent that started subagents has.
const STARTER_ONLY = new Set([
  START_SUBAGENT,
  "subagents.stop",
  "subagents.archive",
  UNARCHIVE_SUBAGENT,
]);

// What a subagent waits on in its thread, if anything: a decision on a call, or answers.
function needsOf(run: Run | null, waiting: readonly WaitingRow[]): SubagentNeeds | undefined {
  if (run?.status !== "waiting") return undefined;
  const call = waiting
    .filter((one) => !one.background && one.runId === run.id)
    .toSorted((a, b) => a.seq - b.seq)[0];
  if (!call) return undefined;
  return call.waitsFor === "answer" ? "answer" : "decision";
}

// A call that waits for a person, as the subagent's state reads it.
interface WaitingRow {
  runId: string;
  seq: number;
  background: boolean;
  waitsFor: "decision" | "answer" | null;
}

// How many messages the subagents took in, or have waiting, from one another.
function receivedFromSubagents(rows: readonly TranscriptRow[], waiting: readonly QueuedInput[]) {
  const notices = waiting.flatMap((input): Pick<NoticeRow, "type" | "from">[] =>
    input.notice ? [input.notice] : [],
  );
  return [...rows, ...notices].filter(
    (message) =>
      "from" in message && "type" in message && message.type === "message" && !message.from.main,
  ).length;
}

// The last thing the subagent said in its thread.
function lastSaidRow(rows: readonly TranscriptRow[]) {
  return rows.findLast((row): row is AgentRow => row.kind === "agent" && !!row.text);
}

function lastSaid(rows: readonly TranscriptRow[]) {
  return lastSaidRow(rows)?.text ?? "";
}

// Whether the run sent the agent that started the subagent anything.
function reported(rows: readonly TranscriptRow[], runId: string) {
  return rows.some((row) => {
    if (row.kind !== "tool" || row.runId !== runId || row.background || !row.output?.ok) {
      return false;
    }
    if (toolIdNow(row.toolId) !== SEND_SUBAGENT_MESSAGE) return false;
    const sent = (row.output.value as { sent?: unknown } | null)?.sent;
    return Array.isArray(sent) && sent.includes(AGENT);
  });
}

// What happened, then the subagent's last words.
// The last thing a subagent said, where it said anything.
function withLast(last: string) {
  return last ? { last } : {};
}

// Whether a subagent is idle as a watch reads it: neither working nor waiting to.
function idleState(state: SubagentState) {
  return state !== "working" && state !== "queued";
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Whether the subagent goes by the label, or has the thread id.
function known(subagent: SubagentRecord, label: string) {
  return subagent.threadId === label || sameName(subagent.name, label);
}

// What a subagent cannot be labelled, as the ways its starter and the others address everyone.
const RESERVED = [AGENT, "all"];

const nameSchema = z.string().trim().min(1).max(80);

export function createSubagents(options: SubagentsOptions) {
  const { subagents, threads, runs, log, signals } = options;
  const now = options.now ?? (() => new Date());

  async function transcript(threadId: string) {
    return (await options.transcripts.of(threadId)).transcript();
  }

  async function threadOf(id: string) {
    const thread = await threads.find(id);
    if (!thread) throw new Error("the thread is gone");
    return thread;
  }

  // The messages subagent calls sent to each thread, by the call: read for one page, from the
  // notices in the threads' logs, all of them together.
  async function messagesSentBy(threadId: string, call: Cause, page: ReturnType<typeof pageReads>) {
    if (!page.sent.has(threadId)) await readSent([threadId], page.sent);
    return page.sent.get(threadId)?.get(causeKey(call)) ?? [];
  }

  async function readSent(threadIds: readonly string[], into: Map<string, Map<string, string[]>>) {
    const fresh = threadIds.filter((threadId) => !into.has(threadId));
    for (const threadId of fresh) into.set(threadId, new Map());
    const froms = fresh.map((threadId) => ({ threadId, after: 0 }));
    for (const event of await threads.eventsAfterEach(froms, "notice")) {
      if (event.type !== "notice" || !event.data.source.callId) continue;
      const key = causeKey({
        threadId: event.data.source.threadId,
        callId: event.data.source.callId,
      });
      const byCall = into.get(event.threadId)!;
      byCall.set(key, [...(byCall.get(key) ?? []), event.id]);
    }
  }

  // Where the reader's thread's subagent call had its effect, in the threads they may read: the
  // task a start gave, each message a send delivered, and the thread a stop or archive acted on.
  async function effectsOf(
    row: ToolRow,
    reader: Reader,
    page: ReturnType<typeof pageReads>,
  ): Promise<CallEffect[]> {
    if (!row.output?.ok) return [];
    const tool = toolIdNow(row.toolId);
    const value = (row.output.value ?? {}) as { id?: unknown; name?: unknown; sent?: unknown };
    const call = { threadId: reader.thread.id, callId: row.id };
    const effects: CallEffect[] = [];
    if (SUBAGENT_ACTIONS.has(tool) && typeof value.id === "string") {
      const name = typeof value.name === "string" ? value.name : "";
      if (tool !== START_SUBAGENT) effects.push({ kind: "thread", threadId: value.id, name });
      for (const rowId of tool === START_SUBAGENT
        ? await messagesSentBy(value.id, call, page)
        : []) {
        effects.push({ kind: "task", threadId: value.id, rowId, name });
      }
    } else if (tool === SEND_SUBAGENT_MESSAGE && Array.isArray(value.sent)) {
      const reach = await page.reach();
      const agentName =
        reader.space && reader.settings
          ? agentNameFrom(reader.space, reader.settings)
          : DEFAULT_AGENT_NAME;
      for (const label of value.sent) {
        for (const to of reach.filter((one) => one.name === label)) {
          for (const rowId of await messagesSentBy(to.threadId, call, page)) {
            const name = to.main ? agentName : to.name;
            effects.push({ kind: "message", threadId: to.threadId, rowId, name });
          }
        }
      }
    }
    return await filterAsync(effects, async (effect) => page.readable(effect.threadId));
  }

  // What the rows of one page read once for all their calls: the threads the agent sends to, and
  // whether the reader may read each thread a call had its effect in.
  function pageReads(reader: Reader) {
    let reach: ReturnType<typeof reachOf> | undefined;
    const readable = new Map<string, Promise<boolean>>();
    const found = new Map<string, Thread | null>();
    // The messages sent to each thread whose log this page read, by the call that sent them.
    const sent = new Map<string, Map<string, string[]>>();
    const read = async (threadId: string) => {
      const thread = found.has(threadId) ? found.get(threadId)! : await threads.find(threadId);
      return !!thread && (await options.access.canRead(reader.principal, thread, reader));
    };
    return {
      sent,
      // Reads the threads the page's calls name, and what was added to their logs, together.
      async prepare(threadIds: string[]) {
        if (threadIds.length === 0) return;
        for (const thread of await threads.findAll(threadIds)) found.set(thread.id, thread);
        for (const id of threadIds) if (!found.has(id)) found.set(id, null);
        await readSent(threadIds, sent);
      },
      reach: async () => (reach ??= reachOf(reader.thread.id)),
      readable: async (threadId: string) => {
        const found = readable.get(threadId) ?? read(threadId);
        readable.set(threadId, found);
        return found;
      },
    };
  }

  // The threads the thread's agent sends messages to, retired subagents' among them, each with
  // the label it was sent by: for the agent that started subagents, theirs; for a subagent, its
  // starter's, as agent, and the others started with it.
  async function reachOf(threadId: string) {
    const me = await subagents.find(threadId);
    const parentId = me?.parentThreadId ?? threadId;
    const others = (await subagents.ofParents([parentId]))
      .filter((subagent) => subagent.threadId !== threadId)
      .map((subagent) => ({ threadId: subagent.threadId, name: subagent.name, main: false }));
    return me ? [{ threadId: parentId, name: AGENT, main: true }, ...others] : others;
  }

  // What a subagent call shows the reader: a start names the subagent and the model it was given,
  // with where it stands now; each call, where it had its effect.
  async function present(reader: Reader, rows: readonly ToolRow[]) {
    const shown = new Map<string, CallPresentation>();
    const page = pageReads(reader);
    // The subagents the rows started, where each stands read together; one started in another
    // thread, as a copied log names, is read on its own.
    const ids = new Set(
      rows.flatMap((row) => {
        const id = row.output?.ok && (row.output.value as { id?: unknown } | null)?.id;
        return toolIdNow(row.toolId) === START_SUBAGENT && typeof id === "string" ? [id] : [];
      }),
    );
    await page.prepare([...ids]);
    const own = ids.size > 0 ? await subagents.ofParents([reader.thread.id]) : [];
    const started = own.filter((one) => ids.has(one.threadId));
    for (const id of ids) {
      if (started.some((one) => one.threadId === id)) continue;
      const found = await subagents.find(id);
      if (found) started.push(found);
    }
    const summaries = new Map(
      (await summariesOf(started)).map((summary) => [summary.threadId, summary]),
    );
    for (const row of rows) {
      const tool = toolIdNow(row.toolId);
      if (!SUBAGENT_ACTIONS.has(tool) && tool !== SEND_SUBAGENT_MESSAGE) continue;
      const presentation: CallPresentation = {};
      const named = (row.input as { name?: unknown } | null)?.name;
      if (tool === START_SUBAGENT && typeof named === "string") {
        // The model as it was given back, an alias since aliases came in, read as its ref.
        const given = row.output?.ok && (row.output.value as { model?: unknown } | null)?.model;
        const model =
          typeof given === "string" && reader.space
            ? ((await options.modelRef?.(reader.space.orgId, given)) ?? given)
            : given;
        presentation.names = {
          subagentName: named,
          ...(typeof model === "string" && { model }),
        };
      }
      const id = (row.output?.ok && (row.output.value as { id?: unknown } | null)?.id) || null;
      if (tool === START_SUBAGENT && typeof id === "string") {
        const summary = summaries.get(id);
        if (summary) presentation.subagent = summary;
        presentation.live = true;
      }
      const effects = await effectsOf(row, reader, page);
      if (effects.length > 0) presentation.effects = effects;
      shown.set(row.id, presentation);
    }
    return (row: ToolRow) => shown.get(row.id);
  }

  async function live(parentThreadId: string) {
    return (await subagents.ofParents([parentThreadId])).filter((subagent) => !subagent.archivedAt);
  }

  // Where the subagent stands now.
  async function summaryOf(subagent: SubagentRecord): Promise<SubagentSummary> {
    return (await summariesOf([subagent]))[0]!;
  }

  // Where each subagent stands now, read together: working while a run of its current branch is
  // under way, waiting on what its first waiting call waits for; else queued while an input waits
  // to start it, stopped when its last run was, or idle.
  async function summariesOf(records: readonly SubagentRecord[]): Promise<SubagentSummary[]> {
    const open = records.filter((one) => !one.archivedAt).map((one) => one.threadId);
    const active = new Map((await runs.activeOnCurrent(open)).map((run) => [run.threadId, run]));
    const waitingIds = [...active.values()]
      .filter((run) => run.status === "waiting")
      .map((run) => run.threadId);
    const waiting = waitingIds.length > 0 ? await options.calls.waitingIn(waitingIds) : [];
    const idle = open.filter((id) => !active.has(id));
    const woken = new Set(await queue.wakesIn(idle));
    const latest = new Map(
      (await runs.latestIn(idle.filter((id) => !woken.has(id)))).map((run) => [run.threadId, run]),
    );
    return records.map((subagent): SubagentSummary => {
      const base = { threadId: subagent.threadId, name: subagent.name };
      if (subagent.archivedAt) return { ...base, state: "archived" };
      const run = active.get(subagent.threadId);
      if (run) {
        const needs = run.status === "waiting" ? needsOf(run, waiting) : undefined;
        return { ...base, state: "working", ...(needs && { needs }) };
      }
      if (woken.has(subagent.threadId)) return { ...base, state: "queued" };
      const last = latest.get(subagent.threadId);
      return { ...base, state: last?.status === "cancelled" ? "stopped" : "idle" };
    });
  }

  // A subagent starts on what waits for it only while fewer than the limit of its starter's
  // subagents are running, and not once retired.
  async function mayStart(threadId: string) {
    const subagent = await subagents.find(threadId);
    if (!subagent) return true;
    if (subagent.archivedAt) return false;
    const siblings = (await live(subagent.parentThreadId)).map((other) => other.threadId);
    return (await runs.activeIn(siblings)).length < RUNNING_LIMIT;
  }

  const { queue, watches } = options;
  // What another system adds to a start, once it has said.
  let extension: SubagentExtension | null = null;

  // Tells the thread's agent, as the call that made what sends it, where there is one.
  async function notify(threadId: string, notice: Notice, source?: string | null) {
    await queue.enqueue(
      threadId,
      { kind: "notice", notice },
      source ? { source: { callId: source } } : {},
    );
  }

  // Sends another agent's message to the thread, with the call that sent it.
  async function deliver(
    threadId: string,
    message: {
      text: string;
      from: Sender;
      to: string;
      influence: Influencer[];
      task?: SubagentTask;
      call: Cause;
      // The call in the receiving thread that made the sender, for a subagent's to its starter.
      source?: string | null;
    },
  ) {
    const { text, from, to, influence, task, call, source } = message;
    await queue.enqueue(
      threadId,
      {
        kind: "notice",
        notice: {
          kind: "message",
          source: { ...from, callId: call.callId },
          text,
          influence: influence,
          to,
          ...(task && { task }),
        },
      },
      {
        origin: { kind: "subagent", id: from.threadId },
        ...(source && { source: { callId: source } }),
      },
    );
  }

  // The subagent as the source of a notice its starter is sent, with the row it came of.
  function sourceOf(subagent: SubagentRecord, rowId?: string) {
    return {
      threadId: subagent.threadId,
      name: subagent.name,
      main: false,
      ...(rowId && { rowId }),
    };
  }

  // Everyone whose words the subagent read, as they steer what its starter is told of it.
  async function steeredIn(subagent: SubagentRecord) {
    return influenceIn((await transcript(subagent.threadId)).rows).map((entry) => ({
      ...entry,
      via: [...entry.via, subagent.name],
    }));
  }

  // What its starter is told of the subagent's run that ended, if anything: that it failed, was
  // stopped, or ended without sending it anything, with its last words.
  async function endNotice(subagent: SubagentRecord, run: Run): Promise<Notice | null> {
    const { rows } = await transcript(subagent.threadId);
    const people = await steeredIn(subagent);
    const lastRow = lastSaidRow(rows);
    const last = lastRow?.text ?? "";
    const { name } = subagent;
    if (run.status === "failed") {
      const failure = rows.findLast((row) => row.kind === "failure" && row.runId === run.id);
      const found = failure?.kind === "failure" ? failure : undefined;
      const error = found?.error || undefined;
      const said = found
        ? failureSentence({
            error: found.error,
            kind: found.failure,
            ...(found.connection && { connection: found.connection }),
          })
        : undefined;
      return {
        kind: "agent.failed",
        source: sourceOf(subagent, failure?.id),
        text: `${name} failed${said === undefined ? "." : `: ${said}`}`,
        influence: people,
        subagents: [{ threadId: subagent.threadId, name }],
        ...(error !== undefined && { error }),
        ...withLast(last),
      };
    }
    if (run.status === "cancelled") {
      const stopped = rows.findLast((row) => row.kind === "stop" && row.runId === run.id);
      return {
        kind: "agent.stopped",
        source: sourceOf(subagent, stopped?.id),
        text: `${name} was stopped.`,
        influence: people,
        subagents: [{ threadId: subagent.threadId, name }],
        ...withLast(last),
      };
    }
    if (reported(rows, run.id)) return null;
    return {
      kind: "agent.ended",
      source: sourceOf(subagent, lastRow?.id),
      text: `${name} ended its run without reporting.`,
      influence: people,
      subagents: [{ threadId: subagent.threadId, name }],
      ...withLast(last),
    };
  }

  // The notice a watch owes its thread's agent, once the subagents it was set on are idle: all of
  // them, or any.
  async function noticeFor(watch: Watch) {
    const { threadId, until } = watch;
    const watched = (
      await Promise.all(
        watch.subjects.map(async (id) => {
          const subagent = await subagents.find(id);
          return subagent ? [subagent] : [];
        }),
      )
    ).flat();
    const idle = await filterAsync(watched, async (subagent) =>
      idleState((await summaryOf(subagent)).state),
    );
    const holds = until === "all_idle" ? idle.length === watched.length : idle.length > 0;
    const thread = await threads.find(threadId);
    if (!holds || idle.length === 0 || !thread) return null;
    const people = new Map<string, Influencer>();
    for (const subagent of watched) {
      for (const entry of await steeredIn(subagent)) {
        people.set(JSON.stringify([entry.userId, entry.via]), entry);
      }
    }
    const names = idle.map((subagent) => subagent.name).join(", ");
    return {
      kind: "agent.idle" as const,
      source: {
        ...(await senderOf(thread)).from,
        ...(watch.callId && { callId: watch.callId }),
      } satisfies NoticeSource as NoticeSource,
      actor: { kind: "source" as const, label: "Subagents", type: "system" as const },
      text: until === "all_idle" ? `All idle: ${names}` : `Idle: ${names}`,
      influence: [...people.values()],
      subagents: idle.map((subagent) => ({ threadId: subagent.threadId, name: subagent.name })),
      when: until as "all_idle" | "any_idle",
    };
  }

  // Fires the watches on subagents that now hold, each once: those on the starter's subagents, or
  // with none named every open one. Those of one thread holding together with the same words are
  // one notice, which lists the calls it answers, told in a write of that thread that ends them,
  // so a watch whose check was missed fires on the next pass and never twice. Each is checked
  // again in that write, which a subagent's start and end also lock, so none fires on what
  // changed since it was first looked at.
  async function checkWatches(parentThreadId?: string) {
    // The pass over every watch reads only those that can fire now.
    const open = parentThreadId
      ? await watches.on(parentThreadId, "subagents")
      : await watches.due("subagents");
    const groups = new Map<
      string,
      { threadId: string; notice: NonNullable<Awaited<ReturnType<typeof noticeFor>>>; of: Watch[] }
    >();
    for (const watch of open) {
      const notice = await noticeFor(watch);
      if (!notice) continue;
      const key = JSON.stringify([watch.threadId, notice.text]);
      const group = groups.get(key);
      if (group) group.of.push(watch);
      else groups.set(key, { threadId: watch.threadId, notice, of: [watch] });
    }
    let fired = 0;
    for (const { threadId, notice, of } of groups.values()) {
      await log.write(threadId, async () => {
        const still = await filterAsync(
          of,
          async (watch) => (await noticeFor(watch))?.text === notice.text,
        );
        const ended = await filterAsync(still, async (watch) => watches.end(watch.id));
        if (ended.length === 0) return;
        const calls = ended.flatMap((watch) => (watch.callId ? [watch.callId] : []));
        const { callId: _callId, callIds: _callIds, ...source } = notice.source;
        await queue.enqueue(
          threadId,
          {
            kind: "notice",
            notice: {
              ...notice,
              source: {
                ...source,
                ...(calls[0] && { callId: calls[0] }),
                ...(calls.length > 1 && { callIds: calls.slice(1) }),
              },
            },
          },
          { key: `watch:${ended[0]!.id}`, ...(calls[0] && { source: { callId: calls[0] } }) },
        );
        fired += 1;
      });
    }
    return fired;
  }
  // Every open watch looked at again as time goes on, for a check an instance missed.
  const watchPass = options.ticker?.("subagent-watches", async () => checkWatches(), WATCH_PASS_MS);

  // Refuses messages between the starter's subagents past the limit, telling its agent the first
  // time one is refused, and by which call.
  async function limitBetween(parentThreadId: string, sending: number, call: Cause) {
    let sent = 0;
    for (const subagent of await subagents.ofParents([parentThreadId])) {
      const read = await transcript(subagent.threadId);
      sent += receivedFromSubagents(read.rows, await queue.waiting(subagent.threadId));
    }
    if (sent + sending <= MESSAGE_LIMIT) return;
    const told = (await threads.eventsOfType(parentThreadId, "subagent.limited")).length > 0;
    if (!told) {
      await log.write(parentThreadId, async (append) =>
        append({
          type: "subagent.limited",
          actor: { kind: "agent" },
          data: { limit: MESSAGE_LIMIT, call },
        }),
      );
    }
    throw new ToolRefusal(
      `Your subagents have sent each other ${MESSAGE_LIMIT} messages, the most they may. Send what you have to agent instead.`,
    );
  }

  // Asks the subagent's run to stop, as the person, or as its starter's agent with null; a person
  // stopping the thread that started it stops it silently, so its starter is not woken again.
  async function stopRun(threadId: string, userId: string | null, silent = false) {
    return (await options.stop({ threadId }, userId, { silent }))[0] ?? null;
  }

  // The sender of the thread's agent's messages, and what its people's ways read once they pass
  // through it.
  async function senderOf(thread: Thread): Promise<{ from: Sender; via: string }> {
    const subagent = await subagents.find(thread.id);
    if (subagent) {
      return {
        from: { threadId: thread.id, name: subagent.name, main: false },
        via: subagent.name,
      };
    }
    return {
      from: { threadId: thread.id, name: thread.title ?? UNTITLED, main: true },
      via: AGENT_NAME,
    };
  }

  // Everyone whose words the thread's agent read, as they steer a message it sends.
  async function carried(thread: Thread, via: string) {
    return influenceIn((await transcript(thread.id)).rows).map((entry) => ({
      ...entry,
      via: [...entry.via, via],
    }));
  }

  // The live subagents of the starter's agent the labels pick, or the thread ids, but the one
  // excepted; all of them for "all". Throws naming those it does not know.
  async function pick(parentThreadId: string, labels: readonly string[], except?: string) {
    const all = (await live(parentThreadId)).filter((subagent) => subagent.threadId !== except);
    if (labels.some((label) => sameName(label, "all"))) return all;
    const unknown = labels.filter((label) => !all.some((subagent) => known(subagent, label)));
    if (unknown.length > 0) {
      const labelled = all.map((subagent) => subagent.name).join(", ") || "none";
      throw new ToolRefusal(
        `No live subagent is labelled ${unknown.join(", ")}. Subagents: ${labelled}.`,
      );
    }
    return all.filter((subagent) => labels.some((label) => known(subagent, label)));
  }

  // What listing tells of a subagent: where it stands, what it said last and its latest calls, each
  // by the tool's name for the model.
  async function detailOf(subagent: SubagentRecord, named: (toolId: string) => string) {
    const read = await transcript(subagent.threadId);
    const summary = await summaryOf(subagent);
    // A script's calls are the script's.
    const steps = read.rows
      .flatMap((row) => (row.kind === "tool" && !row.within ? [row] : []))
      .slice(-5)
      .map((row) => ({ tool: named(row.toolId), state: row.state }));
    return {
      id: subagent.threadId,
      name: subagent.name,
      state: summary.state,
      ...(summary.needs && { needs: summary.needs }),
      last: lastSaid(read.rows),
      steps,
    };
  }

  // What a start takes: the subagent's label, task and instructions, whether it starts from a copy
  // of the conversation, and the model and effort it replies with, which count only where the
  // agent may choose them.
  const startInput = z.object({
    name: nameSchema.meta({
      title: "Name",
      description: "A short label, unique among your subagents, such as Researcher",
    }),
    task: z.string().trim().min(1).meta({ title: "Task" }),
    instructions: z.string().trim().min(1).optional().meta({ title: "Instructions" }),
    fork: z
      .boolean()
      .optional()
      .meta({ title: "Fork", description: "Start it from a copy of this conversation" }),
    model: z.string().min(1).optional().meta({
      title: "Model",
      description: "An exact model ref; yours when not given",
    }),
    effort: effortSchema.optional().meta({ title: "Effort", description: "Yours when not given" }),
    tasks: z.array(z.string().min(1)).min(1).optional().meta({
      title: "Tasks",
      description: "Ids of this thread's tasks to give it; shares your task list with it",
    }),
    share_tasks: z.boolean().optional().meta({
      title: "Share tasks",
      description: "Let it read and update your task list, and be given tasks on it",
    }),
  });

  type StartInput = z.infer<typeof startInput>;

  // Starts the subagent in a thread of its own, replying with the model and effort given, or its
  // starter's.
  async function startOne(
    input: StartInput,
    ctx: ToolContext,
    model: {
      model: string | null;
      effort: Effort | null;
      shown?: { alias?: string; name?: string };
    } | null,
  ) {
    // Checked and made in one write of the starter's thread, so two starts at once count each
    // other.
    return ctx.write(async () => startHeld(input, ctx, model));
  }

  async function startHeld(
    input: StartInput,
    ctx: ToolContext,
    model: Parameters<typeof startOne>[2],
  ) {
    const parent = await threadOf(ctx.threadId);
    if (await subagents.find(parent.id)) throw new ToolRefusal("Subagents cannot start subagents.");
    const others = await live(parent.id);
    if (others.length >= LIVE_LIMIT) {
      throw new ToolRefusal(
        `This thread already has ${LIVE_LIMIT} subagents. Archive some you no longer need.`,
      );
    }
    if (RESERVED.some((reserved) => sameName(input.name, reserved))) {
      throw new ToolRefusal(`A subagent cannot be labelled ${input.name}.`);
    }
    if (others.some((subagent) => sameName(subagent.name, input.name))) {
      throw new ToolRefusal(`A subagent is already labelled ${input.name}.`);
    }
    if (input.tasks && extension) {
      const refusal = await extension.check(parent.id, input.tasks);
      if (refusal) throw new ToolRefusal(refusal);
    }
    const thread = await threads.create({
      spaceId: parent.spaceId,
      model: model ? model.model : parent.model,
      effort: model ? model.effort : parent.effort,
      createdBy: null,
      rootThreadId: parent.rootThreadId ?? parent.id,
      title: input.name,
      titleSource: "agent",
    });
    const subagent = await subagents.create({
      threadId: thread.id,
      parentThreadId: parent.id,
      name: input.name,
      callId: ctx.callId,
      instructions: input.instructions ?? null,
    });
    const { from, via } = await senderOf(parent);
    await deliver(thread.id, {
      text: input.task,
      from,
      to: subagent.name,
      influence: await carried(parent, via),
      task: {
        ...(input.instructions && { instructions: input.instructions }),
        ...(input.fork && { fork: { callId: ctx.callId, seq: parent.lastEventSeq } }),
      },
      call: { threadId: parent.id, callId: ctx.callId },
    });
    await extension?.started(subagent, {
      ...(input.tasks && { tasks: input.tasks }),
      shareTasks: input.share_tasks ?? false,
    });
    signals.changed({ threadId: parent.id });
    return {
      id: thread.id,
      name: subagent.name,
      state: (await summaryOf(subagent)).state,
      ...(thread.model &&
        model && {
          model: model.shown?.alias ?? thread.model,
          ...(model.shown?.name && { modelName: model.shown.name }),
        }),
    };
  }

  // The model and effort the subagent replies with when the agent chose either where it may: a
  // model the org can use, and an effort it takes; the starter's for what it did not choose. Null
  // when it chose neither, or may not choose.
  async function chosenModel(input: StartInput, ctx: ToolContext) {
    if (!input.model && !input.effort) return null;
    const parent = await threadOf(ctx.threadId);
    if (!(await options.choosesModels?.(parent.spaceId))) return null;
    const usable = (await options.modelsIn?.(ctx.orgId)) ?? [];
    // The agent names a model by its alias; a stored ref still names it.
    const wanted = input.model ?? parent.model;
    const found =
      usable.find((one) => one.ref === wanted) ??
      (input.model ? usable.find((one) => one.alias === input.model) : undefined);
    if (input.model && !found) {
      const listed = usable.map((one) => one.alias ?? one.ref).join(", ") || "none";
      throw new ToolRefusal(`${input.model} is not a model this space can use. Models: ${listed}.`);
    }
    if (input.effort && found?.reasoning === false) {
      throw new ToolRefusal(`${found.alias ?? wanted} takes no effort.`);
    }
    const effort = input.effort ?? (found?.reasoning === false ? null : parent.effort);
    return { model: found?.ref ?? wanted, effort, shown: found };
  }

  const start: ToolSpec<StartInput> = {
    name: START_SUBAGENT,
    title: "Start",
    annotations: { readOnlyHint: false },
    description: (named) =>
      `Start a subagent on a task in its own thread; returns at once. It sees only its task and instructions, plus this conversation with fork. Model and effort default to yours; others only where allowed, a model by its ref from ${named(LIST_MODELS)}.`,
    input: startInput,
    risk: () => "normal",
    async run(input, ctx) {
      try {
        const model = await chosenModel(input, ctx);
        return { ok: true, value: await startOne(input, ctx, model) };
      } catch (err) {
        if (err instanceof ToolRefusal) return { ok: false, error: err.message };
        throw err;
      }
    },
  };

  const send: ToolSpec<{ to: string | string[]; text: string }> = {
    name: SEND_SUBAGENT_MESSAGE,
    title: "Send",
    annotations: { readOnlyHint: false },
    description:
      "Message subagents by label, several or all, or the thread's agent as agent; an idle one wakes. A subagent reaches agent and the others started with it.",
    input: z.object({
      to: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .meta({ title: "To", description: "A subagent's label, several, all, or agent" }),
      text: z.string().trim().min(1).meta({ title: "Text" }),
    }),
    risk: () => "normal",
    run({ to, text }, ctx) {
      return refusing(async () => {
        const thread = await threadOf(ctx.threadId);
        const labels = typeof to === "string" ? [to] : to;
        const { from, via } = await senderOf(thread);
        const influence = await carried(thread, via);
        const call = { threadId: thread.id, callId: ctx.callId };
        const me = await subagents.find(thread.id);
        if (me) {
          const toAgent = labels.some((label) => sameName(label, AGENT));
          const others = labels.filter((label) => !sameName(label, AGENT));
          const siblings =
            others.length > 0 ? await pick(me.parentThreadId, others, me.threadId) : [];
          if (siblings.length > 0) await limitBetween(me.parentThreadId, siblings.length, call);
          if (toAgent) {
            await deliver(me.parentThreadId, {
              text,
              from,
              to: AGENT,
              influence,
              call,
              source: me.callId,
            });
          }
          for (const sibling of siblings) {
            await deliver(sibling.threadId, { text, from, to: sibling.name, influence, call });
          }
          return { sent: [...(toAgent ? [AGENT] : []), ...siblings.map((one) => one.name)] };
        }
        if (labels.some((label) => sameName(label, AGENT))) {
          throw new ToolRefusal("You are agent. Send to your subagents by label, or all.");
        }
        const recipients = await pick(thread.id, labels);
        for (const subagent of recipients) {
          await deliver(subagent.threadId, { text, from, to: subagent.name, influence, call });
        }
        return { sent: recipients.map((subagent) => subagent.name) };
      });
    },
  };

  const list: ToolSpec<{ subagent?: string }> = {
    name: "subagents.list",
    title: "List",
    annotations: { readOnlyHint: true },
    description:
      "Your subagents, or a subagent's siblings: state, last message, latest steps. One by label, or all not archived.",
    input: z.object({
      subagent: z.string().min(1).optional().meta({ title: "Subagent", description: "A label" }),
    }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(async () => {
        // A subagent reads the others started with it.
        const me = await subagents.find(ctx.threadId);
        const parentId = me?.parentThreadId ?? ctx.threadId;
        const others = (all: SubagentRecord[]) =>
          all.filter((one) => one.threadId !== me?.threadId);
        const named = (await options.toolNames?.(ctx.spaceId)) ?? ((id: string) => id);
        const detail = async (one: SubagentRecord) => detailOf(one, named);
        if (!subagent) return { subagents: await mapAsync(others(await live(parentId)), detail) };
        // A label used again picks the newest that had it.
        const found = others(await subagents.ofParents([parentId])).findLast((one) =>
          known(one, subagent),
        );
        if (!found) throw new ToolRefusal(`No subagent is labelled ${subagent}.`);
        return { subagents: [await detail(found)] };
      });
    },
  };

  const watch: ToolSpec<{ when: "all_idle" | "any_idle"; subagents?: string[] }> = {
    name: WATCH_SUBAGENTS,
    title: "Watch",
    annotations: { readOnlyHint: true },
    description:
      "Be notified once when all or any of your subagents (for a subagent, its siblings) are idle; those labelled, or all. Returns at once.",
    input: z.object({
      when: z.enum(["all_idle", "any_idle"]).meta({ title: "When" }),
      subagents: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .meta({ title: "Subagents", description: "Labels" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const me = await subagents.find(ctx.threadId);
        const parentId = me?.parentThreadId ?? ctx.threadId;
        const chosen = input.subagents
          ? await pick(parentId, input.subagents, me?.threadId)
          : (await live(parentId)).filter((one) => one.threadId !== me?.threadId);
        if (chosen.length === 0) throw new ToolRefusal("There are no subagents to watch.");
        const subjects = chosen.map((one) => one.threadId);
        // The same watch again replaces the pending one.
        const key = (ids: string[]) => ids.toSorted().join();
        const same = (await watches.setIn(ctx.threadId, "subagents")).filter(
          (old) => old.until === input.when && key(old.subjects) === key(subjects),
        );
        for (const old of same) await watches.end(old.id);
        if ((await watches.count(ctx.threadId)) >= WATCH_LIMIT) {
          throw new ToolRefusal(`You can have ${WATCH_LIMIT} watches at once. Wait for one first.`);
        }
        await watches.add({
          id: ulid(),
          threadId: ctx.threadId,
          ownerId: parentId,
          kind: "subagents",
          until: input.when,
          callId: ctx.callId,
          subjects,
        });
        // One whose subagents are idle already fires at once.
        await checkWatches(parentId);
        return {
          when: input.when,
          subagents: chosen.map((one) => ({ id: one.threadId, name: one.name })),
          ...(same.length > 0 && { note: "Already watching; replaced." }),
        };
      });
    },
  };

  const stop: ToolSpec<{ subagent: string }> = {
    name: "subagents.stop",
    title: "Stop",
    annotations: { readOnlyHint: false },
    description: "Stop a subagent's run. It keeps what it knows; a message wakes it.",
    input: z.object({ subagent: z.string().min(1).meta({ title: "Subagent" }) }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(async () => {
        const [found] = await pick(ctx.threadId, [subagent]);
        if (!(await stopRun(found!.threadId, null)))
          throw new ToolRefusal(`${found!.name} is not working.`);
        return { id: found!.threadId, name: found!.name, state: "stopped" };
      });
    },
  };

  const archive: ToolSpec<{ subagent: string }> = {
    name: "subagents.archive",
    title: "Archive",
    annotations: { readOnlyHint: false },
    description:
      "Retire a subagent: its thread stays readable, and it takes no messages until unarchived.",
    input: z.object({ subagent: z.string().min(1).meta({ title: "Subagent" }) }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(async () => {
        const [found] = await pick(ctx.threadId, [subagent]);
        await ctx.write(async () => {
          await stopRun(found!.threadId, null);
          // Archived meanwhile: nothing is stopped or changed.
          if (!(await subagents.archive(found!.threadId, now()))) {
            throw new ToolRefusal(`${found!.name} is archived already.`);
          }
        });
        signals.changed({ threadId: found!.threadId });
        await checkWatches(ctx.threadId);
        return { id: found!.threadId, name: found!.name, state: "archived" };
      });
    },
  };

  const unarchive: ToolSpec<{ subagent: string }> = {
    name: UNARCHIVE_SUBAGENT,
    title: "Unarchive",
    annotations: { readOnlyHint: false },
    description:
      "Bring back an archived subagent with what it knows. A reused label picks the newest.",
    input: z.object({ subagent: z.string().min(1).meta({ title: "Subagent" }) }),
    risk: () => "normal",
    run({ subagent: label }, ctx) {
      return refusing(async () => {
        const found = await ctx.write(async () => {
          const all = await subagents.ofParents([ctx.threadId]);
          const found = all.findLast((one) => known(one, label));
          if (!found) throw new ToolRefusal(`No subagent is labelled ${label}.`);
          if (!found.archivedAt) throw new ToolRefusal(`${found.name} is not archived.`);
          const others = await live(ctx.threadId);
          if (others.length >= LIVE_LIMIT) {
            throw new ToolRefusal(
              `This thread already has ${LIVE_LIMIT} subagents. Archive some you no longer need.`,
            );
          }
          if (others.some((other) => sameName(other.name, found.name))) {
            throw new ToolRefusal(`Another subagent is labelled ${found.name}.`);
          }
          if (!(await subagents.unarchive(found.threadId))) {
            throw new ToolRefusal(`${found.name} is not archived.`);
          }
          return found;
        });
        signals.changed({ threadId: found.threadId });
        return {
          id: found.threadId,
          name: found.name,
          state: (await summaryOf((await subagents.find(found.threadId))!)).state,
        };
      });
    },
  };

  return {
    toolset(): Toolset {
      return {
        id: SUBAGENTS_TOOLSET,
        title: "Subagents",
        source: "builtin",
        description: "Agents that work on tasks in the background",
        guidance: SUBAGENTS_GUIDANCE,
        options: [{ id: CHOOSE_MODELS, title: "Let the agent choose subagents' models" }],
        tools: [start, send, list, watch, stop, archive, unarchive],
        present,
      };
    },

    find: async (threadId: string) => subagents.find(threadId),

    // Whether the thread's agent may be started on what waits for it: not a retired subagent, nor
    // one past its starter's limit of running ones.
    mayStart,

    // What another system adds to a start: the tasks it gives, and what the framing says.
    extend(more: SubagentExtension) {
      extension = more;
    },

    // The threads the thread's agent sends messages to, retired subagents' among them, each with
    // the label it was sent by: for the agent that started subagents, theirs; for a subagent, its
    // starter's, as agent, and the others started with it.
    reach: async (threadId: string): Promise<{ threadId: string; name: string; main: boolean }[]> =>
      reachOf(threadId),

    async summaryOf(threadId: string) {
      const subagent = await subagents.find(threadId);
      return subagent ? await summaryOf(subagent) : null;
    },

    // The subagents the threads' agents started, as lists show them, retired ones among them.
    async ofParents(parentThreadIds: string[]) {
      const records = await subagents.ofParents(parentThreadIds);
      const summaries = await summariesOf(records);
      return records.map((record, index) => ({ record, summary: summaries[index]! }));
    },

    summariesOf,

    // The tools the thread's agent may call of those its space offers: for a subagent, all but
    // those only its starter has.
    async toolsOf(thread: Thread, tools: AnyToolSpec[]) {
      if (!thread.parentThreadId) return tools;
      return tools.filter((spec) => !STARTER_ONLY.has(spec.name));
    },

    // What the thread's agent is told: for a subagent, that it is one, in place of what the
    // subagents' toolset tells the agent that starts them.
    async guidance(
      thread: Thread,
      toolsets: ToolsetGuidance[],
    ): Promise<{ toolsets: ToolsetGuidance[]; subagent?: boolean }> {
      if (!thread.parentThreadId) return { toolsets };
      return {
        toolsets: toolsets.filter((toolset) => toolset.text !== SUBAGENTS_GUIDANCE),
        subagent: true,
      };
    },

    // What a subagent reads ahead of its own thread: who it is, who started it, as that thread was
    // titled when its task was sent, and its instructions; then, for one started from a copy of
    // its starter's conversation, that conversation as it was when it started, without the call
    // that started it.
    async before(thread: Thread): Promise<ModelMessage[]> {
      const subagent = thread.parentThreadId ? await subagents.find(thread.id) : null;
      if (!subagent) return [];
      const notices = (await transcript(thread.id)).rows.filter((row) => row.kind === "notice");
      const task = notices.find((row) => row.task) ?? notices[0];
      const framing = framingMessage({
        name: subagent.name,
        parent: task?.from.name ?? (await threads.find(subagent.parentThreadId))?.title ?? UNTITLED,
        ...(subagent.instructions && { instructions: subagent.instructions }),
        ...(await extension?.framing(subagent.threadId)),
      });
      const fork = task?.task?.fork;
      if (!fork) return [framing];
      const rows = (await transcript(subagent.parentThreadId)).rows.filter(
        (row) => row.seq <= fork.seq && row.id !== fork.callId,
      );
      // What changed there was its starter's, not its own.
      const copy = contextOf(await wholeWhereRead(rows, options.transcripts.whole)).messages.filter(
        (message) => message.role !== "change",
      );
      return [framing, ...copy];
    },

    // Once a subagent's run ends with nothing more to do, tells its starter's agent if it failed,
    // was stopped or ended without reporting, in the write that ends it. A subagent waiting for a
    // place starts on the worker's next pass.
    async ended(run: Run, next: Run | null) {
      const subagent = await subagents.find(run.threadId);
      if (!subagent) return;
      const quiet = run.status === "cancelled" && run.cancelSilent;
      if (!next && !subagent.archivedAt && !quiet) {
        const notice = await endNotice(subagent, run);
        if (notice) await notify(subagent.parentThreadId, notice, subagent.callId);
      }
    },

    // Fires the watches that hold: on the starter's subagents, or every open one.
    checkWatches,

    // The pass over open watches, on every instance.
    start: async () => watchPass?.start(),
    stop: async () => watchPass?.stop(),

    // Fires the watches on a subagent's starter that hold once its run's end is kept.
    async endKept(run: Run) {
      const subagent = await subagents.find(run.threadId);
      if (subagent) await checkWatches(subagent.parentThreadId);
    },

    // Brings a retired subagent back.
    async unarchive(threadId: string) {
      const found = await subagents.find(threadId);
      if (!found) throw new ServiceError(404, "Subagent not found");
      if (!found.archivedAt) throw new ServiceError(409, "This subagent is not archived");
      // Checked and changed in one write of its starter's thread, as a start is.
      const { result: subagent } = await log.write(found.parentThreadId, async () => {
        const subagent = await subagents.find(threadId);
        if (!subagent?.archivedAt) throw new ServiceError(409, "This subagent is not archived");
        const others = await live(subagent.parentThreadId);
        if (others.length >= LIVE_LIMIT) {
          throw new ServiceError(409, `The thread already has ${LIVE_LIMIT} subagents`);
        }
        if (others.some((other) => sameName(other.name, subagent.name))) {
          throw new ServiceError(409, `Another subagent is named ${subagent.name}`);
        }
        if (!(await subagents.unarchive(threadId))) {
          throw new ServiceError(409, "This subagent is not archived");
        }
        return subagent;
      });
      signals.changed({ threadId });
      signals.changed({ threadId: subagent.parentThreadId });
    },
  };
}

// A call the tool refuses, with what the model is told.
class ToolRefusal extends Error {}

// What the work gives back, or the refusal it throws.
async function refusing(work: () => unknown) {
  try {
    return { ok: true as const, value: await work() };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false as const, error: err.message };
    throw err;
  }
}

// Subagents: agents a thread's agent starts in the background, each in a child thread of its own
// with its own runs, approvals and compaction, and known everywhere by the label it was started
// with, unique among the thread's live subagents. A subagent is given its task as its first
// message, has its starter's tools but for those only the starter has, and may start from a copy of
// its starter's conversation. It works until it has nothing left to do and is idle; any message
// sent to it wakes it again. Messages between agents are notifications, and nothing goes anywhere
// unless sent: a subagent's replies stay in its own thread, and results go to the thread's agent as
// messages. That agent is notified when a subagent ended a run without sending it anything, failed
// or was stopped; and, once, when the subagents a watch was set on are idle, as a subagent is of
// the others started with it. Only a few subagents
// of a thread run at once, and the rest queue; a thread has at most a dozen that are not retired.
// Subagents started by the same agent message each other, up to a limit for all of them together,
// past which the agent that started them is told and further messages between them are refused. A
// subagent is stopped, which keeps what it knows, or retired, which keeps its thread readable and
// refuses it messages, until someone brings it back. Whose words steer what an agent does carries
// over with each message and notification it is sent, so a call any agent makes runs directly only
// when every person behind it could have made it.

import { ulid } from "ulid";
import * as z from "zod";

import { failureSentence } from "@/server/agent/failure-text.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { ModelMessage } from "@/server/models/gateway.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore } from "@/server/threads/service.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import { ASK_TOOL } from "@/shared/ask.ts";
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
  NotificationSource,
  SubagentTask,
  Sender,
  Steering,
} from "@/shared/threads/events.ts";
import { type Effort, effortSchema, UNTITLED } from "@/shared/threads/thread.ts";
import { toolIdNow } from "@/shared/tools.ts";
import { type AgentRow, type Transcript, type TranscriptRow, waking } from "@/shared/transcript.ts";

import { wholeWhereRead } from "./compaction.ts";
import { contextOf, framingMessage, type ToolsetGuidance } from "./context.ts";
import type { Notification, Notifier } from "./notifications.ts";
import { WATCH_LIMIT, type Watch, type WatchStore } from "./watches.ts";
import type { Run, RunStore } from "./runs.ts";
import type { AnyToolSpec, ToolContext, Toolset, ToolSpec } from "./tools.ts";
import { personLabel } from "@/shared/people.ts";
import { filterAsync, mapAsync } from "@/server/kernel/async.ts";

export interface SubagentRecord {
  threadId: string;
  parentThreadId: string;
  name: string;
  instructions: string | null;
  // Whether it works on its starter's task list.
  shareTasks: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface SubagentStore {
  create(
    subagent: Pick<SubagentRecord, "threadId" | "parentThreadId" | "name"> & {
      instructions?: string | null;
      shareTasks?: boolean;
    },
  ): Promise<SubagentRecord>;
  find(threadId: string): Promise<SubagentRecord | null>;
  // The subagents the threads' agents started, retired ones among them, oldest first.
  ofParents(parentThreadIds: string[]): Promise<SubagentRecord[]>;
  // Retires the subagent, or with null brings it back.
  setArchived(threadId: string, at: Date | null): Promise<void>;
  // Lets the subagent work on its starter's task list.
  setShareTasks(threadId: string): Promise<void>;
}

// What starting a subagent with tasks asks of the starter's task list.
export interface TaskHandover {
  // The reason the tasks cannot be given, or null when they can.
  check(ownerId: string, taskIds: string[]): Promise<string | null>;
  // Gives the tasks to the subagent and tells it.
  give(
    ownerId: string,
    taskIds: string[],
    subagent: { threadId: string; name: string },
  ): Promise<void>;
}

// How many of a thread's subagents run at once; the rest wait their turn.
export const RUNNING_LIMIT = 4;
// How many subagents a thread has that are not retired.
export const LIVE_LIMIT = 12;
// How many messages a thread's subagents send each other in all.
export const MESSAGE_LIMIT = 30;
// What stands for the agent of a thread where its words carried on into a subagent's thread; it
// shows as the name that agent goes by. No subagent may be labelled so.
export const AGENT_NAME = "Agent";

// What the agent of a thread that can start subagents is told about them.
export const SUBAGENTS_GUIDANCE = [
  "Use a subagent to keep large work out of this conversation: exploring many files or results, a long investigation, or parts of a job that don't depend on each other. Each runs in the background in its own thread; its report, and runs that end without one, fail or are stopped, arrive as notifications from [Subagent <label>].",
  "- Brief it as a peer who knows nothing: the goal, what you already know or ruled out, where to look, and what to return. The brief is all the context it has.\n- Ask for a short report: conclusions, decisions, ids and links, not raw data. Ask it to say what it verified and what it assumed.\n- Split work so subagents don't overlap, and run them in parallel. Plan tasks first, then start them with their task ids in tasks so they pick up and check off items on this thread's list (share_tasks alone shares the list).\n- Don't do the same work yourself while one runs. To wait, watch them and end your turn; a watch stays set until it fires, so don't set it again after each report.\n- Reuse a subagent that already has the context, archived or not, rather than starting another. Archive each once you've used its report, and all of them when the job is done.\n- Treat a report as a claim. Check anything that matters before acting on it.",
].join("\n\n");

export interface SubagentsOptions {
  subagents: SubagentStore;
  threads: Pick<ThreadStore, "create" | "find" | "eventsOfType">;
  transcripts: Pick<Transcripts, "of" | "whole">;
  runs: Pick<RunStore, "active" | "activeIn" | "latest" | "requestCancel" | "resume">;
  log: ThreadLog;
  bus: Signals;
  // Whether the agent may choose the models of the subagents it starts in the space, and the
  // models the org can use there, each with whether it takes an effort.
  choosesModels?: (spaceId: string) => Promise<boolean>;
  modelsIn?: (
    orgId: string,
  ) => Promise<{ ref: string; alias?: string; name?: string; reasoning?: boolean }[]>;
  // The starter's task list, for subagents started with tasks.
  taskHandover?: () => TaskHandover;
  // Its own `mayStart` decides whether a notified thread's agent starts.
  notifier: Notifier;
  // Agents waiting on subagents, as on tasks.
  watches: Pick<WatchStore, "add" | "on" | "setIn" | "count" | "end">;
  now?: () => Date;
}

export type Subagents = ReturnType<typeof createSubagents>;

const WATCH_SUBAGENTS = "subagents.watch";
const UNARCHIVE_SUBAGENT = "subagents.unarchive";

// The tools only the agent that started subagents has.
const STARTER_ONLY = new Set([
  START_SUBAGENT,
  "subagents.stop",
  "subagents.archive",
  UNARCHIVE_SUBAGENT,
]);

// Everyone whose words the thread's agent read, each with the agents their words came through:
// those who wrote in the thread or answered its questions, and those who steered the messages
// other agents sent it. Each person and way once.
export function steeringIn(rows: readonly TranscriptRow[]): Steering[] {
  const steering = new Map<string, Steering>();
  const add = (entry: Steering) => {
    const key = JSON.stringify([entry.userId, entry.via]);
    if (!steering.has(key)) steering.set(key, entry);
  };
  for (const row of rows) {
    if (row.kind === "human")
      add({ userId: row.author.userId, name: personLabel(row.author), via: [] });
    else if (row.kind === "relay") row.steeredBy.forEach(add);
    else if (row.kind === "tool" && row.answers && row.decision) {
      add({ userId: row.decision.by.userId, name: personLabel(row.decision.by), via: [] });
    }
  }
  return [...steering.values()];
}

// Everyone whose words steered the thread's agent, named `self`, each person once by the shortest
// way their words came: the agents it passed through, ending in `self`. The agent that started
// subagents shows as `agentName`. Null when no one did.
export function steeringParts(
  rows: readonly TranscriptRow[],
  self: string,
  agentName = AGENT_NAME,
): { name: string; via: string[] }[] | null {
  const shortest = new Map<string, Steering>();
  for (const entry of steeringIn(rows)) {
    const known = shortest.get(entry.userId);
    if (!known || entry.via.length < known.via.length) shortest.set(entry.userId, entry);
  }
  const parts = [...shortest.values()].map((entry) => ({
    name: entry.name,
    via:
      entry.via.length > 0
        ? [...entry.via.map((via) => (via === AGENT_NAME ? agentName : via)), self]
        : [],
  }));
  return parts.length > 0 ? parts : null;
}

// What a subagent waits on in its thread, if anything: a decision on a call, or answers.
function needsOf({ run, rows }: Transcript): SubagentNeeds | undefined {
  if (!run?.waitingOn) return undefined;
  const call = rows.find((row) => row.id === run.waitingOn);
  return call?.kind === "tool" && call.toolId === ASK_TOOL ? "answer" : "approval";
}

// How many messages the subagents took in, or have waiting, from one another.
function receivedFromSubagents({ rows, inbox }: Transcript) {
  return [...rows, ...inbox].filter(
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
    if (row.kind !== "tool" || row.runId !== runId || !row.output?.ok) return false;
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
  const { subagents, threads, runs, log, bus } = options;
  const now = options.now ?? (() => new Date());
  // The subagents a person stopped along with the thread that started them, whose starter is not
  // told of it, so that stopping a thread does not wake it again.
  const stoppedWithStarter = new Set<string>();

  async function transcript(threadId: string) {
    return (await options.transcripts.of(threadId)).transcript();
  }

  async function threadOf(id: string) {
    const thread = await threads.find(id);
    if (!thread) throw new Error("the thread is gone");
    return thread;
  }

  async function live(parentThreadId: string) {
    return (await subagents.ofParents([parentThreadId])).filter((subagent) => !subagent.archivedAt);
  }

  // Where the subagent stands now.
  async function summaryOf(subagent: SubagentRecord, given?: Transcript): Promise<SubagentSummary> {
    const read = given ?? (await transcript(subagent.threadId));
    const base = { threadId: subagent.threadId, name: subagent.name };
    if (subagent.archivedAt) return { ...base, state: "archived" };
    if (await runs.active(subagent.threadId)) {
      const needs = needsOf(read);
      return { ...base, state: "working", ...(needs && { needs }) };
    }
    if (waking(read.inbox).length > 0) return { ...base, state: "queued" };
    const state: SubagentState =
      (await runs.latest(subagent.threadId))?.status === "cancelled" ? "stopped" : "idle";
    return { ...base, state };
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

  const { notifier, watches } = options;

  // Sends another agent's message to the thread, with the call that sent it.
  async function deliver(
    threadId: string,
    message: {
      text: string;
      from: Sender;
      to: string;
      steeredBy: Steering[];
      task?: SubagentTask;
      call: Cause;
    },
  ) {
    const { text, from, to, steeredBy, task, call } = message;
    await notifier.send(threadId, {
      kind: "message",
      source: { ...from, callId: call.callId },
      text,
      people: steeredBy,
      to,
      ...(task && { task }),
    });
  }

  // Wakes the starter's subagents that wait for a place to run, oldest first, while places are
  // free.
  async function fillPlaces(parentThreadId: string) {
    for (const subagent of await live(parentThreadId)) {
      if (await runs.active(subagent.threadId)) continue;
      if (waking((await transcript(subagent.threadId)).inbox).length === 0) continue;
      await notifier.wake(subagent.threadId);
    }
  }

  // The subagent as the source of a notification its starter is sent, with the row it came of.
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
    return steeringIn((await transcript(subagent.threadId)).rows).map((entry) => ({
      ...entry,
      via: [...entry.via, subagent.name],
    }));
  }

  // What its starter is told of the subagent's run that ended, if anything: that it failed, was
  // stopped, or ended without sending it anything, with its last words.
  async function endNotice(subagent: SubagentRecord, run: Run): Promise<Notification | null> {
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
        people,
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
        people,
        subagents: [{ threadId: subagent.threadId, name }],
        ...withLast(last),
      };
    }
    if (reported(rows, run.id)) return null;
    return {
      kind: "agent.ended",
      source: sourceOf(subagent, lastRow?.id),
      text: `${name} ended its run without reporting.`,
      people,
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
    const people = new Map<string, Steering>();
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
      } satisfies NotificationSource as NotificationSource,
      actor: { kind: "source" as const, label: "Subagents", type: "system" as const },
      text: until === "all_idle" ? `All idle: ${names}` : `Idle: ${names}`,
      people: [...people.values()],
      subagents: idle.map((subagent) => ({ threadId: subagent.threadId, name: subagent.name })),
      when: until as "all_idle" | "any_idle",
    };
  }

  // Fires the watches on the starter's subagents that now hold, its own and its subagents', each
  // once. Those of one thread holding together with the same words are one notice, which lists the
  // calls it answers.
  async function checkWatches(parentThreadId: string) {
    const notices = new Map<string, NonNullable<Awaited<ReturnType<typeof noticeFor>>>>();
    for (const watch of await watches.on(parentThreadId, "subagents")) {
      const notice = await noticeFor(watch);
      if (!notice || !(await watches.end(watch.id))) continue;
      const key = JSON.stringify([watch.threadId, notice.text]);
      const first = notices.get(key);
      if (!first) notices.set(key, notice);
      else if (watch.callId) first.source.callIds = [...(first.source.callIds ?? []), watch.callId];
    }
    for (const [key, notice] of notices) await notifier.send(JSON.parse(key)[0] as string, notice);
  }

  // Refuses messages between the starter's subagents past the limit, telling its agent the first
  // time one is refused, and by which call.
  async function limitBetween(parentThreadId: string, sending: number, call: Cause) {
    let sent = 0;
    for (const subagent of await subagents.ofParents([parentThreadId])) {
      sent += receivedFromSubagents(await transcript(subagent.threadId));
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

  // Asks the subagent's run to stop, as the person, or as its starter's agent with null.
  async function stopRun(threadId: string, userId: string | null) {
    const run = await runs.requestCancel(threadId, userId, now());
    if (run?.status === "waiting") await runs.resume(run.id);
    if (run) bus.wake(threadId);
    return run;
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
    return steeringIn((await transcript(thread.id)).rows).map((entry) => ({
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

  // What listing tells of a subagent: where it stands, what it said last and its latest calls.
  async function detailOf(subagent: SubagentRecord) {
    const read = await transcript(subagent.threadId);
    const summary = await summaryOf(subagent, read);
    const steps = read.rows
      .filter((row) => row.kind === "tool")
      .slice(-5)
      .map((row) => ({ tool: row.toolId, state: row.state }));
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
      description: "An exact ref from thread.list_models; yours when not given",
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
    const handover = input.tasks ? options.taskHandover?.() : undefined;
    if (input.tasks && handover) {
      const refusal = await handover.check(parent.id, input.tasks);
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
      instructions: input.instructions ?? null,
      shareTasks: (input.share_tasks ?? false) || !!input.tasks,
    });
    const { from, via } = await senderOf(parent);
    await deliver(thread.id, {
      text: input.task,
      from,
      to: subagent.name,
      steeredBy: await carried(parent, via),
      task: {
        ...(input.instructions && { instructions: input.instructions }),
        ...(input.fork && { fork: { callId: ctx.callId, seq: parent.lastEventSeq } }),
      },
      call: { threadId: parent.id, callId: ctx.callId },
    });
    if (input.tasks && handover) {
      await handover.give(parent.id, input.tasks, subagent);
    }
    bus.activity({ threadId: parent.id });
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
    description:
      "Start a subagent on a task in its own thread; returns at once. It sees only its task and instructions, plus this conversation with fork. Model and effort default to yours; others only where allowed.",
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
        const steeredBy = await carried(thread, via);
        const call = { threadId: thread.id, callId: ctx.callId };
        const me = await subagents.find(thread.id);
        if (me) {
          const toAgent = labels.some((label) => sameName(label, AGENT));
          const others = labels.filter((label) => !sameName(label, AGENT));
          const siblings =
            others.length > 0 ? await pick(me.parentThreadId, others, me.threadId) : [];
          if (siblings.length > 0) await limitBetween(me.parentThreadId, siblings.length, call);
          if (toAgent) await deliver(me.parentThreadId, { text, from, to: AGENT, steeredBy, call });
          for (const sibling of siblings) {
            await deliver(sibling.threadId, { text, from, to: sibling.name, steeredBy, call });
          }
          return { sent: [...(toAgent ? [AGENT] : []), ...siblings.map((one) => one.name)] };
        }
        if (labels.some((label) => sameName(label, AGENT))) {
          throw new ToolRefusal("You are agent. Send to your subagents by label, or all.");
        }
        const recipients = await pick(thread.id, labels);
        for (const subagent of recipients) {
          await deliver(subagent.threadId, { text, from, to: subagent.name, steeredBy, call });
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
        if (!subagent) return { subagents: await mapAsync(others(await live(parentId)), detailOf) };
        // A label used again picks the newest that had it.
        const found = others(await subagents.ofParents([parentId])).findLast((one) =>
          known(one, subagent),
        );
        if (!found) throw new ToolRefusal(`No subagent is labelled ${subagent}.`);
        return { subagents: [await detailOf(found)] };
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
        await stopRun(found!.threadId, null);
        await subagents.setArchived(found!.threadId, now());
        bus.activity({ threadId: found!.threadId });
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
        await subagents.setArchived(found.threadId, null);
        bus.activity({ threadId: found.threadId });
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
      };
    },

    find: async (threadId: string) => subagents.find(threadId),

    // Whether the thread's agent may be started on what waits for it: not a retired subagent, nor
    // one past its starter's limit of running ones.
    mayStart,

    // Lets the subagent work on its starter's task list, if it does not already.
    async shareTasks(threadId: string) {
      const subagent = await subagents.find(threadId);
      if (subagent && !subagent.shareTasks) await subagents.setShareTasks(threadId);
    },

    // The threads the thread's agent sends messages to, retired subagents' among them, each with
    // the label it was sent by: for the agent that started subagents, theirs; for a subagent, its
    // starter's, as agent, and the others started with it.
    async reach(threadId: string): Promise<{ threadId: string; name: string; main: boolean }[]> {
      const me = await subagents.find(threadId);
      const parentId = me?.parentThreadId ?? threadId;
      const others = (await subagents.ofParents([parentId]))
        .filter((subagent) => subagent.threadId !== threadId)
        .map((subagent) => ({ threadId: subagent.threadId, name: subagent.name, main: false }));
      return me ? [{ threadId: parentId, name: AGENT, main: true }, ...others] : others;
    },

    async summaryOf(threadId: string) {
      const subagent = await subagents.find(threadId);
      return subagent ? await summaryOf(subagent) : null;
    },

    // The subagents the threads' agents started, as lists show them, retired ones among them.
    async ofParents(parentThreadIds: string[]) {
      return await Promise.all(
        (await subagents.ofParents(parentThreadIds)).map(async (subagent) => ({
          record: subagent,
          summary: await summaryOf(subagent),
        })),
      );
    },

    // The tools the thread's agent may call of those its space offers: for a subagent, all but
    // those only its starter has.
    async toolsOf(thread: Thread, tools: AnyToolSpec[]) {
      if (!(await subagents.find(thread.id))) return tools;
      return tools.filter((spec) => !STARTER_ONLY.has(spec.name));
    },

    // What the thread's agent is told: for a subagent, that it is one, in place of what the
    // subagents' toolset tells the agent that starts them.
    async guidance(
      thread: Thread,
      toolsets: ToolsetGuidance[],
    ): Promise<{ toolsets: ToolsetGuidance[]; subagent?: boolean }> {
      if (!(await subagents.find(thread.id))) return { toolsets };
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
      const subagent = await subagents.find(thread.id);
      if (!subagent) return [];
      const relays = (await transcript(thread.id)).rows.filter((row) => row.kind === "relay");
      const task = relays.find((row) => row.task) ?? relays[0];
      const framing = framingMessage({
        name: subagent.name,
        parent: task?.from.name ?? (await threads.find(subagent.parentThreadId))?.title ?? UNTITLED,
        ...(subagent.instructions && { instructions: subagent.instructions }),
        ...(subagent.shareTasks && { sharesTasks: true }),
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
    // was stopped or ended without reporting, lets the next subagent waiting for a place run, and
    // fires the watches that now hold.
    async ended(run: Run) {
      const subagent = await subagents.find(run.threadId);
      if (!subagent) return;
      const quiet = run.status === "cancelled" && stoppedWithStarter.delete(subagent.threadId);
      if (!(await runs.active(subagent.threadId)) && !subagent.archivedAt && !quiet) {
        const notice = await endNotice(subagent, run);
        if (notice) await notifier.send(subagent.parentThreadId, notice);
      }
      await fillPlaces(subagent.parentThreadId);
      await checkWatches(subagent.parentThreadId);
    },

    // Asks every running subagent of the thread's agent to stop, as the person; whether any was.
    async stopAll(parentThreadId: string, userId: string) {
      let any = false;
      for (const subagent of await live(parentThreadId)) {
        if (!(await stopRun(subagent.threadId, userId))) continue;
        stoppedWithStarter.add(subagent.threadId);
        any = true;
      }
      return any;
    },

    // Brings a retired subagent back.
    async unarchive(threadId: string) {
      const subagent = await subagents.find(threadId);
      if (!subagent?.archivedAt) throw new ServiceError(409, "This subagent is not archived");
      if ((await live(subagent.parentThreadId)).length >= LIVE_LIMIT) {
        throw new ServiceError(409, `The thread already has ${LIVE_LIMIT} subagents`);
      }
      if (
        (await live(subagent.parentThreadId)).some((other) => sameName(other.name, subagent.name))
      ) {
        throw new ServiceError(409, `Another subagent is named ${subagent.name}`);
      }
      await subagents.setArchived(threadId, null);
      bus.activity({ threadId });
      bus.activity({ threadId: subagent.parentThreadId });
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

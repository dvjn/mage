// Subagents: agents a thread's agent starts in the background, each in a child thread of its own
// with its own runs, approvals and compaction, and known everywhere by the label it was started
// with, unique among the thread's live subagents. A subagent is given its task as its first
// message, has its starter's tools but for those only the starter has, and may start from a copy of
// its starter's conversation. It works until it has nothing left to do and is idle; any message
// sent to it wakes it again. Messages between agents wait in the receiver's inbox like a person's
// steer, and nothing goes anywhere unless sent: a subagent's replies stay in its own thread, and
// results go to the thread's agent as messages. That agent is told, once its own run pauses, when a
// subagent ended a run, in one line. Only a few subagents of a thread run at once, and the rest
// queue; a thread has at most a dozen that are not retired. Subagents started by the same agent
// message each other, up to a limit for all of them together, past which the agent that started
// them is told and further messages between them are refused. A subagent is stopped, which keeps
// what it knows, or retired, which keeps its thread readable and refuses it messages, until someone
// brings it back. Whose words steer what an agent does carries over with each message it is sent,
// so a call any agent makes runs directly only when every person behind it could have made it.

import * as z from "zod";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { ModelMessage } from "@/server/models/gateway.ts";
import { eventSummary, type Append, type ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore } from "@/server/threads/service.ts";
import { ASK_TOOL } from "@/shared/ask.ts";
import {
  AGENT,
  SUBAGENTS_TOOLSET,
  SEND_SUBAGENT_MESSAGE,
  START_SUBAGENT,
  type SubagentNeeds,
  type SubagentState,
  type SubagentSummary,
} from "@/shared/subagents.ts";
import type { SubagentTask, Sender, Steering } from "@/shared/threads/events.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";
import { toolIdNow } from "@/shared/tools.ts";
import {
  type AgentRow,
  type Transcript,
  type TranscriptRow,
  transcriptOf,
} from "@/shared/transcript.ts";

import { readOf } from "./compaction.ts";
import { contextOf, type SubagentGuidance, lastLine } from "./context.ts";
import { type Run, type RunStore, startRun } from "./runs.ts";
import type { AnyToolSpec, Toolset, ToolSpec } from "./tools.ts";

export interface SubagentRecord {
  threadId: string;
  parentThreadId: string;
  name: string;
  instructions: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface SubagentStore {
  create(
    subagent: Pick<SubagentRecord, "threadId" | "parentThreadId" | "name"> & {
      instructions?: string | null;
    },
  ): SubagentRecord;
  find(threadId: string): SubagentRecord | null;
  // The subagents the threads' agents started, retired ones among them, oldest first.
  ofParents(parentThreadIds: string[]): SubagentRecord[];
  // Retires the subagent, or with null brings it back.
  setArchived(threadId: string, at: Date | null): void;
}

// How many of a thread's subagents run at once; the rest wait their turn.
export const RUNNING_LIMIT = 4;
// How many subagents a thread has that are not retired.
export const LIVE_LIMIT = 12;
// How many messages a thread's subagents send each other in all.
export const MESSAGE_LIMIT = 30;
// How long a wait for subagents lasts when not told, and at most, in seconds.
const WAIT_SECONDS = 120;
const WAIT_LIMIT_SECONDS = 600;
// What the agent of a thread is named where its words carried on into a subagent's thread, and as
// it shows.
export const AGENT_NAME = "Agent";

// What the agent of a thread that can start subagents is told about them.
export const SUBAGENTS_GUIDANCE = [
  "You can start subagents: agents that work in the background, each in a thread of its own, on a task you give them. Use them for work that splits into independent parts, or that would take long.",
  "Each subagent goes by the label you start it with, unique among those not archived; address it by that. It sees only its task and instructions, unless you start it with fork from a copy of this conversation. It sends you its results as messages, which start with [Subagent <label>]. When a subagent finishes a run you are told in a line starting with [Subagents]; list them for more.",
  "Send a subagent a message to give it more to do; one that is idle wakes up. Wait for subagents only when you cannot go on without them. Archive those you no longer need.",
].join("\n");

export interface SubagentsOptions {
  subagents: SubagentStore;
  threads: Pick<ThreadStore, "create" | "find" | "eventsAfter">;
  runs: Pick<RunStore, "active" | "activeIn" | "create" | "latest" | "requestCancel" | "resume">;
  log: ThreadLog;
  bus: EventBus;
  now?: () => Date;
}

export type Subagents = ReturnType<typeof createSubagents>;

// The tools only the agent that started subagents has.
const STARTER_ONLY = new Set([
  START_SUBAGENT,
  "subagents.wait",
  "subagents.stop",
  "subagents.archive",
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
    if (row.kind === "human") add({ userId: row.author.userId, name: row.author.name, via: [] });
    else if (row.kind === "relay") row.steeredBy.forEach(add);
    else if (row.kind === "tool" && row.answers && row.decision) {
      add({ userId: row.decision.by.userId, name: row.decision.by.name, via: [] });
    }
  }
  return [...steering.values()];
}

// Everyone whose words steered the thread's agent, named `self`, in one line, each person once by
// the shortest way their words came: "Steered by Ada Lovelace, and Priya Nair via Critic → Writer".
export function steeringLine(rows: readonly TranscriptRow[], self: string) {
  const shortest = new Map<string, Steering>();
  for (const entry of steeringIn(rows)) {
    const known = shortest.get(entry.userId);
    if (!known || entry.via.length < known.via.length) shortest.set(entry.userId, entry);
  }
  const names = [...shortest.values()].map((entry) =>
    entry.via.length > 0 ? `${entry.name} via ${[...entry.via, self].join(" → ")}` : entry.name,
  );
  if (names.length === 0) return null;
  const listed =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)!}`;
  return `Steered by ${listed}`;
}

// What a subagent waits on in its thread, if anything: a decision on a call, or answers.
function needsOf({ run, rows }: Transcript): SubagentNeeds | undefined {
  if (!run?.waitingOn) return undefined;
  const call = rows.find((row) => row.id === run.waitingOn);
  return call?.kind === "tool" && call.toolId === ASK_TOOL ? "answer" : "approval";
}

// The messages the subagent exchanged with each of the others started with it, by their labels:
// those it took in or has waiting, and those it sent.
function talksOf({ rows, inbox }: Transcript) {
  const counts = new Map<string, number>();
  const add = (name: string, count = 1) => counts.set(name, (counts.get(name) ?? 0) + count);
  for (const message of [...rows, ...inbox]) {
    if ("from" in message && !message.from.main) add(message.from.name);
  }
  for (const row of rows) {
    if (row.kind !== "tool" || toolIdNow(row.toolId) !== SEND_SUBAGENT_MESSAGE || !row.output?.ok)
      continue;
    const sent = (row.output.value as { sent?: unknown } | null)?.sent;
    if (!Array.isArray(sent)) continue;
    for (const name of sent) if (typeof name === "string" && name !== AGENT) add(name);
  }
  return [...counts].map(([name, messages]) => ({ with: name, messages }));
}

// How many messages the subagents took in, or have waiting, from one another.
function receivedFromSubagents({ rows, inbox }: Transcript) {
  return [...rows, ...inbox].filter((message) => "from" in message && !message.from.main).length;
}

// The last thing the subagent said in its thread.
function lastSaid(rows: readonly TranscriptRow[]) {
  return rows.findLast((row): row is AgentRow => row.kind === "agent" && !!row.text)?.text ?? "";
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

  function transcript(threadId: string) {
    return transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary));
  }

  function threadOf(id: string) {
    const thread = threads.find(id);
    if (!thread) throw new Error("the thread is gone");
    return thread;
  }

  function live(parentThreadId: string) {
    return subagents.ofParents([parentThreadId]).filter((subagent) => !subagent.archivedAt);
  }

  // Where the subagent stands now.
  function summaryOf(
    subagent: SubagentRecord,
    read = transcript(subagent.threadId),
  ): SubagentSummary {
    const talks = talksOf(read);
    const base = {
      threadId: subagent.threadId,
      name: subagent.name,
      ...(talks.length > 0 && { talks }),
    };
    if (subagent.archivedAt) return { ...base, state: "archived" };
    if (runs.active(subagent.threadId)) {
      const needs = needsOf(read);
      return { ...base, state: "working", ...(needs && { needs }) };
    }
    if (read.inbox.length > 0) return { ...base, state: "queued" };
    const state: SubagentState =
      runs.latest(subagent.threadId)?.status === "cancelled" ? "stopped" : "idle";
    return { ...base, state };
  }

  // Starts the thread's agent on the messages other agents left it, when it is idle and, for a
  // subagent, when fewer than the limit of its starter's subagents are running.
  function startIfFree(threadId: string, append: Append) {
    if (runs.active(threadId)) return;
    const { inbox } = transcript(threadId);
    if (inbox.length === 0) return;
    const subagent = subagents.find(threadId);
    if (subagent) {
      if (subagent.archivedAt) return;
      const siblings = live(subagent.parentThreadId).map((other) => other.threadId);
      if (runs.activeIn(siblings).length >= RUNNING_LIMIT) return;
    }
    startRun(
      runs,
      append,
      { threadId, triggerSeq: inbox[0]!.seq, createdBy: null },
      inbox.map((message) => message.id),
    );
  }

  // Leaves another agent's message in the thread's inbox, and wakes its agent when it may run.
  function deliver(
    threadId: string,
    message: {
      text: string;
      from: Sender;
      to: string;
      steeredBy: Steering[];
      task?: SubagentTask;
    },
  ) {
    log.write(threadId, (append) => {
      const { text, ...rest } = message;
      append({
        type: "agent.message",
        actor: { kind: "agent" },
        data: { parts: [{ type: "text", text }], ...rest },
      });
      startIfFree(threadId, append);
    });
    bus.wake(threadId);
  }

  // Wakes the starter's subagents that wait for a place to run, oldest first, while places are
  // free.
  function fillPlaces(parentThreadId: string) {
    for (const subagent of live(parentThreadId)) {
      if (runs.active(subagent.threadId)) continue;
      if (transcript(subagent.threadId).inbox.length === 0) continue;
      log.write(subagent.threadId, (append) => startIfFree(subagent.threadId, append));
      bus.wake(subagent.threadId);
    }
  }

  // Refuses messages between the starter's subagents past the limit, telling its agent the first
  // time one is refused.
  function limitBetween(parentThreadId: string, sending: number) {
    const sent = subagents
      .ofParents([parentThreadId])
      .reduce((total, subagent) => total + receivedFromSubagents(transcript(subagent.threadId)), 0);
    if (sent + sending <= MESSAGE_LIMIT) return;
    const told = threads
      .eventsAfter(parentThreadId, 0)
      .some((event) => event.type === "subagent.limited");
    if (!told) {
      log.write(parentThreadId, (append) =>
        append({
          type: "subagent.limited",
          actor: { kind: "agent" },
          data: { limit: MESSAGE_LIMIT },
        }),
      );
    }
    throw new ToolRefusal(
      `Your subagents have sent each other ${MESSAGE_LIMIT} messages, the most they may. Send what you have to agent instead.`,
    );
  }

  // Asks the subagent's run to stop, as the person, or as its starter's agent with null.
  function stopRun(threadId: string, userId: string | null) {
    const run = runs.requestCancel(threadId, userId, now());
    if (run?.status === "waiting") runs.resume(run.id);
    if (run) bus.wake(threadId);
    return run;
  }

  // The sender of the thread's agent's messages, and what its people's ways read once they pass
  // through it.
  function senderOf(thread: Thread): { from: Sender; via: string } {
    const subagent = subagents.find(thread.id);
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
  function carried(thread: Thread, via: string) {
    return steeringIn(transcript(thread.id).rows).map((entry) => ({
      ...entry,
      via: [...entry.via, via],
    }));
  }

  // The live subagents of the starter's agent the labels pick, or the thread ids, but the one
  // excepted; all of them for "all". Throws naming those it does not know.
  function pick(parentThreadId: string, labels: readonly string[], except?: string) {
    const all = live(parentThreadId).filter((subagent) => subagent.threadId !== except);
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
  function detailOf(subagent: SubagentRecord) {
    const read = transcript(subagent.threadId);
    const summary = summaryOf(subagent, read);
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

  const start: ToolSpec<{
    name: string;
    task: string;
    instructions?: string;
    fork?: boolean;
  }> = {
    name: START_SUBAGENT,
    title: "Start",
    annotations: { readOnlyHint: false },
    description:
      "Start a subagent in the background on a task, in a thread of its own; returns at once. It sees only its task and instructions, or with fork a copy of this conversation too.",
    input: z.object({
      name: nameSchema.meta({
        title: "Name",
        description:
          "A short label it goes by, unique among your subagents, such as Researcher · Graphile",
      }),
      task: z.string().trim().min(1).meta({ title: "Task" }),
      instructions: z.string().trim().min(1).optional().meta({ title: "Instructions" }),
      fork: z
        .boolean()
        .optional()
        .meta({ title: "Fork", description: "Start it from a copy of this conversation" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(() => {
        const parent = threadOf(ctx.threadId);
        if (subagents.find(parent.id)) throw new ToolRefusal("Subagents cannot start subagents.");
        const others = live(parent.id);
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
        const thread = threads.create({
          spaceId: parent.spaceId,
          model: parent.model,
          effort: parent.effort,
          createdBy: null,
          parentThreadId: parent.id,
          rootThreadId: parent.rootThreadId ?? parent.id,
          title: input.name,
          titleSource: "agent",
        });
        const subagent = subagents.create({
          threadId: thread.id,
          parentThreadId: parent.id,
          name: input.name,
          instructions: input.instructions ?? null,
        });
        const { from, via } = senderOf(parent);
        deliver(thread.id, {
          text: input.task,
          from,
          to: subagent.name,
          steeredBy: carried(parent, via),
          task: {
            ...(input.instructions && { instructions: input.instructions }),
            ...(input.fork && { fork: { callId: ctx.callId, seq: parent.lastEventSeq } }),
          },
        });
        bus.activity({ threadId: parent.id });
        return { id: thread.id, name: subagent.name, state: summaryOf(subagent).state };
      });
    },
  };

  const send: ToolSpec<{ to: string | string[]; text: string }> = {
    name: SEND_SUBAGENT_MESSAGE,
    title: "Send",
    annotations: { readOnlyHint: false },
    description:
      "Send a message to subagents by label, several, or all, or to agent, the thread's agent; an idle subagent wakes up. A subagent reaches agent and the other subagents started with it.",
    input: z.object({
      to: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .meta({ title: "To", description: "A subagent's label, several, all, or agent" }),
      text: z.string().trim().min(1).meta({ title: "Text" }),
    }),
    risk: () => "normal",
    run({ to, text }, ctx) {
      return refusing(() => {
        const thread = threadOf(ctx.threadId);
        const labels = typeof to === "string" ? [to] : to;
        const { from, via } = senderOf(thread);
        const steeredBy = carried(thread, via);
        const me = subagents.find(thread.id);
        if (me) {
          const toAgent = labels.some((label) => sameName(label, AGENT));
          const others = labels.filter((label) => !sameName(label, AGENT));
          const siblings = others.length > 0 ? pick(me.parentThreadId, others, me.threadId) : [];
          if (siblings.length > 0) limitBetween(me.parentThreadId, siblings.length);
          if (toAgent) deliver(me.parentThreadId, { text, from, to: AGENT, steeredBy });
          for (const sibling of siblings) {
            deliver(sibling.threadId, { text, from, to: sibling.name, steeredBy });
          }
          return { sent: [...(toAgent ? [AGENT] : []), ...siblings.map((one) => one.name)] };
        }
        if (labels.some((label) => sameName(label, AGENT))) {
          throw new ToolRefusal("You are agent. Send to your subagents by label, or all.");
        }
        const recipients = pick(thread.id, labels);
        for (const subagent of recipients) {
          deliver(subagent.threadId, { text, from, to: subagent.name, steeredBy });
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
      "List your subagents, or the others started with you: where each stands, what it said last and its latest steps. One by label, or all that are not archived.",
    input: z.object({
      subagent: z.string().min(1).optional().meta({ title: "Subagent", description: "A label" }),
    }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(() => {
        // A subagent reads the others started with it.
        const me = subagents.find(ctx.threadId);
        const parentId = me?.parentThreadId ?? ctx.threadId;
        const others = (all: SubagentRecord[]) =>
          all.filter((one) => one.threadId !== me?.threadId);
        if (!subagent) return { subagents: others(live(parentId)).map(detailOf) };
        // A label used again picks the newest that had it.
        const found = others(subagents.ofParents([parentId])).findLast((one) =>
          known(one, subagent),
        );
        if (!found) throw new ToolRefusal(`No subagent is labelled ${subagent}.`);
        return { subagents: [detailOf(found)] };
      });
    },
  };

  const wait: ToolSpec<{ subagents?: string[]; timeout?: number }> = {
    name: "subagents.wait",
    title: "Wait",
    annotations: { readOnlyHint: true },
    description:
      "Wait until the subagents labelled, or all, are no longer working, or until the timeout in seconds; returns where they stand.",
    input: z.object({
      subagents: z
        .array(z.string().min(1))
        .optional()
        .meta({ title: "Subagents", description: "Labels" }),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(WAIT_LIMIT_SECONDS)
        .optional()
        .meta({ title: "Timeout", description: "Seconds" }),
    }),
    risk: () => "normal",
    async run(input, ctx) {
      let chosen: SubagentRecord[];
      try {
        chosen = input.subagents ? pick(ctx.threadId, input.subagents) : live(ctx.threadId);
      } catch (err) {
        if (err instanceof ToolRefusal) return { ok: false, error: err.message };
        throw err;
      }
      const ids = new Set(chosen.map((subagent) => subagent.threadId));
      const busy = () =>
        chosen.some((subagent) => {
          const state = summaryOf(subagents.find(subagent.threadId) ?? subagent).state;
          return state === "working" || state === "queued";
        });
      const timedOut = await new Promise<boolean>((resolve) => {
        if (!busy() || ctx.signal?.aborted) return resolve(false);
        const finish = (out: boolean) => {
          clearTimeout(timer);
          stop();
          ctx.signal?.removeEventListener("abort", aborted);
          resolve(out);
        };
        const aborted = () => finish(false);
        const timer = setTimeout(() => finish(true), (input.timeout ?? WAIT_SECONDS) * 1000);
        const stop = bus.onActivity((change) => {
          if (ids.has(change.threadId) && !change.read && !busy()) finish(false);
        });
        ctx.signal?.addEventListener("abort", aborted, { once: true });
      });
      const now = chosen.map((subagent) => detailOf(subagents.find(subagent.threadId) ?? subagent));
      return { ok: true, value: { timedOut, subagents: now } };
    },
  };

  const stop: ToolSpec<{ subagent: string }> = {
    name: "subagents.stop",
    title: "Stop",
    annotations: { readOnlyHint: false },
    description: "Stop a subagent's run. It keeps what it knows, and a message wakes it again.",
    input: z.object({ subagent: z.string().min(1).meta({ title: "Subagent" }) }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(() => {
        const [found] = pick(ctx.threadId, [subagent]);
        if (!stopRun(found!.threadId, null))
          throw new ToolRefusal(`${found!.name} is not working.`);
        return { name: found!.name, state: "stopped" };
      });
    },
  };

  const archive: ToolSpec<{ subagent: string }> = {
    name: "subagents.archive",
    title: "Archive",
    annotations: { readOnlyHint: false },
    description:
      "Retire a subagent you no longer need: its thread stays readable, and it takes no more messages.",
    input: z.object({ subagent: z.string().min(1).meta({ title: "Subagent" }) }),
    risk: () => "normal",
    run({ subagent }, ctx) {
      return refusing(() => {
        const [found] = pick(ctx.threadId, [subagent]);
        stopRun(found!.threadId, null);
        subagents.setArchived(found!.threadId, now());
        bus.activity({ threadId: found!.threadId });
        return { name: found!.name, state: "archived" };
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
        tools: [start, send, list, wait, stop, archive],
      };
    },

    find: (threadId: string) => subagents.find(threadId),

    summaryOf(threadId: string) {
      const subagent = subagents.find(threadId);
      return subagent ? summaryOf(subagent) : null;
    },

    // The subagents the threads' agents started, as lists show them, retired ones among them.
    ofParents(parentThreadIds: string[]) {
      return subagents.ofParents(parentThreadIds).map((subagent) => ({
        record: subagent,
        summary: summaryOf(subagent),
      }));
    },

    // The tools the thread's agent may call of those its space offers: for a subagent, all but
    // those only its starter has.
    toolsOf(thread: Thread, tools: AnyToolSpec[]) {
      if (!subagents.find(thread.id)) return tools;
      return tools.filter((spec) => !STARTER_ONLY.has(spec.name));
    },

    // What the thread's agent is told: for a subagent, what it is, in place of what the subagents'
    // toolset tells the agent that starts them.
    guidance(
      thread: Thread,
      toolsets: string[],
    ): { toolsets: string[]; subagent?: SubagentGuidance } {
      const subagent = subagents.find(thread.id);
      if (!subagent) return { toolsets };
      const parent = threads.find(subagent.parentThreadId);
      return {
        toolsets: toolsets.filter((text) => text !== SUBAGENTS_GUIDANCE),
        subagent: {
          name: subagent.name,
          parent: parent?.title ?? UNTITLED,
          ...(subagent.instructions && { instructions: subagent.instructions }),
        },
      };
    },

    // For a subagent started from a copy of its starter's conversation, that conversation as it was
    // when it started, without the call that started it.
    before(thread: Thread): ModelMessage[] {
      if (!thread.parentThreadId) return [];
      const task = transcript(thread.id).rows.find((row) => row.kind === "relay")?.task;
      const fork = task?.fork;
      if (!fork) return [];
      const rows = transcript(thread.parentThreadId).rows.filter(
        (row) => row.seq <= fork.seq && row.id !== fork.callId,
      );
      const { summary } = readOf(rows);
      return [
        ...(summary
          ? [{ role: "user" as const, text: `[Summary of the earlier conversation] ${summary}` }]
          : []),
        ...contextOf(rows).messages,
      ];
    },

    // Once a subagent's run ends with nothing more to do, tells its starter's agent where it
    // stands, and lets the next subagent waiting for a place run.
    ended(run: Run) {
      const subagent = subagents.find(run.threadId);
      if (!subagent) return;
      if (!runs.active(subagent.threadId) && !subagent.archivedAt) {
        const { rows } = transcript(subagent.threadId);
        const failure = rows.findLast((row) => row.kind === "failure");
        const state =
          run.status === "cancelled" ? "stopped" : run.status === "failed" ? "failed" : "idle";
        const last =
          state === "failed" && failure?.kind === "failure" ? failure.error : lastSaid(rows);
        log.write(subagent.parentThreadId, (append) =>
          append({
            type: "subagent.ended",
            actor: { kind: "agent" },
            data: { threadId: subagent.threadId, name: subagent.name, state, last: lastLine(last) },
          }),
        );
      }
      fillPlaces(subagent.parentThreadId);
    },

    // Asks every running subagent of the thread's agent to stop, as the person; whether any was.
    stopAll(parentThreadId: string, userId: string) {
      let any = false;
      for (const subagent of live(parentThreadId)) {
        if (stopRun(subagent.threadId, userId)) any = true;
      }
      return any;
    },

    // Brings a retired subagent back.
    unarchive(threadId: string) {
      const subagent = subagents.find(threadId);
      if (!subagent?.archivedAt) throw new ServiceError(409, "This subagent is not archived");
      if (live(subagent.parentThreadId).length >= LIVE_LIMIT) {
        throw new ServiceError(409, `The thread already has ${LIVE_LIMIT} subagents`);
      }
      if (live(subagent.parentThreadId).some((other) => sameName(other.name, subagent.name))) {
        throw new ServiceError(409, `Another subagent is named ${subagent.name}`);
      }
      subagents.setArchived(threadId, null);
      bus.activity({ threadId });
      bus.activity({ threadId: subagent.parentThreadId });
    },
  };
}

// A call the tool refuses, with what the model is told.
class ToolRefusal extends Error {}

// What the work gives back, or the refusal it throws.
function refusing<T>(work: () => T) {
  try {
    return Promise.resolve({ ok: true as const, value: work() as unknown });
  } catch (err) {
    if (err instanceof ToolRefusal)
      return Promise.resolve({ ok: false as const, error: err.message });
    return Promise.reject(err);
  }
}

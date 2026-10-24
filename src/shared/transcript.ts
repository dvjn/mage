// A thread's events folded into what people see: the transcript in the order the agent saw it,
// the messages it has not taken in yet, and the run under way. A person's message takes its place
// when the agent takes it in, or where it was posted when it is a quiet aside; an agent reply takes
// the place its run reserved when the reply began. A reply cut short and then tried again stays in
// view but is left out of what the agent reads. A tool call the agent asked for sits where it asked,
// and carries how it was decided and what it gave back.

import {
  type ActorSummary,
  type AnyThreadEvent,
  type Delivery,
  type FailureKind,
  type ReplyPart,
  type ReplyStatus,
  type RunReason,
  threadEventSchema,
  type ToolRisk,
  type ToolScope,
  type Usage,
} from "@/shared/threads.ts";

type Person = Extract<ActorSummary, { kind: "user" }>;

export interface HumanRow {
  kind: "human";
  // The message's id.
  id: string;
  // Where it sits in the transcript.
  seq: number;
  author: Person;
  postedAt: string;
  text: string;
  quiet: boolean;
  // Written by a guest of the thread.
  guest?: true;
}

export interface AgentRow {
  kind: "agent";
  // The reply's message id.
  id: string;
  seq: number;
  runId: string;
  // The model ref it was written with, when known.
  model: string | null;
  startedAt: string;
  text: string;
  // What the model thought before it answered, and for how long, when it says.
  reasoning: string;
  thoughtMs: number | null;
  status: "streaming" | ReplyStatus;
  // The tokens its model step used, once it finished.
  usage: Usage | null;
  // A later run tried the reply again.
  retried: boolean;
}

// A run that ended without finishing, and why.
export interface FailureRow {
  kind: "failure";
  id: string;
  seq: number;
  runId: string;
  error: string;
  failure?: FailureKind;
  connection?: "codex" | "claude";
  detail?: string;
  resetsAt?: string;
}

// Someone stopped the run.
export interface StopRow {
  kind: "stop";
  id: string;
  seq: number;
  runId: string;
  by: string | null;
}

// Where a tool call stands: waiting for a decision, approved and about to run, denied, ran or
// failed, denied because its approval no longer held, or left when its run ended.
export type ToolState = "pending" | "allowed" | "denied" | "ran" | "failed" | "stale" | "stopped";

// A tool call the agent asked for.
export interface ToolRow {
  kind: "tool";
  // The call's id.
  id: string;
  seq: number;
  runId: string;
  // The reply whose model step asked for it.
  messageId: string;
  toolId: string;
  input: unknown;
  risk: ToolRisk;
  // It needed a person's approval when asked for.
  waits: boolean;
  requestedAt: string;
  state: ToolState;
  // Who approved or denied it, how, and where in the thread.
  decision: { allow: boolean; scope: ToolScope; by: Person; seq: number } | null;
  // What it gave back, or why it failed, once it ran, and how long that took.
  output: { ok: true; value: unknown } | { ok: false; error: string } | null;
  ms: number | null;
}

// An event this client does not know how to show.
export interface UnknownRow {
  kind: "unknown";
  id: string;
  seq: number;
  type: string;
}

export type TranscriptRow = HumanRow | AgentRow | ToolRow | FailureRow | StopRow | UnknownRow;

// A message posted while the agent was busy, waiting to be taken in.
export interface PendingMessage {
  id: string;
  seq: number;
  author: Person;
  postedAt: string;
  text: string;
  mode: Delivery;
  // Written by a guest of the thread.
  guest?: true;
}

export interface ActiveRun {
  id: string;
  // Whoever's message woke the agent, or null for a retry.
  startedBy: string | null;
  reason: RunReason | null;
  createdAt: string;
  // The tool call it waits on a decision for, if any.
  waitingOn: string | null;
}

export interface Transcript {
  rows: TranscriptRow[];
  pending: PendingMessage[];
  run: ActiveRun | null;
  // The tokens every model call in the thread used.
  usage: Usage;
}

function textOf(parts: ReplyPart[], type: ReplyPart["type"] = "text") {
  return parts
    .filter((part) => part.type === type)
    .map((part) => part.text)
    .join("");
}

// A reply still being written: its answer and its reasoning so far.
export interface StreamingReply {
  text: string;
  reasoning: string;
}

// `streaming` holds the replies still being written, by message id.
export function transcriptOf(
  events: readonly AnyThreadEvent[],
  streaming: ReadonlyMap<string, StreamingReply> = new Map(),
): Transcript {
  const rows: TranscriptRow[] = [];
  const pending = new Map<string, PendingMessage>();
  const replies = new Map<string, AgentRow>();
  const calls = new Map<string, ToolRow>();
  let run: ActiveRun | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for (const raw of events) {
    const parsed = threadEventSchema.safeParse(raw);
    if (!parsed.success) {
      rows.push({ kind: "unknown", id: raw.id, seq: raw.seq, type: raw.type });
      continue;
    }
    const event = parsed.data;
    switch (event.type) {
      case "message": {
        if (event.actor.kind !== "user") break;
        const message = {
          id: event.id,
          seq: event.seq,
          author: event.actor,
          postedAt: event.createdAt,
          text: textOf(event.data.parts),
          ...(event.data.guest && { guest: true as const }),
        };
        if (event.data.quiet) rows.push({ kind: "human", ...message, quiet: true });
        else pending.set(event.id, { ...message, mode: event.data.mode });
        break;
      }
      case "message.changed": {
        const message = pending.get(event.data.messageId);
        if (!message) break;
        if (event.data.parts) message.text = textOf(event.data.parts);
        if (event.data.mode) message.mode = event.data.mode;
        break;
      }
      case "message.withdrawn":
      case "message.dropped":
        pending.delete(event.data.messageId);
        break;
      case "message.admitted":
        for (const id of event.data.messageIds) {
          const message = pending.get(id);
          if (!message) continue;
          pending.delete(id);
          const { mode: _mode, ...admitted } = message;
          rows.push({ kind: "human", ...admitted, seq: event.seq, quiet: false });
        }
        break;
      case "message.started": {
        const reply: AgentRow = {
          kind: "agent",
          id: event.data.messageId,
          seq: event.seq,
          runId: event.data.runId,
          model: event.data.model ?? null,
          startedAt: event.createdAt,
          text: streaming.get(event.data.messageId)?.text ?? "",
          reasoning: streaming.get(event.data.messageId)?.reasoning ?? "",
          thoughtMs: null,
          status: "streaming",
          usage: null,
          retried: false,
        };
        replies.set(reply.id, reply);
        rows.push(reply);
        break;
      }
      case "message.completed": {
        const reply = replies.get(event.data.messageId);
        if (!reply) break;
        reply.text = textOf(event.data.parts);
        reply.reasoning = textOf(event.data.parts, "reasoning");
        reply.thoughtMs =
          event.data.parts.find((part) => part.type === "reasoning")?.durationMs ?? null;
        reply.status = event.data.status;
        if (event.data.usage) {
          reply.usage = event.data.usage;
          usage.inputTokens += event.data.usage.inputTokens;
          usage.outputTokens += event.data.usage.outputTokens;
        }
        break;
      }
      case "run.created":
        if (event.data.reason === "retry") {
          for (const reply of replies.values()) {
            if (reply.runId === event.data.continuesRunId && reply.status !== "completed") {
              reply.retried = true;
            }
          }
        }
        run = {
          id: event.data.runId,
          startedBy: event.actor.kind === "user" ? event.actor.name : null,
          reason: event.data.reason,
          createdAt: event.createdAt,
          waitingOn: null,
        };
        break;
      case "run.failed": {
        const { runId, error, kind, connection, detail, resetsAt } = event.data;
        rows.push({
          kind: "failure",
          id: event.id,
          seq: event.seq,
          runId,
          error,
          ...(kind && { failure: kind }),
          ...(connection && { connection }),
          ...(detail && { detail }),
          ...(resetsAt && { resetsAt }),
        });
        if (run?.id === event.data.runId) run = null;
        break;
      }
      case "tool.requested": {
        const { runId, callId, messageId, toolId, input, risk, waits } = event.data;
        const call: ToolRow = {
          kind: "tool",
          id: callId,
          seq: event.seq,
          runId,
          messageId,
          toolId,
          input,
          risk,
          waits,
          requestedAt: event.createdAt,
          state: "pending",
          decision: null,
          output: null,
          ms: null,
        };
        calls.set(callId, call);
        rows.push(call);
        break;
      }
      case "tool.approved":
      case "tool.denied": {
        const call = calls.get(event.data.callId);
        if (!call || (call.state !== "pending" && call.state !== "allowed")) break;
        if (event.type === "tool.approved") {
          call.state = "allowed";
        } else {
          call.state = event.data.reason === "denied" ? "denied" : event.data.reason;
        }
        if (event.actor.kind === "user") {
          call.decision = {
            allow: event.type === "tool.approved",
            scope: event.type === "tool.approved" ? event.data.scope : "once",
            by: event.actor,
            seq: event.seq,
          };
        }
        break;
      }
      case "tool.ran": {
        const call = calls.get(event.data.callId);
        if (!call) break;
        call.state = event.data.ok ? "ran" : "failed";
        call.output = event.data.ok
          ? { ok: true, value: event.data.value ?? null }
          : { ok: false, error: event.data.error ?? "The tool failed." };
        call.ms = event.data.ms;
        break;
      }
      case "thread.renamed":
        if (event.data.usage) {
          usage.inputTokens += event.data.usage.inputTokens;
          usage.outputTokens += event.data.usage.outputTokens;
        }
        break;
      case "run.completed":
        if (run?.id === event.data.runId) run = null;
        break;
      case "run.cancelled":
        rows.push({
          kind: "stop",
          id: event.id,
          seq: event.seq,
          runId: event.data.runId,
          by: event.actor.kind === "user" ? event.actor.name : null,
        });
        if (run?.id === event.data.runId) run = null;
        break;
    }
  }

  if (run) {
    const runId = run.id;
    run.waitingOn =
      [...calls.values()].find(
        (call) => call.runId === runId && call.waits && call.state === "pending",
      )?.id ?? null;
  }
  return { rows, pending: [...pending.values()], run, usage };
}

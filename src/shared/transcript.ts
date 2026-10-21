// A thread's events folded into what people see: the transcript in the order the agent saw it,
// the messages it has not taken in yet, and the run under way. A person's message takes its place
// when the agent takes it in, or where it was posted when it is a quiet aside; an agent reply takes
// the place its run reserved when the reply began.

import {
  type ActorSummary,
  type AnyThreadEvent,
  type Delivery,
  type ReplyStatus,
  type RunReason,
  threadEventSchema,
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
}

export interface AgentRow {
  kind: "agent";
  // The reply's message id.
  id: string;
  seq: number;
  runId: string;
  startedAt: string;
  text: string;
  status: "streaming" | ReplyStatus;
}

// A run that ended without finishing, and why.
export interface FailureRow {
  kind: "failure";
  id: string;
  seq: number;
  error: string;
}

// Someone stopped the run.
export interface StopRow {
  kind: "stop";
  id: string;
  seq: number;
  by: string | null;
}

// An event this client does not know how to show.
export interface UnknownRow {
  kind: "unknown";
  id: string;
  seq: number;
  type: string;
}

export type TranscriptRow = HumanRow | AgentRow | FailureRow | StopRow | UnknownRow;

// A message posted while the agent was busy, waiting to be taken in.
export interface PendingMessage {
  id: string;
  seq: number;
  author: Person;
  postedAt: string;
  text: string;
  mode: Delivery;
}

export interface ActiveRun {
  id: string;
  // Whoever's message woke the agent, or null for a retry.
  startedBy: string | null;
  reason: RunReason | null;
}

export interface Transcript {
  rows: TranscriptRow[];
  pending: PendingMessage[];
  run: ActiveRun | null;
}

function textOf(parts: { text: string }[]) {
  return parts.map((part) => part.text).join("");
}

// `streaming` holds the text so far of replies still being written, by message id.
export function transcriptOf(
  events: readonly AnyThreadEvent[],
  streaming: ReadonlyMap<string, string> = new Map(),
): Transcript {
  const rows: TranscriptRow[] = [];
  const pending = new Map<string, PendingMessage>();
  const replies = new Map<string, AgentRow>();
  let run: ActiveRun | null = null;

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
          startedAt: event.createdAt,
          text: streaming.get(event.data.messageId) ?? "",
          status: "streaming",
        };
        replies.set(reply.id, reply);
        rows.push(reply);
        break;
      }
      case "message.completed": {
        const reply = replies.get(event.data.messageId);
        if (!reply) break;
        reply.text = textOf(event.data.parts);
        reply.status = event.data.status;
        break;
      }
      case "run.created":
        run = {
          id: event.data.runId,
          startedBy: event.actor.kind === "user" ? event.actor.name : null,
          reason: event.data.reason,
        };
        break;
      case "run.failed":
        rows.push({ kind: "failure", id: event.id, seq: event.seq, error: event.data.error });
        if (run?.id === event.data.runId) run = null;
        break;
      case "run.completed":
        if (run?.id === event.data.runId) run = null;
        break;
      case "run.cancelled":
        rows.push({
          kind: "stop",
          id: event.id,
          seq: event.seq,
          by: event.actor.kind === "user" ? event.actor.name : null,
        });
        if (run?.id === event.data.runId) run = null;
        break;
    }
  }

  return { rows, pending: [...pending.values()], run };
}

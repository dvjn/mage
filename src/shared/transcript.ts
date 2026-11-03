// A thread's events folded into what people see: the transcript in the order the agent saw it, the
// messages it has not taken in yet, and the run under way. A person's message takes its place when
// the agent takes it in, or where it was posted when it is a quiet aside; an agent reply takes the
// place its run reserved when the reply began. A reply cut short and then tried again stays in view
// but is left out of what the agent reads. A tool call the agent asked for sits where it asked, and
// carries how it was decided, what was answered to the questions it asked, and what it gave back. A
// compaction sits where it was made, with the summary the agent reads from then on in place of what
// came before. Another agent's message waits in the inbox and takes its place when the agent takes
// it in, as a person's does; subagents that end runs one after another are told in one row where
// the first was. Folded one event at a time, it also keeps for each row the last event that changed
// it and where it sits in the agent's turn.

import type { AskAnswers } from "@/shared/ask.ts";
import { COMPACT } from "@/shared/threads/commands.ts";
import {
  type ActorSummary,
  type AnyThreadEvent,
  type Delivery,
  type FailureKind,
  type SubagentEnd,
  type SubagentTask,
  type ReplyPart,
  type ReplyStatus,
  type RunReason,
  type Sender,
  type Steering,
  threadEventSchema,
  type ToolRisk,
  type ToolScope,
  type Usage,
} from "@/shared/threads/events.ts";

type Person = Extract<ActorSummary, { kind: "user" }>;

// The command a message was sent as: its name, what followed it, and what the agent reads in its
// place, where that differs from the message.
export interface SentCommand {
  name: string;
  args: string;
  text?: string;
}

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
  command?: SentCommand;
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

// Where a tool call stands: waiting for a decision or an answer, approved or answered and about to
// run, denied, ran or failed, denied because its approval no longer held, left when its run ended,
// or its questions skipped.
export type ToolState =
  | "pending"
  | "allowed"
  | "denied"
  | "ran"
  | "failed"
  | "stale"
  | "stopped"
  | "skipped";

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
  // What the tool and its toolset were called when the call was asked for, where recorded.
  title?: string;
  toolset?: string;
  input: unknown;
  risk: ToolRisk;
  // It needed a person's approval when asked for.
  waits: boolean;
  requestedAt: string;
  state: ToolState;
  // Who approved or denied it, how, and where in the thread.
  decision: { allow: boolean; scope: ToolScope; by: Person; seq: number } | null;
  // What the person in `decision` answered, for a call that asks questions.
  answers?: AskAnswers;
  // What it gave back, or why it failed, once it ran, and how long that took.
  output: { ok: true; value: unknown } | { ok: false; error: string } | null;
  ms: number | null;
  // Whose own login it ran with, for a tool that uses one.
  ranAs?: Person;
  // For a call that ran on a standing approval, the call that approval was given on; `decision`
  // is then that approval's.
  standingOn?: string;
}

// The thread compacted for the agent: by whom, null for the agent itself, the summary it reads in
// place of the rows before the one at `firstKeptSeq`, the focus it was asked to keep, and about how
// many tokens it read before and after.
export interface CompactionRow {
  kind: "compaction";
  id: string;
  seq: number;
  by: Person | null;
  summary: string;
  firstKeptSeq: number;
  focus?: string;
  tokensBefore: number;
  tokensAfter: number | null;
}

// A message from another agent, once the agent here took it in: from a subagent, or from the agent
// that started this thread's subagent, the first of them its task. With whom it went to, and the
// people whose words steered it, who count as steering what the agent here does with it.
export interface RelayRow {
  kind: "relay";
  // The message's id.
  id: string;
  seq: number;
  postedAt: string;
  from: Sender;
  to: string;
  text: string;
  steeredBy: Steering[];
  task?: SubagentTask;
}

// A subagent that ended a run, as the thread that started it is told.
export interface SubagentEnded {
  threadId: string;
  name: string;
  state: SubagentEnd;
  last: string;
}

// Subagents that ended runs one after another, told together where the first was told, each
// subagent once with its latest.
export interface NoticeRow {
  kind: "notice";
  id: string;
  seq: number;
  subagents: SubagentEnded[];
}

// The thread's subagents sent each other as many messages as they may.
export interface LimitRow {
  kind: "limit";
  id: string;
  seq: number;
  limit: number;
}

// An event this client does not know how to show.
export interface UnknownRow {
  kind: "unknown";
  id: string;
  seq: number;
  type: string;
}

export type TranscriptRow =
  | HumanRow
  | AgentRow
  | ToolRow
  | FailureRow
  | StopRow
  | CompactionRow
  | RelayRow
  | NoticeRow
  | LimitRow
  | UnknownRow;

// Whether the message asks for the thread to be compacted.
export function asksToCompact(message: { command?: SentCommand }) {
  return message.command?.name === COMPACT;
}

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
  command?: SentCommand;
}

export interface ActiveRun {
  id: string;
  // Whoever's message woke the agent, or null for a retry.
  startedBy: string | null;
  reason: RunReason | null;
  createdAt: string;
  // The tool call it waits on a decision or an answer for, if any.
  waitingOn: string | null;
  // It compacts the thread, as someone asked.
  compacting: boolean;
}

// Another agent's message, waiting to be taken in.
export type RelayMessage = Omit<RelayRow, "kind">;

export interface Transcript {
  rows: TranscriptRow[];
  pending: PendingMessage[];
  // Other agents' messages, waiting to be taken in.
  inbox: RelayMessage[];
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

// Where a row sits in the agent's turn.
export interface AgentTurn {
  // It follows another of the agent's rows, so the turn's first row alone carries the Agent header.
  continued: boolean;
  // The model the turn's reply was written with, when known.
  model: string | null;
}

// Whether an agent row shows: one that only called tools shows as its calls.
function showsAgent(row: AgentRow) {
  return !(row.status === "completed" && !row.text && !row.reasoning);
}

// The agent's rows, its tool calls and replies, follow one another in its turns.
function inTurn(row: TranscriptRow) {
  return row.kind === "tool" || row.kind === "agent";
}

function showsInTurn(row: TranscriptRow) {
  return row.kind === "tool" || (row.kind === "agent" && showsAgent(row));
}

// The turn of each row from `start` to `end`, a run of the agent's rows with none of its rows on
// either side.
function turnsOf(rows: readonly TranscriptRow[], start: number, end: number) {
  const turns: (AgentTurn | null)[] = [];
  let continued = false;
  for (let i = start; i <= end; i++) {
    const shown = showsInTurn(rows[i]!);
    turns.push(shown ? { continued, model: null } : null);
    if (shown) continued = true;
  }
  let model: string | null = null;
  for (let i = end; i >= start; i--) {
    const row = rows[i]!;
    if (row.kind === "agent" && showsAgent(row)) model = row.model;
    const turn = turns[i - start];
    if (turn) turn.model = model;
  }
  return turns;
}

// The first and last index of the run of the agent's rows around `index`.
function turnAround(rows: readonly TranscriptRow[], index: number): [number, number] {
  let start = index;
  while (start > 0 && inTurn(rows[start - 1]!)) start--;
  let end = index;
  while (end < rows.length - 1 && inTurn(rows[end + 1]!)) end++;
  return [start, end];
}

// For a row of the agent's, a tool call or a reply that shows, what turn it belongs to. Null for
// any other row.
export function agentTurnOf(rows: readonly TranscriptRow[], index: number): AgentTurn | null {
  const row = rows[index];
  if (!row || !inTurn(row)) return null;
  const [start, end] = turnAround(rows, index);
  return turnsOf(rows, start, end)[index - start] ?? null;
}

// A thread's transcript folded one event at a time as its log grows. Rows are only ever added at
// the end, so a row's index is its place for good; for each, the fold keeps the seq of the last
// event that changed it or its place in the agent's turn, and that place.
export interface TranscriptFold {
  // The seq of the newest event folded in; 0 before any.
  readonly last: number;
  add(event: AnyThreadEvent): void;
  // The transcript so far. Its rows are the fold's own, which later events change.
  transcript(): Transcript;
  changedAt(index: number): number;
  turnAt(index: number): AgentTurn | null;
}

export function createFold(): TranscriptFold {
  const rows: TranscriptRow[] = [];
  const indexOf = new Map<string, number>();
  // By row index.
  const changed: number[] = [];
  const turns: (AgentTurn | null)[] = [];
  const pending = new Map<string, PendingMessage>();
  const inbox = new Map<string, RelayMessage>();
  const replies = new Map<string, AgentRow>();
  const calls = new Map<string, ToolRow>();
  let run: ActiveRun | null = null;
  let last = 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  // Everyone who wrote or acted in the thread, by id, as events last named them.
  const people = new Map<string, Person>();
  // Approvals of calls older threads paused, kept for when they ran.
  const parked = new Map<string, NonNullable<ToolRow["decision"]>>();
  // The runs that compact the thread: those that took in a message asking for it, and retries.
  const compacting = new Set<string>();
  const personOf = (userId: string): Person =>
    people.get(userId) ?? { kind: "user", userId, name: "(former member)" };

  // Folds the event in, adding the rows it makes with `push` and naming the rows it changes with
  // `touch`.
  function apply(
    raw: AnyThreadEvent,
    push: (row: TranscriptRow) => void,
    touch: (id: string) => void,
  ) {
    const parsed = threadEventSchema.safeParse(raw);
    if (!parsed.success) {
      push({ kind: "unknown", id: raw.id, seq: raw.seq, type: raw.type });
      return;
    }
    const event = parsed.data;
    if (event.actor.kind === "user") people.set(event.actor.userId, event.actor);
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
          ...(event.data.command && { command: event.data.command }),
        };
        if (event.data.quiet) push({ kind: "human", ...message, quiet: true });
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
      case "agent.message": {
        const { parts, from, to, steeredBy, task } = event.data;
        inbox.set(event.id, {
          id: event.id,
          seq: event.seq,
          postedAt: event.createdAt,
          from,
          to,
          text: textOf(parts),
          steeredBy,
          ...(task && { task }),
        });
        break;
      }
      case "subagent.ended": {
        const ended = { ...event.data };
        const last = rows.at(-1);
        if (last?.kind === "notice") {
          last.subagents = [
            ...last.subagents.filter((subagent) => subagent.threadId !== ended.threadId),
            ended,
          ];
          touch(last.id);
        } else {
          push({ kind: "notice", id: event.id, seq: event.seq, subagents: [ended] });
        }
        break;
      }
      case "subagent.limited":
        push({ kind: "limit", id: event.id, seq: event.seq, limit: event.data.limit });
        break;
      case "message.admitted":
        for (const id of event.data.messageIds) {
          const relayed = inbox.get(id);
          if (relayed) {
            inbox.delete(id);
            push({ kind: "relay", ...relayed, seq: event.seq });
            continue;
          }
          const message = pending.get(id);
          if (!message) continue;
          pending.delete(id);
          if (asksToCompact(message)) compacting.add(event.data.runId);
          const { mode: _mode, ...admitted } = message;
          push({ kind: "human", ...admitted, seq: event.seq, quiet: false });
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
          text: "",
          reasoning: "",
          thoughtMs: null,
          status: "streaming",
          usage: null,
          retried: false,
        };
        replies.set(reply.id, reply);
        push(reply);
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
        touch(reply.id);
        break;
      }
      case "run.created":
        if (event.data.reason === "retry" && compacting.has(event.data.continuesRunId ?? "")) {
          compacting.add(event.data.runId);
        }
        if (event.data.reason === "retry") {
          for (const reply of replies.values()) {
            if (reply.runId === event.data.continuesRunId && reply.status !== "completed") {
              reply.retried = true;
              touch(reply.id);
            }
          }
        }
        run = {
          id: event.data.runId,
          startedBy: event.actor.kind === "user" ? event.actor.name : null,
          reason: event.data.reason,
          createdAt: event.createdAt,
          waitingOn: null,
          compacting: false,
        };
        break;
      case "run.failed": {
        const { runId, error, kind, connection, detail, resetsAt } = event.data;
        push({
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
        const { runId, callId, messageId, toolId, input, risk, waits, title, toolset } = event.data;
        const call: ToolRow = {
          kind: "tool",
          id: callId,
          seq: event.seq,
          runId,
          messageId,
          toolId,
          ...(title && { title }),
          ...(toolset && { toolset }),
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
        push(call);
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
        touch(call.id);
        break;
      }
      case "tool.answered": {
        const call = calls.get(event.data.callId);
        if (!call || call.state !== "pending" || event.actor.kind !== "user") break;
        call.state = "allowed";
        call.answers = event.data.answers;
        call.decision = { allow: true, scope: "once", by: event.actor, seq: event.seq };
        touch(call.id);
        break;
      }
      // Older threads paused a call for its person to connect; it shows as waiting for approval,
      // as such a call does now, and any approval it had is set aside until it runs.
      case "tool.blocked": {
        const call = calls.get(event.data.callId);
        if (!call || (call.state !== "pending" && call.state !== "allowed")) break;
        if (call.decision) parked.set(call.id, call.decision);
        call.state = "pending";
        call.waits = true;
        call.decision = null;
        touch(call.id);
        break;
      }
      case "tool.ran": {
        const call = calls.get(event.data.callId);
        if (!call) break;
        if (event.data.ranAs) call.ranAs = personOf(event.data.ranAs);
        const standing = event.data.standingOn ? calls.get(event.data.standingOn) : undefined;
        if (standing?.decision) {
          call.standingOn = standing.id;
          call.decision = { ...standing.decision };
        }
        call.decision ??= parked.get(call.id) ?? null;
        call.state = event.data.ok ? "ran" : "failed";
        call.output = event.data.ok
          ? { ok: true, value: event.data.value ?? null }
          : { ok: false, error: event.data.error ?? "The tool failed." };
        call.ms = event.data.ms;
        touch(call.id);
        break;
      }
      case "thread.compacted": {
        const { summary, firstKeptSeq, focus, tokensBefore, tokensAfter, usage: used } = event.data;
        push({
          kind: "compaction",
          id: event.id,
          seq: event.seq,
          by: event.actor.kind === "user" ? event.actor : null,
          summary,
          firstKeptSeq,
          ...(focus && { focus }),
          tokensBefore,
          tokensAfter: tokensAfter ?? null,
        });
        if (used) {
          usage.inputTokens += used.inputTokens;
          usage.outputTokens += used.outputTokens;
        }
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
        push({
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

  return {
    get last() {
      return last;
    },

    add(raw) {
      last = Math.max(last, raw.seq);
      const touched = new Set<number>();
      apply(
        raw,
        (row) => {
          indexOf.set(row.id, rows.length);
          touched.add(rows.length);
          rows.push(row);
          turns.push(null);
        },
        (id) => {
          const index = indexOf.get(id);
          if (index !== undefined) touched.add(index);
        },
      );
      for (const index of touched) changed[index] = raw.seq;
      // A row's turn follows from the agent's rows around it, so the turns of each run of them a
      // changed row is in are worked out again.
      const done = new Set<number>();
      for (const index of touched) {
        if (done.has(index) || !inTurn(rows[index]!)) continue;
        const [start, end] = turnAround(rows, index);
        turnsOf(rows, start, end).forEach((turn, offset) => {
          const at = start + offset;
          done.add(at);
          const before = turns[at];
          if (before?.continued === turn?.continued && before?.model === turn?.model) return;
          turns[at] = turn;
          changed[at] = raw.seq;
        });
      }
    },

    transcript() {
      if (run) {
        const runId = run.id;
        run.compacting = compacting.has(runId);
        run.waitingOn =
          [...calls.values()].find(
            (call) => call.runId === runId && call.waits && call.state === "pending",
          )?.id ?? null;
      }
      return { rows, pending: [...pending.values()], inbox: [...inbox.values()], run, usage };
    },

    changedAt(index) {
      return changed[index] ?? 0;
    },

    turnAt(index) {
      return turns[index] ?? null;
    },
  };
}

export function transcriptOf(events: readonly AnyThreadEvent[]): Transcript {
  const fold = createFold();
  for (const event of events) fold.add(event);
  return fold.transcript();
}

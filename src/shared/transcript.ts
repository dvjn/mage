// A thread's events folded into what people see: the transcript in the order the agent saw it, the
// messages it has not taken in yet, and the run under way. A person's message takes its place when
// the agent takes it in, or where it was posted when it is a quiet aside; an agent reply takes the
// place its run reserved when the reply began. A reply cut short and then tried again stays in view
// but is left out of what the agent reads. A tool call the agent asked for sits where it asked, and
// carries how it was decided, what was answered to the questions it asked, and what it gave back. A
// compaction sits where it was made, with the summary the agent reads from then on in place of what
// came before. Another agent's message waits in the inbox and takes its place when the agent takes
// it in, as a person's does, and so does any other notice; subagents that ended runs one
// after another, as older threads were told, show in one row where the first was. The events
// folded are one branch's: where the branch starts nothing runs or waits from before but what it
// keeps, and one restored from a row ends there, with a line saying so. A thread forked from
// another's conversation says so where the copy ends. Folded one event at a time, it also keeps
// for each row the last event that changed it, that event leaving aside where the row sits in the
// agent's turn, and that place.

import type { AskAnswers } from "@/shared/ask.ts";
import { addUsage } from "@/shared/usage.ts";
import { COMPACT } from "@/shared/threads/commands.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import {
  type ActorSummary,
  type AnyThreadEvent,
  type Cause,
  type Delivery,
  type FailureKind,
  type NoticeActor,
  type NoticeKind,
  type NoticeParts,
  type SubagentTask,
  type ReplyPart,
  type ReplyStatus,
  type RunReason,
  type Sender,
  type Influencer,
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
  // The model ref it was written with, and the effort it was asked for, when known.
  model: string | null;
  effort?: Effort;
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

// Where a tool call stands: waiting for a decision or an answer, ready to run (approved, answered
// or needing neither), denied, completed or failed, denied because its approval no longer held,
// cancelled when its run ended, or its questions skipped.
export type ToolState =
  | "waiting"
  | "ready"
  | "denied"
  | "completed"
  | "failed"
  | "stale"
  | "cancelled"
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
  // The input as the call runs, and what the model asked for where that differs.
  input: unknown;
  asked?: unknown;
  risk: ToolRisk;
  // It needed a person's approval when asked for.
  waits: boolean;
  requestedAt: string;
  state: ToolState;
  // Who approved or denied it, how, and where in the thread.
  decision: { allow: boolean; scope: ToolScope; by: Person; seq: number } | null;
  // What the person in `decision` answered, for a call that asks questions.
  answers?: AskAnswers;
  // What it gave back, or why it failed, once it ran, and how long that took. A large result is
  // kept apart from the log: its value is null here, and `large` says where it is read from, the
  // id of the event that ended the call, and its size in characters of JSON.
  output:
    | { ok: true; value: unknown; large?: { id: string; size: number } }
    | { ok: false; error: string }
    | null;
  ms: number | null;
  // A job: a call that runs in the background, which `runId`'s run neither waits for nor stops;
  // one started there belongs to no reply, one moved there stays in the reply that asked for it.
  background?: true;
  // Where a call its run asked for went on in the background, keeping its id: the event that moved
  // it and when.
  moved?: { seq: number; at: string };
  // The call that made it, as a script or a job's start; it belongs to no reply.
  within?: string;
  // Whose own login it ran with, for a tool that uses one.
  ranAs?: Person;
  // For a call that ran on a standing approval, the call that approval was given on; `decision`
  // is then that approval's.
  standingOn?: string;
}

// Where a thread forked from another's conversation ends its copy: the thread and row it came
// from, as that thread was titled, and by whom; or the summary of that conversation it starts from.
export interface ForkRow {
  kind: "fork";
  id: string;
  seq: number;
  by: Person | null;
  postedAt: string;
  from: { threadId: string; rowId?: string; title: string };
  summary?: true;
}

// Where a branch restored from the row before goes on: by whom and when. Nothing the agent reads.
export interface RestoreRow {
  kind: "restore";
  id: string;
  seq: number;
  by: Person | null;
  postedAt: string;
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

// A notice, once the agent here took it in: what it tells, the agent whose thread it came
// from, and the people whose words it carries, who count as steering what the agent here does with
// it; with the call or the row there it came of, where known. A message from another agent, the
// first of them in a subagent's thread its task, also says whom it went to.
export interface NoticeRow extends NoticeParts {
  kind: "notice";
  // The notice's id.
  id: string;
  seq: number;
  postedAt: string;
  type: NoticeKind;
  from: Sender;
  actor?: NoticeActor;
  to?: string;
  text: string;
  influence: Influencer[];
  task?: SubagentTask;
  call?: Cause;
  callIds?: string[];
  rowId?: string;
  // A notice that did not start the agent: shown when it was made, and read by the agent
  // from `taken` on, the event that took it in, once it has.
  silent?: true;
  taken?: number;
}

// The thread's subagents sent each other as many messages as they may, with the call first
// refused, where known.
export interface LimitRow {
  kind: "limit";
  id: string;
  seq: number;
  limit: number;
  call?: Cause;
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
  | NoticeRow
  | LimitRow
  | ForkRow
  | RestoreRow
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
export type NoticeMessage = Omit<NoticeRow, "kind">;

// The notices that start the agent: those not made silent.
export function waking(notices: readonly NoticeMessage[]) {
  return notices.filter((message) => !message.silent);
}

// The tools and instructions the agent reads from, by their hash: the space and the seq they
// were taken at, and when.
export interface ViewRef {
  hash: string;
  space: string;
  seq: number;
  at: string;
}

export interface Transcript {
  rows: TranscriptRow[];
  run: ActiveRun | null;
  // The tokens every model call in the thread used.
  usage: Usage;
  // Null until the agent first read the thread.
  view: ViewRef | null;
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
  // The people's messages and the notices waiting to be taken in.
  waiting(): { messages: PendingMessage[]; notices: NoticeMessage[] };
  changedAt(index: number): number;
  // The seq of the last event that changed the row itself, leaving its turn aside.
  touchedAt(index: number): number;
  turnAt(index: number): AgentTurn | null;
  // The index of the row with the id; -1 when there is none.
  indexOf(id: string): number;
  // A fold of its own that starts where this one is, for events this one is not to take in.
  fork(): TranscriptFold;
}

// All a fold holds, which a fork starts from a copy of.
interface FoldState {
  rows: TranscriptRow[];
  indexOf: Map<string, number>;
  // By row index.
  changed: number[];
  touchedAt: number[];
  turns: (AgentTurn | null)[];
  waitingMessages: Map<string, PendingMessage>;
  waitingNotices: Map<string, NoticeMessage>;
  // The silent notices already shown, by id, until the agent takes them in.
  silentRows: Map<string, NoticeRow>;
  replies: Map<string, AgentRow>;
  calls: Map<string, ToolRow>;
  run: ActiveRun | null;
  last: number;
  view: ViewRef | null;
  usage: Usage;
  // Everyone who wrote or acted in the thread, by id, as events last named them.
  people: Map<string, Person>;
  // The runs that compact the thread: those that took in a message asking for it, and retries.
  compacting: Set<string>;
}

export function createFold(from?: FoldState): TranscriptFold {
  const state: FoldState = from ?? {
    rows: [],
    indexOf: new Map(),
    changed: [],
    touchedAt: [],
    turns: [],
    waitingMessages: new Map(),
    waitingNotices: new Map(),
    silentRows: new Map(),
    replies: new Map(),
    calls: new Map(),
    run: null,
    last: 0,
    view: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    people: new Map(),
    compacting: new Set(),
  };
  const { rows, indexOf, changed, touchedAt, turns, waitingMessages, waitingNotices, silentRows } =
    state;
  const { replies, calls, usage, people, compacting } = state;
  let { run, last, view } = state;
  const personOf = (userId: string): Person =>
    people.get(userId) ?? { kind: "user", userId, name: null, former: true };

  // Where a branch or a fork starts afresh: nothing runs, a reply being written ends there, the
  // open calls will not run, and of the messages waiting only those kept still wait.
  function settle(touch: (id: string) => void, keep: readonly string[] = []) {
    run = null;
    for (const reply of replies.values()) {
      if (reply.status !== "streaming") continue;
      reply.status = "interrupted";
      touch(reply.id);
    }
    for (const id of waitingMessages.keys()) if (!keep.includes(id)) waitingMessages.delete(id);
    for (const call of calls.values()) {
      if (call.state !== "waiting" && call.state !== "ready") continue;
      call.state = "cancelled";
      touch(call.id);
    }
  }

  // Leaves out every row after the one with the id.
  function endAt(id: string) {
    const index = indexOf.get(id);
    if (index === undefined) return;
    for (const row of rows.splice(index + 1)) indexOf.delete(row.id);
    changed.length = Math.min(changed.length, rows.length);
    touchedAt.length = Math.min(touchedAt.length, rows.length);
    turns.length = rows.length;
  }

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
        else waitingMessages.set(event.id, { ...message, mode: event.data.mode });
        break;
      }
      case "message.changed": {
        const message = waitingMessages.get(event.data.messageId);
        if (!message) break;
        if (event.data.parts) message.text = textOf(event.data.parts);
        if (event.data.mode) message.mode = event.data.mode;
        break;
      }
      case "message.withdrawn":
      case "message.dropped":
        waitingMessages.delete(event.data.messageId);
        break;
      case "notice": {
        const { kind, source, influence, to, task, actor } = event.data;
        const { text, subagents, when, error, last, delivery, schedule, tray, change, memory } =
          event.data;
        const { callId, callIds, rowId, ...from } = source;
        const silent = event.data.wake === false;
        const message: NoticeMessage = {
          id: event.id,
          seq: event.seq,
          postedAt: event.createdAt,
          type: kind,
          from,
          ...(actor && { actor }),
          ...(to !== undefined && { to }),
          text,
          influence,
          ...(task && { task }),
          ...(subagents && { subagents }),
          ...(when && { when }),
          ...(error !== undefined && { error }),
          ...(last && { last }),
          ...(delivery && { delivery }),
          ...(schedule && { schedule }),
          ...(tray && { tray }),
          ...(change && { change }),
          ...(memory && { memory }),
          ...(callId && { call: { threadId: source.threadId, callId } }),
          ...(callIds && { callIds }),
          ...(rowId && { rowId }),
          ...(silent && { silent: true as const }),
        };
        waitingNotices.set(event.id, message);
        if (silent) {
          const shown: NoticeRow = { kind: "notice", ...message };
          silentRows.set(event.id, shown);
          push(shown);
        }
        break;
      }
      case "subagent.limited":
        push({
          kind: "limit",
          id: event.id,
          seq: event.seq,
          limit: event.data.limit,
          ...(event.data.call && { call: event.data.call }),
        });
        break;
      case "message.admitted":
        for (const id of event.data.messageIds) {
          const told = waitingNotices.get(id);
          if (told) {
            waitingNotices.delete(id);
            // A silent one was shown when it was made; now it is read.
            const shown = silentRows.get(id);
            if (shown && indexOf.has(id)) {
              silentRows.delete(id);
              shown.taken = event.seq;
              touch(id);
              continue;
            }
            push({ kind: "notice", ...told, seq: event.seq });
            continue;
          }
          const message = waitingMessages.get(id);
          if (!message) continue;
          waitingMessages.delete(id);
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
          ...(event.data.effort && { effort: event.data.effort }),
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
          addUsage(usage, event.data.usage);
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
        const { background, within, resolved } = event.data;
        const call: ToolRow = {
          kind: "tool",
          id: callId,
          seq: event.seq,
          runId,
          messageId,
          toolId,
          ...(title && { title }),
          ...(toolset && { toolset }),
          ...(background && { background }),
          ...(within && { within }),
          input: resolved ?? input,
          ...(resolved !== undefined && { asked: input }),
          risk,
          waits,
          requestedAt: event.createdAt,
          state: waits ? "waiting" : "ready",
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
        if (!call || (call.state !== "waiting" && call.state !== "ready")) break;
        if (event.type === "tool.approved") {
          call.state = "ready";
        } else {
          call.state = event.data.reason === "denied" ? "denied" : event.data.reason;
        }
        // A person's approval, denial or skip is a decision; their cancel of a job is not.
        const decides = event.type === "tool.approved" || event.data.reason !== "cancelled";
        if (event.actor.kind === "user" && decides) {
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
        if (!call || call.state !== "waiting" || event.actor.kind !== "user") break;
        call.state = "ready";
        call.answers = event.data.answers;
        call.decision = { allow: true, scope: "once", by: event.actor, seq: event.seq };
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
        call.state = event.data.ok ? "completed" : "failed";
        call.output = event.data.ok
          ? {
              ok: true,
              value: event.data.value ?? null,
              ...(event.data.large && { large: { id: event.id, size: event.data.large.size } }),
            }
          : { ok: false, error: event.data.error ?? "The tool failed." };
        call.ms = event.data.ms;
        touch(call.id);
        break;
      }
      case "tool.moved": {
        const call = calls.get(event.data.callId);
        if (!call || call.background) break;
        call.background = true;
        call.moved = { seq: event.seq, at: event.createdAt };
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
          addUsage(usage, used);
        }
        break;
      }
      case "agent.viewed":
        view = {
          hash: event.data.view,
          space: event.data.space,
          seq: event.data.from,
          at: event.createdAt,
        };
        break;
      case "thread.renamed":
        if (event.data.usage) {
          addUsage(usage, event.data.usage);
        }
        break;
      case "run.completed":
        if (run?.id === event.data.runId) run = null;
        break;
      case "branch.started":
        if (event.data.kind === "restore") endAt(event.data.rowId);
        settle(touch, event.data.keep);
        if (event.data.kind === "restore") {
          push({
            kind: "restore",
            id: event.id,
            seq: event.seq,
            by: event.actor.kind === "user" ? event.actor : null,
            postedAt: event.createdAt,
          });
        }
        break;
      case "thread.forked": {
        settle(touch);
        const { threadId, rowId, title, summary } = event.data;
        push({
          kind: "fork",
          id: event.id,
          seq: event.seq,
          by: event.actor.kind === "user" ? event.actor : null,
          postedAt: event.createdAt,
          from: { threadId, ...(rowId && { rowId }), title },
          ...(summary && { summary: true as const }),
        });
        break;
      }
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
      // A branch that ends at a row leaves out those after it.
      for (const index of touched) if (index >= rows.length) touched.delete(index);
      for (const index of touched) {
        changed[index] = raw.seq;
        touchedAt[index] = raw.seq;
      }
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
            (call) => call.runId === runId && !call.background && call.state === "waiting",
          )?.id ?? null;
      }
      return { rows, run, usage, view };
    },

    waiting() {
      return { messages: [...waitingMessages.values()], notices: [...waitingNotices.values()] };
    },

    changedAt(index) {
      return changed[index] ?? 0;
    },

    touchedAt(index) {
      return touchedAt[index] ?? 0;
    },

    turnAt(index) {
      return turns[index] ?? null;
    },

    indexOf(id) {
      return indexOf.get(id) ?? -1;
    },

    fork() {
      // One copy of everything, so rows the maps hold stay the rows the list holds.
      return createFold(structuredClone({ ...state, run, last, view }));
    },
  };
}

// The people's messages and the notices that wait to be taken in after the events, each as it
// stands after them: what the queue's waiting inputs say, read from their events and the changes
// made to them.
export function waitingIn(events: readonly AnyThreadEvent[]) {
  const fold = createFold();
  for (const event of events) fold.add(event);
  return fold.waiting();
}

export function transcriptOf(events: readonly AnyThreadEvent[]): Transcript {
  const fold = createFold();
  for (const event of events) fold.add(event);
  return fold.transcript();
}

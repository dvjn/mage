// The agent worker: an in-process loop, woken by the event bus and by a slow poll, that claims
// queued runs and drives each one. A run takes in every message waiting for it before its first
// model call, then streams the model's reply, one reserved slot per model step, storing every piece
// as it comes; at each step boundary it takes in the messages sent to steer it, and a steer that
// arrives during its last step earns it one more step. Queued messages wait for the run after it.
// A stop request aborts the stream and ends the run with its partial reply kept. Every write a run
// makes checks its lease in the same transaction, and a renewal keeps the lease while the run
// works. Runs left running by a stopped server are failed with their partial reply rebuilt from its
// stored pieces, and tried again until the same input has failed too many times. A run that fails
// says why in a way people can act on: the provider's failure kind, what it said and, for a limit,
// when it resets. A step that calls tools ends the model call; each call is recorded and decided
// before any result goes back: it runs at once, or the run waits for a person's decision, or for an
// answer to a call that asks questions, letting its lease go and keeping nothing in memory. A
// decision or an answer queues the run again, and the worker that claims it reads the thread's log
// to see where its calls stand, checks each approval and answer still holds, runs what it may and
// goes on; a restart takes the same path. MCP tools stay out of the model's requests until it
// searches for them, and those it turns on stay on in the thread. A message asking to compact the
// thread waits for the run before it to end, and gets a run of its own that writes the summary and
// replies with nothing; other runs leave it waiting. Notifications wait like a steer: each
// boundary takes all of them in together, and those left when a run ends start the next. What a
// thread offers and tells the agent, and what it reads ahead of the thread, can depend on the
// thread, as a subagent's do; and whoever needs to hears of each run that ends. Each run is traced
// as a root span of its own, linked to whatever woke its thread, with a span for each tool call.

import {
  context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { wireToolName } from "@/shared/tools.ts";
import { addUsage } from "@/shared/usage.ts";
import { ulid } from "ulid";
import * as z from "zod";

import type { AfterCommit, Sync, Transact } from "@/server/sync/sync.ts";
import type { Lease as RowLease } from "@/server/sync/lease.ts";
import type { Signals } from "@/server/sync/signals.ts";
import { connectionOf, failureSentence } from "@/server/agent/failure-text.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { contentRecorded, type RunTraces, tracer } from "@/server/kernel/tracing.ts";
import { ConnectionError } from "@/server/models/connections.ts";
import {
  type Effort,
  ModelError,
  type ModelMessage,
  type ModelToolCall,
  type ModelUsage,
} from "@/server/models/gateway.ts";
import type { Models, OpenModel } from "@/server/models/service.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import type { ThreadAccess } from "@/server/access/access.ts";
import type { Append, ThreadLog } from "@/server/threads/log.ts";
import type { DeltaStore, Thread, ThreadStore } from "@/server/threads/service.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import type { EventDataMap, ReplyPart, ReplyStatus, RunReason } from "@/shared/threads/events.ts";
import {
  asksToCompact,
  type PendingMessage,
  type ToolRow,
  type TranscriptRow,
  waking,
} from "@/shared/transcript.ts";

import type { Adoption } from "./calls.ts";
import type { Live } from "./live.ts";
import { compact, type ThreadRequest, wholeWhereRead } from "./compaction.ts";
import {
  contextOf,
  type Guidance,
  type ToolOn,
  humanMessage,
  NO_GUIDANCE,
  notificationsMessage,
} from "./context.ts";
import { deferredByServer, TOOL_SEARCH } from "./tool-search.ts";
import type { ToolOutput, AnyToolSpec, SpaceTools, Tools } from "./tools.ts";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type EndStatus = Extract<RunStatus, "completed" | "failed" | "cancelled">;

export interface Run {
  id: string;
  threadId: string;
  // The branch it writes in.
  branchId: string;
  status: RunStatus;
  // The seq of the message that woke the agent.
  triggerSeq: number;
  // The model ref it replied with, once it started.
  model: string | null;
  // The model and effort it was asked to reply with in place of the thread's, if any.
  askedModel: string | null;
  askedEffort: Effort | null;
  // The run this one follows, and why.
  continuesRunId: string | null;
  reason: RunReason | null;
  // Who woke the agent; null for a retry or once that user is gone.
  createdBy: string | null;
  // How many times this input has been tried, counting this run.
  attempt: number;
  cancelRequestedAt: Date | null;
  cancelRequestedBy: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  leaseEpoch: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface NewRun {
  threadId: string;
  // The thread's current branch when not given.
  branchId?: string;
  askedModel?: string | null;
  askedEffort?: Effort | null;
  triggerSeq: number;
  createdBy: string | null;
  continuesRunId?: string | null;
  reason?: RunReason | null;
  attempt?: number;
}

// The right to write for a run, held by one worker until it ends or expires.
export interface Lease extends RowLease {
  runId: string;
}

// Thrown by a write whose lease no longer holds.
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`lease on run ${runId} lost`);
  }
}

export interface RunStore {
  create(run: NewRun): Promise<Run>;
  find(id: string): Promise<Run | null>;
  // The newest run of the thread's current branch.
  latest(threadId: string): Promise<Run | null>;
  // The queued, running or waiting run of the thread's current branch.
  active(threadId: string): Promise<Run | null>;
  // The branch's queued, running or waiting run.
  activeOn(branchId: string): Promise<Run | null>;
  // The threads with a queued, running or waiting run.
  activeThreadIds(): Promise<string[]>;
  // The queued, running and waiting runs of the space's threads, or of the threads named.
  activeInSpace(spaceId: string): Promise<Run[]>;
  activeIn(threadIds: string[]): Promise<Run[]>;
  // Asks the thread's active run to stop, unless someone already has; null when there is none. A
  // null user is the server itself, as when the agent may no longer run in the thread's space.
  requestCancel(threadId: string, userId: string | null, at: Date): Promise<Run | null>;
  // Asks the branch's active run to stop, as `requestCancel` does the current branch's.
  requestCancelOn(branchId: string, userId: string | null, at: Date): Promise<Run | null>;
  // Takes the oldest queued run for the owner, for `leaseMs`.
  claim(owner: string, leaseMs: number): Promise<Run | null>;
  // Takes a running run whose lease ran out, for `leaseMs`.
  takeOver(id: string, owner: string, leaseMs: number): Promise<Run | null>;
  // Running runs whose lease ran out.
  stale(): Promise<Run[]>;
  // Ends the lease now, so that whoever looks next takes the run over.
  expire(lease: Lease): Promise<void>;
  // The run as it is now; throws LeaseLost unless the lease holds.
  hold(lease: Lease): Promise<Run>;
  // Extends the lease; throws LeaseLost unless it holds.
  renew(lease: Lease, leaseMs: number): Promise<Run>;
  // Records the model the run replies with.
  setModel(lease: Lease, model: string): Promise<void>;
  // Adds the tools, turned on by the call, to those the run's thread offers from now on.
  turnOn(lease: Lease, callId: string, toolIds: readonly string[]): Promise<void>;
  // The tools turned on in the thread, in the order they were.
  toolsOn(threadId: string): Promise<ToolOn[]>;
  // Lets the lease go while the run waits for a person's decision; nothing holds it meanwhile.
  wait(lease: Lease): Promise<Run>;
  // Queues a waiting run again, to be claimed like any other; false when it was not waiting.
  resume(runId: string): Promise<boolean>;
  // Ends the run and lets its lease go. Why a run failed is told by its run.failed event.
  end(
    lease: Lease,
    outcome: { status: EndStatus; usage?: { inputTokens: number; outputTokens: number } },
  ): Promise<Run>;
}

export interface RunWorkerOptions {
  runs: RunStore;
  threads: Pick<ThreadStore, "find" | "eventAt">;
  // Held while a run executes, so its thread is folded once.
  transcripts: Pick<Transcripts, "of" | "hold" | "whole">;
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can">;
  deltas: DeltaStore;
  log: ThreadLog;
  bus: Signals;
  transact: Transact;
  afterCommit: AfterCommit;
  // Names this server instance in the leases it takes on runs.
  instanceId: string;
  // The worker's periodic pass and the keeper of its leases.
  sync: Pick<Sync, "ticker" | "keeper">;
  models: Pick<Models, "open" | "replyModel">;
  tools: Pick<
    Tools,
    | "toolsIn"
    | "offered"
    | "riskOf"
    | "forModel"
    | "evaluate"
    | "approvalHolds"
    | "answerHolds"
    | "modelNames"
    | "fromServers"
    | "namesNow"
    | "run"
  >;
  // What the org and the space tell the agent beyond Mage's own prompt, given the tools offered,
  // and what the thread does about it.
  guidance?: (
    space: Space,
    offered: readonly AnyToolSpec[],
    thread: Thread,
    now: SpaceTools,
  ) => Promise<Guidance>;
  // The tools the thread's agent may call of those its space offers; all of them when not given.
  narrow?: (thread: Thread, offered: AnyToolSpec[]) => Promise<AnyToolSpec[]>;
  // What the thread's agent reads ahead of the thread itself; nothing when not given.
  before?: (thread: Thread) => Promise<ModelMessage[]>;
  // Hears of each run that ended, after its end is stored.
  ended?: (run: Run) => Promise<void>;
  // Takes over a call moved to the background, which runs on beside the run.
  adopt?: (call: Adoption) => Promise<string>;
  // Where running calls say what they print, for the people watching; nowhere when not given.
  live?: Pick<Live, "open" | "close" | "end">;
  logger: Logger;
  // What ties each run's span to the work that woke its thread; runs are not traced without it.
  traces?: RunTraces;
  // Whether the agent may run in the space; a run claimed where it may not is stopped unstarted.
  runsIn?: (space: Space) => Promise<boolean>;
  // Where the worker hears that people may have lost a role in an org's spaces, or that spaces
  // were archived or put in trash.
  hooks?: Hooks;
  now?: () => Date;
  // How long reply pieces gather before they are stored and announced together.
  flushMs?: number;
  // How long a claim holds without renewal.
  leaseMs?: number;
  // How often the worker looks for work nobody woke it for.
  pollMs?: number;
  // The most model steps one run takes.
  maxSteps?: number;
  // How many times one input is tried before it is given up on.
  maxAttempts?: number;
}

export type RunWorker = ReturnType<typeof createRunWorker>;

type Failure = Omit<EventDataMap["run.failed"], "runId">;

// A failure whose message people see, and its kind when it has one.
export class RunFailure extends Error {
  readonly failure: Failure;

  constructor(failure: Failure | string) {
    const value = typeof failure === "string" ? { error: failure } : failure;
    super(value.error);
    this.failure = value;
  }
}

// What a failure says to people: its kind and what the provider or system said while replying with the model `ref`.
function failureOf(err: unknown, ref: string | null): RunFailure {
  if (err instanceof RunFailure) return err;
  const connection = ref ? connectionOf(ref) : undefined;
  const kinded =
    err instanceof ModelError
      ? err
      : err instanceof ConnectionError
        ? new ModelError("auth", err.message)
        : null;
  if (!kinded) return new RunFailure({ error: messageOf(err), kind: "model_error" });
  return new RunFailure({
    error: kinded.summary ?? "",
    kind: kinded.kind,
    ...(connection && { connection }),
    detail: kinded.detail,
    ...(kinded.resetsAt && { resetsAt: kinded.resetsAt.toISOString() }),
  });
}

// Why a run was aborted from outside its stream.
type Abort = { kind: "lease" } | { kind: "shutdown" } | { kind: "cancel" };

// Thrown once the run waits for a decision on a tool call, or an answer, its lease let go.
class Waiting extends Error {}

// The message with its tool calls and results named as the model knows the tools.
function namedFor(message: ModelMessage, toModel: (id: string) => string): ModelMessage {
  switch (message.role) {
    case "assistant":
      return message.toolCalls
        ? {
            ...message,
            toolCalls: message.toolCalls.map((call) => ({ ...call, toolId: toModel(call.toolId) })),
          }
        : message;
    case "tool":
      return {
        ...message,
        results: message.results.map((result) => ({ ...result, toolId: toModel(result.toolId) })),
      };
    case "change":
      return message.tools ? { ...message, tools: message.tools.map(toModel) } : message;
    default:
      return message;
  }
}

// The model a run replies with, and the thread's own model and effort it was chosen from.
interface Replying {
  model: OpenModel;
  effort: Thread["effort"];
  own: Pick<Thread, "model" | "effort">;
}

// Whether a tool call has not been settled yet.
function open(row: ToolRow) {
  return row.state === "pending" || row.state === "allowed";
}

interface Execution {
  run: Run;
  lease: Lease;
  // The model ref the run replies with, once chosen, and the effort it is asked for.
  ref: string | null;
  effort: Thread["effort"];
  controller: AbortController;
  done: Promise<void>;
  span: Span;
  // The call running now, and what moves it to the background.
  running?: { callId: string; spec: AnyToolSpec; move(): void };
}

// What a call that was moved to the background gives back to the run in place of its result.
const MOVED = Symbol("moved");

const AGENT = { kind: "agent" } as const;

type Part = "text" | "reasoning";

// A reply's stored parts: its reasoning, when it has any, then its answer.
function replyParts(text: string, reasoning: string, durationMs?: number): ReplyPart[] {
  return [
    ...(reasoning
      ? [
          {
            type: "reasoning" as const,
            text: reasoning,
            ...(durationMs !== undefined && { durationMs }),
          },
        ]
      : []),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

// The thread's waiting messages whose authors may still post in it, and those whose authors no
// longer may.
export async function sortWaiting(
  threads: Pick<ThreadStore, "find">,
  spaceStore: Pick<SpaceStore, "find">,
  access: Pick<ThreadAccess, "can">,
  threadId: string,
  pending: PendingMessage[],
) {
  const thread = await threads.find(threadId);
  const space = thread && (await spaceStore.find(thread.spaceId));
  const admitted: PendingMessage[] = [];
  const refused: PendingMessage[] = [];
  for (const message of pending) {
    const allowed =
      !!space &&
      (await access.can({ userId: message.author.userId, orgId: space.orgId }, thread, "post"));
    (allowed ? admitted : refused).push(message);
  }
  return { admitted, refused };
}

// Drops the waiting messages of the org's threads whose authors can no longer post in them.
async function dropRefusedWaiting(options: {
  threads: Pick<ThreadStore, "find">;
  transcripts: Pick<Transcripts, "of">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "activeThreadIds">;
  access: Pick<ThreadAccess, "can">;
  log: ThreadLog;
  orgId: string;
}) {
  const { threads, transcripts, spaceStore, runs, access, log, orgId } = options;
  for (const threadId of new Set(await runs.activeThreadIds())) {
    const thread = await threads.find(threadId);
    if (!thread || (await spaceStore.find(thread.spaceId))?.orgId !== orgId) continue;
    await log.write(threadId, async (append) => {
      const pending = (await transcripts.of(threadId)).transcript().pending;
      const { refused } = await sortWaiting(threads, spaceStore, access, threadId, pending);
      for (const message of refused) {
        await append({ type: "message.dropped", actor: AGENT, data: { messageId: message.id } });
      }
    });
  }
}

// Asks the active runs of the org's threads in spaces where the agent may no longer run to stop,
// queueing again those that wait for a decision so that a worker ends them.
async function stopBarredRuns(options: {
  threads: Pick<ThreadStore, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "activeThreadIds" | "requestCancel" | "resume">;
  bus: Pick<Signals, "wake">;
  runsIn: (space: Space) => Promise<boolean>;
  orgId: string;
  now?: () => Date;
}) {
  const { threads, spaceStore, runs, bus, runsIn, orgId } = options;
  for (const threadId of new Set(await runs.activeThreadIds())) {
    const thread = await threads.find(threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!space || space.orgId !== orgId || (await runsIn(space))) continue;
    const run = await runs.requestCancel(threadId, null, options.now?.() ?? new Date());
    if (run?.status === "waiting") await runs.resume(run.id);
    bus.wake(threadId);
  }
}

// Starts a run in a transaction that is appending to the thread, taking in the given messages.
export async function startRun(
  runs: Pick<RunStore, "create">,
  append: Append,
  input: NewRun,
  admit: string[] = [],
) {
  const run = await runs.create(input);
  await append({
    type: "run.created",
    actor: input.createdBy ? { kind: "user", userId: input.createdBy } : AGENT,
    data: {
      runId: run.id,
      reason: input.reason ?? null,
      continuesRunId: input.continuesRunId ?? null,
    },
  });
  if (admit.length > 0) {
    await append({
      type: "message.admitted",
      actor: AGENT,
      data: { runId: run.id, messageIds: admit },
    });
  }
  return run;
}

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : "The model did not answer.";
}

export function createRunWorker(options: RunWorkerOptions) {
  const { runs, threads, transcripts, spaceStore, access, deltas, log, bus, transact } = options;
  const { models, tools, logger } = options;
  const now = options.now ?? (() => new Date());
  const guidance = options.guidance ?? (() => NO_GUIDANCE);
  const runsIn = options.runsIn ?? (async () => Promise.resolve(true));
  const narrow = options.narrow ?? ((_thread: Thread, offered: AnyToolSpec[]) => offered);
  const before = options.before ?? (() => []);
  const ended = options.ended ?? (() => {});
  // When people may have lost a role in an org's spaces, their waiting messages there are dropped,
  // and the agent stops in spaces archived or put in trash.
  async function accessChanged(orgId: string) {
    await dropRefusedWaiting({
      threads,
      transcripts,
      spaceStore,
      runs,
      access,
      log,
      orgId,
    });
    await stopBarredRuns({ threads, spaceStore, runs, bus, runsIn, orgId, now });
  }
  options.hooks?.on("org.personalSpacesChanged", async ({ orgId, allowed }) => {
    if (!allowed) await accessChanged(orgId);
  });
  options.hooks?.on("org.membersSettled", async ({ orgId }) => accessChanged(orgId));
  options.hooks?.on("space.accessChanged", async ({ orgId }) => accessChanged(orgId));
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 5_000;
  const flushMs = options.flushMs ?? 75;
  const maxSteps = options.maxSteps ?? 20;
  const maxAttempts = options.maxAttempts ?? 3;
  const owner = options.instanceId;
  const executions = new Map<string, Execution>();
  let stopped = true;
  let unsubscribe: (() => void)[] = [];

  // The transcript of the run's branch.
  async function transcript(run: Pick<Run, "threadId" | "branchId">) {
    return (await transcripts.of(run.threadId, run.branchId)).transcript();
  }

  // The rows as the model reads them, with what its calls gave back, large or not.
  async function whole(rows: readonly TranscriptRow[]) {
    return wholeWhereRead(rows, transcripts.whole);
  }

  // Whether the run's branch still takes runs: only the thread's current one does.
  async function live(run: Pick<Run, "threadId" | "branchId">) {
    return (await threads.find(run.threadId))?.currentBranchId === run.branchId;
  }

  // Appends the run's events to its branch only while its lease holds.
  async function write<T>(
    lease: Lease,
    run: Pick<Run, "threadId" | "branchId">,
    work: (append: Append) => T,
  ) {
    return (
      await log.write(
        run.threadId,
        async (append) => {
          await runs.hold(lease);
          return work(append);
        },
        run.branchId,
      )
    ).result;
  }

  // Whether the run's lease still holds.
  async function holds(lease: Lease) {
    try {
      await runs.hold(lease);
      return true;
    } catch (err) {
      if (err instanceof LeaseLost) return false;
      throw err;
    }
  }

  // Pending messages whose authors may still post in the thread, as members of its space or as
  // its guests; the others are dropped.
  async function admissible(threadId: string, pending: PendingMessage[], append: Append) {
    const { admitted, refused } = await sortWaiting(threads, spaceStore, access, threadId, pending);
    for (const message of refused) {
      await append({ type: "message.dropped", actor: AGENT, data: { messageId: message.id } });
    }
    return admitted;
  }

  // Ends the run, then starts the next one: the same input again when it is to be retried, or the
  // messages that waited for it to end.
  async function end(
    lease: Lease,
    run: Run,
    append: Append,
    outcome: { status: EndStatus; failure?: Failure; usage?: ModelUsage },
    retry = false,
  ) {
    const { status, failure, usage } = outcome;
    // Its calls still open will not run.
    for (const row of (await transcript(run)).rows) {
      if (row.kind !== "tool" || row.runId !== run.id || !open(row)) continue;
      await options.live?.end(row.id);
      await append({
        type: "tool.denied",
        actor: AGENT,
        data: { runId: run.id, callId: row.id, reason: "stopped" },
      });
    }
    const ended = await runs.end(lease, { status, usage });
    if (status === "failed") {
      await append({
        type: "run.failed",
        actor: AGENT,
        data: { runId: run.id, ...(failure ?? { error: "" }) },
      });
    } else if (status === "cancelled") {
      const by = ended.cancelRequestedBy;
      await append({
        type: "run.cancelled",
        actor: by ? { kind: "user", userId: by } : AGENT,
        data: { runId: run.id },
      });
    } else {
      await append({ type: "run.completed", actor: AGENT, data: { runId: run.id } });
    }
    // A branch no longer live takes nothing more.
    if (!(await live(run))) return false;
    const { pending, inbox } = await transcript(run);
    const waiting = await admissible(run.threadId, pending, append);
    // An interrupting message starts the next run, with everything queued; else another agent's.
    const first = waiting.find((message) => message.mode === "interrupt") ?? waiting[0];
    const relayed = waking(inbox)[0];
    const next: NewRun | null = retry
      ? {
          threadId: run.threadId,
          branchId: run.branchId,
          askedModel: run.askedModel,
          askedEffort: run.askedEffort,
          triggerSeq: run.triggerSeq,
          createdBy: null,
          continuesRunId: run.id,
          reason: "retry",
          attempt: run.attempt + 1,
        }
      : first
        ? {
            threadId: run.threadId,
            branchId: run.branchId,
            triggerSeq: first.seq,
            createdBy: first.author.userId,
            continuesRunId: run.id,
            reason: first.mode === "interrupt" ? "interrupt" : "queued_input",
          }
        : relayed
          ? {
              threadId: run.threadId,
              branchId: run.branchId,
              triggerSeq: relayed.seq,
              createdBy: null,
              continuesRunId: run.id,
              reason: "queued_input",
            }
          : null;
    // A message asking to compact the thread is taken in by the run that does it, at once.
    const admit = !retry && first && asksToCompact(first) ? [first.id] : [];
    if (next) await startRun(runs, append, next, admit);
    return next !== null;
  }

  // The reply slots of one run: each model step reserves one when it starts and completes it when
  // it ends. The pieces of a reply, of its reasoning and of its answer, are stored and announced in
  // small batches as they arrive, and dropped once the completed reply holds the whole text. How
  // long the model reasoned runs from its first reasoning piece to the first piece of its answer.
  function replies(execution: Execution) {
    const { run, lease, controller } = execution;
    let open: {
      id: string;
      text: string;
      reasoning: string;
      stored: number;
      buffer: string[];
      // What the buffered pieces are of.
      part: Part;
      reasoningFrom: number | null;
      reasoningMs: number | null;
      // Set once the model ended the step that writes it with no calls, with the step's token
      // use: it is completed by the next write that needs it, which may also end the run.
      ended: ModelUsage | null;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The batches being stored, one after another: a reply is completed only after the last of
    // them, so that no piece is stored or announced after the reply that holds it whole.
    let flushing: Promise<void> = Promise.resolve();

    // Waits for the batches being stored, and stores no more until the next is gathered. Called
    // before the write that closes the reply, never inside it: a batch is stored in a write of its
    // own, which would wait for the closing one.
    async function settled() {
      clearTimeout(timer);
      timer = undefined;
      await flushing;
    }

    function flush() {
      flushing = flushing.then(store);
      return flushing;
    }

    async function store() {
      clearTimeout(timer);
      timer = undefined;
      if (!open || open.buffer.length === 0) return;
      const batch = {
        messageId: open.id,
        index: open.stored,
        texts: open.buffer,
        ...(open.part === "reasoning" && { part: open.part }),
      };
      open.stored += batch.texts.length;
      open.buffer = [];
      try {
        const current = await transact(async () => {
          const held = await runs.hold(lease);
          await deltas.append(run.threadId, batch);
          bus.publish(run.threadId, {
            kind: "delta",
            messageId: batch.messageId,
            upto: batch.index + batch.texts.length,
          });
          return held;
        });
        stopIfAsked(execution, current);
      } catch (err) {
        if (!(err instanceof LeaseLost)) logger.error({ err, runId: run.id }, "reply pieces lost");
        controller.abort({ kind: "lease" } satisfies Abort);
      }
    }

    // Appends the open reply's completion, if any, and drops its pieces, inside a write that
    // follows `settled`. One the model ended is completed, whatever stopped the run since.
    async function close(append: Append, given: ReplyStatus, stepUsage?: ModelUsage) {
      clearTimeout(timer);
      timer = undefined;
      if (!open) return;
      const { id, text, reasoning, reasoningFrom, ended } = open;
      const status = ended ? "completed" : given;
      const usage = stepUsage ?? ended ?? undefined;
      const durationMs = open.reasoningMs ?? (reasoningFrom && now().getTime() - reasoningFrom);
      // Let go of once the write is kept: a write run again closes the reply again.
      const closing = open;
      options.afterCommit(() => {
        if (open === closing) open = null;
      });
      await deltas.remove(id);
      await append({
        type: "message.completed",
        actor: AGENT,
        data: {
          messageId: id,
          runId: run.id,
          parts: replyParts(text, reasoning, durationMs ?? undefined),
          status,
          ...(usage && { usage }),
        },
      });
    }

    async function start() {
      const id = ulid();
      await settled();
      await write(lease, run, async (append) => {
        await close(append, "completed");
        await append({
          type: "message.started",
          actor: AGENT,
          data: {
            messageId: id,
            runId: run.id,
            ...(execution.ref && { model: execution.ref }),
            ...(execution.effort && { effort: execution.effort }),
          },
        });
      });
      open = {
        id,
        text: "",
        reasoning: "",
        stored: 0,
        buffer: [],
        part: "text",
        reasoningFrom: null,
        reasoningMs: null,
        ended: null,
      };
      return id;
    }

    return {
      start,
      async add(text: string, part: Part = "text") {
        if (!open) await start();
        const reply = open!;
        // A batch holds pieces of one part.
        if (reply.part !== part) await flush();
        reply.part = part;
        if (part === "reasoning") {
          reply.reasoning += text;
          reply.reasoningFrom ??= now().getTime();
        } else {
          reply.text += text;
          if (reply.reasoningFrom !== null) {
            reply.reasoningMs ??= now().getTime() - reply.reasoningFrom;
          }
        }
        reply.buffer.push(text);
        timer ??= setTimeout(flush, flushMs);
      },
      async complete(usage: ModelUsage) {
        await settled();
        await write(lease, run, async (append) => close(append, "completed", usage));
      },
      // Notes that the model ended the reply's step with no calls, leaving its completion to
      // the next write that needs it.
      end(usage: ModelUsage) {
        if (open) open.ended = usage;
      },
      // Whether the reply's step ended and its completion is not written yet.
      ended() {
        return !!open?.ended;
      },
      // Completes the ended reply inside the write under way, when there is one.
      async closeEnded(append: Append) {
        if (open?.ended) await close(append, "completed");
      },
      // Completes the reply and, in the same write, whatever `then` does after it; what that
      // answers.
      async closeAnd<T>(then: (append: Append) => Promise<T>) {
        await settled();
        return write(lease, run, async (append) => {
          await close(append, "completed");
          return then(append);
        });
      },
      settled,
      close,
    };
  }

  // Aborts the run's stream when someone has asked it to stop.
  function stopIfAsked(execution: Execution, run: Run) {
    if (run.cancelRequestedAt && !execution.controller.signal.aborted) {
      execution.controller.abort({ kind: "cancel" } satisfies Abort);
    }
  }

  // At a step boundary: stops the run when asked to, otherwise takes in the waiting messages
  // (all of them before the first model call, afterwards only those sent to steer) in the order
  // they were sent, then every notification waiting, and returns them, the notifications as one.
  // Those asking to compact the thread wait for runs of their own.
  // A reply whose step ended is completed before what is taken in after it.
  async function boundary(
    execution: Execution,
    all: boolean,
    reply?: ReturnType<typeof replies>,
  ): Promise<ModelMessage[]> {
    const { run, lease, controller } = execution;
    await reply?.settled();
    const admitted = await write(lease, run, async (append) => {
      const current = await runs.hold(lease);
      stopIfAsked(execution, current);
      if (controller.signal.aborted) return [];
      const { people, inbox } = await toTakeIn(run, all, append);
      const ids = [...people, ...inbox].map((message) => message.id);
      if (ids.length > 0) {
        await reply?.closeEnded(append);
        await append({
          type: "message.admitted",
          actor: AGENT,
          data: { runId: run.id, messageIds: ids },
        });
      }
      return [
        ...people.map(humanMessage),
        ...(inbox.length > 0 ? [notificationsMessage(inbox)] : []),
      ];
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return admitted;
  }

  // What a step boundary takes in, inside the write under way: the people's messages waiting
  // (only those sent to steer, unless `all`) and every notification waiting.
  async function toTakeIn(run: Run, all: boolean, append: Append) {
    const { pending, inbox } = await transcript(run);
    const people = (await admissible(run.threadId, pending, append)).filter(
      (message) => !asksToCompact(message) && (all || message.mode === "steer"),
    );
    return { people, inbox };
  }

  // Ends the run as completed inside the write under way, once the model ended with a step that
  // made no calls, unless something waits to be taken in at the next boundary or it was asked to
  // stop; whether it did. The reply that step wrote is completed in the same write, so the two
  // are kept, and shown, together.
  async function endIfDone(execution: Execution, append: Append, usage: ModelUsage) {
    const { run, lease, controller } = execution;
    stopIfAsked(execution, await runs.hold(lease));
    if (controller.signal.aborted) return false;
    const { people, inbox } = await toTakeIn(run, false, append);
    if (people.length > 0 || inbox.length > 0) return false;
    await end(lease, run, append, { status: "completed", usage });
    return true;
  }

  // The tools the thread's agent may call now.
  async function offeredIn(space: Space, thread: Thread, now?: SpaceTools) {
    return narrow(thread, await tools.offered(space, now));
  }

  // The model the thread replies with now, opened.
  async function replying(execution: Execution, space: Space, thread: Thread): Promise<Replying> {
    // A model turned off, or gone with its provider, gives way to the space's default, then the
    // org's, each with its own effort; opening the one named fails the run saying why when none
    // can reply. A run asked to reply with a model of its own does so in place of the thread's.
    const own = { model: thread.model, effort: thread.effort };
    const { askedModel, askedEffort } = execution.run;
    const picked = await models.replyModel(
      space,
      askedModel ? { model: askedModel, effort: askedEffort } : own,
    );
    if (!picked) throw new RunFailure({ error: "", kind: "no_model" });
    const ref = picked.used?.ref ?? picked.chosen.ref;
    execution.ref = ref;
    execution.effort = picked.effort;
    const model = await models.open(space.orgId, ref);
    await runs.setModel(execution.lease, ref);
    return { model, effort: picked.effort, own };
  }

  // The MCP tools the thread leaves out of the model's requests until it turns them on: all it
  // could offer, those turned on, in the order they were, and those still left out.
  async function deferralOf(threadId: string, space: Space, now?: SpaceTools) {
    const all = await tools.fromServers(space, await tools.modelNames(space), now);
    const ids = new Set(all.map((tool) => tool.id));
    const turnedOn = (await runs.toolsOn(threadId)).filter((tool) => ids.has(tool.id));
    const on = new Set(turnedOn.map((tool) => tool.id));
    return { all, on, turnedOn, left: all.filter((tool) => !on.has(tool.id)) };
  }

  // A tool as the model knows it, which is how errors it reads name tools.
  async function modelName(space: Space, toolId: string) {
    return wireToolName((await tools.modelNames(space)).toModel(toolId));
  }

  // Records the calls a model step asked for, each with whether it waits for a decision. A call of
  // a tool not offered, or left out of the request and not turned on, or with input the tool does
  // not take, fails at once.
  async function request(
    execution: Execution,
    space: Space,
    calls: (ModelToolCall & { messageId: string })[],
  ) {
    const { run, lease } = execution;
    await write(lease, run, async (append) => {
      const thread = await threads.find(run.threadId);
      if (!thread) throw new LeaseLost(run.id);
      const { rows } = await transcript(run);
      const now = await tools.toolsIn(space);
      const offered = await offeredIn(space, thread, now);
      const { left } = await deferralOf(execution.run.threadId, space, now);
      const named = await tools.namesNow(space);
      for (const call of calls) {
        const { callId, toolId, input, messageId } = call;
        const unsearched = left.find((tool) => tool.id === toolId);
        const spec = unsearched
          ? undefined
          : offered.find((candidate) => candidate.name === toolId);
        const parsed = spec && spec.input.safeParse(input);
        const ok = !!spec && !!parsed?.success;
        const risk = ok ? await tools.riskOf(space, spec, parsed.data, execution.ref) : "normal";
        // A call that asks always waits for its answer.
        const waits =
          ok &&
          (spec.waitsFor === "answer" ||
            (
              await tools.evaluate(
                rows,
                thread,
                space,
                toolId,
                await spec.risk(parsed.data, { model: execution.ref, orgId: space.orgId }),
                parsed.data,
              )
            ).kind === "wait");
        const names = named(toolId);
        await append({
          type: "tool.requested",
          actor: AGENT,
          data: {
            runId: run.id,
            callId,
            messageId,
            toolId,
            input,
            risk,
            waits,
            ...(names && { title: names.title }),
            ...(names?.toolset && { toolset: names.toolset }),
          },
        });
        if (spec && parsed?.success) continue;
        await append({
          type: "tool.ran",
          actor: AGENT,
          data: {
            runId: run.id,
            callId,
            ok: false,
            error: unsearched
              ? `${await modelName(space, unsearched.name)} is not on yet. Search for it or select it with tools.search first.`
              : spec
                ? `The input is not valid: ${z.prettifyError(parsed!.error!)}`
                : `No tool is named ${toolId} here.`,
            ms: 0,
          },
        });
      }
    });
  }

  // The run's first open call that may run now, after denying those whose approval no longer
  // holds or whose tool is gone; when none may and some wait for a decision, the run waits.
  async function nextCall(execution: Execution, space: Space) {
    const { run, lease, controller } = execution;
    const next = await write(lease, run, async (append) => {
      stopIfAsked(execution, await runs.hold(lease));
      if (controller.signal.aborted) return null;
      const thread = await threads.find(run.threadId);
      if (!thread) throw new LeaseLost(run.id);
      const { rows } = await transcript(run);
      const calls = rows.filter(
        (row): row is ToolRow => row.kind === "tool" && row.runId === run.id && open(row),
      );
      const offered = await offeredIn(space, thread);
      let waiting = false;
      for (const call of calls) {
        const spec = offered.find((candidate) => candidate.name === call.toolId);
        const parsed = spec && spec.input.safeParse(call.input);
        let allowed = false;
        // Whose own login it goes with, for a tool that uses one, and the standing approval it
        // runs on, if any.
        let runAs: string | null = null;
        let standingOn: string | undefined;
        let approvedBy: string | undefined;
        if (spec && parsed?.success && spec.waitsFor === "answer") {
          // A call that asks runs once answered, while the answer holds.
          if (call.state === "pending") {
            waiting = true;
            continue;
          }
          allowed = await tools.answerHolds(call, rows, thread, space);
        } else if (spec && parsed?.success) {
          const risk = await tools.riskOf(space, spec, parsed.data, execution.ref);
          if (call.state === "allowed") {
            allowed = await tools.approvalHolds(call, rows, thread, space, risk);
            approvedBy = call.decision?.by.userId;
            // An approved call runs with its approver's own login.
            if (await spec.connection?.(parsed.data, space))
              runAs = call.decision?.by.userId ?? null;
          } else {
            const declared = await spec.risk(parsed.data, {
              model: execution.ref,
              orgId: space.orgId,
            });
            const decision = await tools.evaluate(
              rows,
              thread,
              space,
              call.toolId,
              declared,
              parsed.data,
            );
            allowed = decision.kind !== "wait";
            if (!allowed && call.waits) {
              waiting = true;
              continue;
            }
            if (decision.kind !== "wait") runAs = decision.runAs ?? null;
            if (decision.kind === "standing") standingOn = decision.callId;
          }
        }
        if (allowed) {
          return {
            call,
            spec: spec!,
            input: parsed!.data as unknown,
            runAs,
            standingOn,
            approvedBy,
          };
        }
        await append({
          type: "tool.denied",
          actor: AGENT,
          data: { runId: run.id, callId: call.id, reason: "stale" },
        });
      }
      if (waiting) {
        // A stop asked for since the run last looked finds it waiting no longer: it is queued
        // again, for a worker to end.
        const waits = await runs.wait(lease);
        if (waits.cancelRequestedAt) await runs.resume(run.id);
      }
      return waiting ? ("wait" as const) : null;
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (next === "wait") throw new Waiting();
    return next;
  }

  // Runs the run's open calls that may run, one at a time in order, until none is left; throws
  // Waiting when some wait for a decision. `request` gives a tool what the thread's next model call
  // would send.
  async function settle(execution: Execution, space: Space, request: () => Promise<ThreadRequest>) {
    const { run, lease } = execution;
    for (
      let next = await nextCall(execution, space);
      next;
      next = await nextCall(execution, space)
    ) {
      const { call, spec, input, runAs, standingOn, approvedBy } = next;
      const started = now().getTime();
      // The search for left-out tools is given them, and turns them on for the rest of the thread.
      const deferral =
        spec.name === TOOL_SEARCH ? await deferralOf(execution.run.threadId, space) : null;
      const span = tracer.startSpan(`execute_tool ${call.toolId}`, {
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": call.toolId,
          "gen_ai.tool.call.id": call.id,
          ...(contentRecorded() && { "gen_ai.tool.call.arguments": JSON.stringify(input) }),
        },
      });
      let output: ToolOutput;
      let adoption: Pick<Adoption, "work" | "controller" | "started"> | null = null;
      // The call has a stop of its own, which the run's stop reaches until it is moved.
      const callController = new AbortController();
      const stopCall = () => callController.abort(execution.controller.signal.reason);
      if (execution.controller.signal.aborted) stopCall();
      execution.controller.signal.addEventListener("abort", stopCall, { once: true });
      let moved = false;
      const toBackground = new Promise<typeof MOVED>((resolve) => {
        execution.running = {
          callId: call.id,
          spec: spec as AnyToolSpec,
          move: () => {
            moved = true;
            resolve(MOVED);
          },
        };
      });
      try {
        const work = context.with(trace.setSpan(context.active(), span), () =>
          tools.run(spec as AnyToolSpec, input, {
            threadId: run.threadId,
            spaceId: space.id,
            orgId: space.orgId,
            runId: run.id,
            callId: call.id,
            actor: AGENT,
            model: execution.ref,
            runAs,
            ...(approvedBy && { approvedBy }),
            signal: callController.signal,
            ...(options.live && {
              live: options.live.open(run.threadId, call.id, async () => holds(lease)),
            }),
            ...(call.answers && { answers: call.answers }),
            threadRequest: request,
            ...(deferral && {
              deferred: {
                tools: deferral.all,
                on: deferral.on,
                turnOn: async (ids: string[]) =>
                  write(lease, run, async () => runs.turnOn(lease, call.id, ids)),
              },
            }),
            // Once moved to the background the call writes on its own, the run's lease gone.
            write: async (work) =>
              moved
                ? (await log.write(run.threadId, async (append) => work(append), run.branchId))
                    .result
                : await write(lease, run, async (append) => work(append)),
          }),
        );
        const settled = await Promise.race([work, ...(options.adopt ? [toBackground] : [])]);
        if (settled === MOVED) {
          adoption = { work, controller: callController, started: new Date(started) };
          // The call goes on beside the run as one of its own, its stop its own from here.
          execution.controller.signal.removeEventListener("abort", stopCall);
          const id = await options.adopt!({
            ...adoption,
            threadId: run.threadId,
            runId: run.id,
            callId: call.id,
            toolId: call.toolId,
            input,
            risk: call.risk,
            ...(call.title && { title: call.title }),
            ...(call.toolset && { toolset: call.toolset }),
          });
          output = { ok: true, value: { movedToBackground: true, callId: id } };
        } else {
          output = settled;
        }
      } catch (err) {
        if (err instanceof LeaseLost) {
          span.end();
          throw err;
        }
        logger.warn({ err, runId: run.id, toolId: call.toolId }, "tool failed");
        output = { ok: false, error: messageOf(err) };
      } finally {
        execution.running = undefined;
        if (!adoption) {
          execution.controller.signal.removeEventListener("abort", stopCall);
          options.live?.close(call.id);
        }
      }
      span.setAttribute("tool.outcome", output.ok ? "ok" : "error");
      if (!output.ok) span.setStatus({ code: SpanStatusCode.ERROR });
      if (contentRecorded()) {
        const result = JSON.stringify(output.ok ? output.value : output.error);
        if (result) span.setAttribute("gen_ai.tool.call.result", result);
      }
      span.end();
      const ms = Math.max(0, now().getTime() - started);
      await write(lease, run, async (append) => {
        // What it printed while it ran goes as its result is recorded.
        await options.live?.end(call.id);
        await append({
          type: "tool.ran",
          actor: AGENT,
          data: {
            runId: run.id,
            callId: call.id,
            ms,
            ...(output.ok ? { ok: true, value: output.value } : { ok: false, error: output.error }),
            ...(output.ranAs && { ranAs: output.ranAs }),
            ...(standingOn && { standingOn }),
          },
        });
      });
    }
  }

  // What the thread's next model call sends, as the thread is now. MCP tools stay out of the
  // request until the model turns them on with the tool search, which is offered whenever the
  // thread has any; the prompt lists them all, on or not. The model knows tools by their model
  // names; calls, results and the prompt name them so.
  async function threadRequest(
    execution: Execution,
    space: Space,
    thread: Thread,
    model: Replying,
  ): Promise<ThreadRequest> {
    return requestOf(
      space,
      thread,
      (await transcript(execution.run)).rows,
      model.effort,
      execution.run.id,
    );
  }

  // What a model call would send for the rows, with the effort, as the run named sends it.
  async function requestOf(
    space: Space,
    thread: Thread,
    rows: readonly TranscriptRow[],
    effort: Thread["effort"],
    runId?: string,
  ): Promise<ThreadRequest> {
    const model = { effort };
    const now = await tools.toolsIn(space);
    const offered = await offeredIn(space, thread, now);
    const deferral = await deferralOf(thread.id, space, now);
    const searchable = new Set(deferral.all.map((tool) => tool.id));
    const available = offered.filter(
      (spec) => spec.name !== TOOL_SEARCH || deferral.all.length > 0,
    );
    const names = await tools.modelNames(space);
    const { instructions, messages, firstEffort } = contextOf(
      await whole(rows),
      {
        ...(await guidance(space, available, thread, now)),
        toolName: names.toModel,
        ...(deferral.all.length && { deferredTools: deferredByServer(deferral.all) }),
      },
      await before(thread),
      deferral.turnedOn,
      model.effort,
    );
    const forModel = (specs: AnyToolSpec[]) =>
      tools.forModel(specs).map((tool) => ({ ...tool, id: names.toModel(tool.id) }));
    return {
      instructions,
      messages: messages.map((message) => namedFor(message, names.toModel)),
      sessionId: thread.id,
      ...(runId && { runId }),
      ...(model.effort && { effort: model.effort }),
      ...(firstEffort && { firstEffort }),
      tools: forModel(available.filter((spec) => !searchable.has(spec.name))),
      searchable: forModel(available.filter((spec) => searchable.has(spec.name))),
      toolsOn: deferral.turnedOn.map((tool) => names.toModel(tool.id)),
      search: names.toModel(TOOL_SEARCH),
    };
  }

  // The message that woke the run when it asks to compact the thread, and so the run is one that
  // compacts it; null otherwise.
  async function compactionAsked(run: Run) {
    const trigger = await threads.eventAt(run.threadId, run.triggerSeq);
    if (trigger?.type !== "message") return null;
    if (trigger.actor.kind !== "user" || !trigger.data.command) return null;
    return asksToCompact(trigger.data)
      ? { id: trigger.id, by: trigger.actor, focus: trigger.data.command.args }
      : null;
  }

  // Compacts the thread with its model for whoever asked, taking in their message if it still
  // waits. With nothing to summarise, it leaves the thread as it is.
  async function compactFor(
    execution: Execution,
    space: Space,
    thread: Thread,
    model: Replying,
    asked: NonNullable<Awaited<ReturnType<typeof compactionAsked>>>,
  ) {
    const { run, lease, controller } = execution;
    await write(lease, run, async (append) => {
      stopIfAsked(execution, await runs.hold(lease));
      if (controller.signal.aborted) return;
      if (!(await transcript(run)).pending.some((message) => message.id === asked.id)) return;
      await append({
        type: "message.admitted",
        actor: AGENT,
        data: { runId: run.id, messageIds: [asked.id] },
      });
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    await compact({
      threadId: run.threadId,
      rows: await whole((await transcript(run)).rows),
      model: model.model,
      request: await threadRequest(execution, space, thread, model),
      ...(asked.focus && { focus: asked.focus }),
      actor: asked.by,
      write: async (work) => write(lease, run, work),
      signal: controller.signal,
    });
  }

  // Adds each step's token use to `usage`. Whether it ended the run.
  async function drive(
    execution: Execution,
    reply: ReturnType<typeof replies>,
    usage: ModelUsage,
  ): Promise<boolean> {
    const { run, controller } = execution;
    const thread = await threads.find(run.threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) throw new LeaseLost(run.id);
    if (!(await runsIn(space))) {
      controller.abort({ kind: "cancel" } satisfies Abort);
      throw controller.signal.reason;
    }
    let model = await replying(execution, space, thread);
    const asked = await compactionAsked(run);
    if (asked) {
      await compactFor(execution, space, thread, model, asked);
      return false;
    }
    // A run queued again after a decision takes in only the messages sent to steer it.
    const resumed = (await transcript(execution.run)).rows.some(
      (row) => row.kind === "tool" && row.runId === run.id,
    );

    const nextRequest = async () =>
      threadRequest(execution, space, (await threads.find(thread.id)) ?? thread, model);
    let steps = 0;
    // What the calls gave back goes to the model before the run ends.
    let answer = resumed;
    // Each model call is followed by another while steering messages keep arriving, or while
    // tool calls have results to give back.
    for (let call = 0; steps < maxSteps; call += 1) {
      const admitted = await boundary(execution, call === 0 && !resumed);
      await settle(execution, space, nextRequest);
      if (call > 0 && admitted.length === 0 && !answer) break;
      answer = false;
      // A tool that changed the thread's model or effort changes what replies from here.
      const current = (await threads.find(thread.id)) ?? thread;
      if (current.model !== model.own.model || current.effort !== model.own.effort) {
        model = await replying(execution, space, current);
      }
      const names = await tools.modelNames(space);
      const calls: (ModelToolCall & { messageId: string })[] = [];
      let messageId = "";
      const stream = model.model.stream(
        {
          ...(await threadRequest(execution, space, current, model)),
          maxSteps: maxSteps - steps,
          beforeStep: async () => boundary(execution, false, reply),
        },
        controller.signal,
      );
      for await (const event of stream) {
        switch (event.type) {
          case "step-start":
            steps += 1;
            messageId = await reply.start();
            break;
          case "delta":
            await reply.add(event.text);
            break;
          case "reasoning":
            await reply.add(event.text, "reasoning");
            break;
          case "tool-call": {
            const { type: _type, ...asked } = event;
            calls.push({
              ...asked,
              toolId: names.fromModel(asked.toolId) ?? asked.toolId,
              messageId,
            });
            break;
          }
          case "step-end":
            addUsage(usage, event.usage);
            if (calls.length > 0) await reply.complete(event.usage);
            else reply.end(event.usage);
            break;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (
        reply.ended() &&
        (await reply.closeAnd(async (append) => endIfDone(execution, append, usage)))
      )
        return true;
      if (calls.length > 0) {
        await request(execution, space, calls);
        await settle(execution, space, nextRequest);
        answer = true;
      }
    }
    return false;
  }

  async function execute(execution: Execution) {
    const { run, lease, controller, span } = execution;
    const reply = replies(execution);
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    // How the run's span ends: completed, failed, cancelled, waiting, or left to recovery.
    let outcome = "completed";
    try {
      if (!(await drive(execution, reply, usage))) {
        await reply.settled();
        await write(lease, run, async (append) => {
          await reply.close(append, "completed");
          await end(lease, run, append, { status: "completed", usage });
        });
      }
      await tellEnded(run);
    } catch (err) {
      if (err instanceof Waiting) {
        outcome = "waiting";
        logger.info({ runId: run.id }, "run waits for a decision");
        return;
      }
      const abort = controller.signal.aborted ? (controller.signal.reason as Abort) : null;
      if (abort?.kind === "cancel") {
        outcome = "cancelled";
        try {
          await reply.settled();
          await write(lease, run, async (append) => {
            await reply.close(append, "interrupted");
            await end(lease, run, append, { status: "cancelled", usage });
          });
          await tellEnded(run);
        } catch (writeErr) {
          if (writeErr instanceof LeaseLost)
            logger.warn({ runId: run.id }, "run end not saved: lease lost");
          else logger.error({ err: writeErr }, "run end not saved");
        }
        return;
      }
      if (err instanceof LeaseLost || abort) {
        outcome = "left";
        // A server stopping lets the run go at once, for the next to take over.
        if (abort?.kind === "shutdown") await runs.expire(lease);
        logger.info({ runId: run.id, reason: abort?.kind ?? "lease" }, "run left to recovery");
        return;
      }
      if (!(err instanceof RunFailure)) logger.warn({ err, runId: run.id }, "run failed");
      const { failure } = failureOf(err, execution.ref);
      outcome = "failed";
      span.setStatus({ code: SpanStatusCode.ERROR, message: failureSentence(failure) });
      if (failure.kind) span.setAttribute("run.error_kind", failure.kind);
      try {
        await reply.settled();
        await write(lease, run, async (append) => {
          await reply.close(append, "failed");
          await end(lease, run, append, { status: "failed", failure, usage });
        });
        await tellEnded(run);
      } catch (writeErr) {
        if (writeErr instanceof LeaseLost)
          logger.warn({ runId: run.id }, "run end not saved: lease lost");
        else logger.error({ err: writeErr }, "run end not saved");
      }
    } finally {
      executions.delete(run.id);
      span.setAttributes({
        "run.outcome": outcome,
        ...(execution.ref && { "run.model": execution.ref }),
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
      });
      span.end();
      options.traces?.ended(run.id);
      // The run that follows this one, if any, is linked to it.
      options.traces?.caused(run.threadId, true);
      await tick();
    }
  }

  // Fails running runs nobody holds any more: those whose lease ran out. Another instance may hold
  // the rest. Each is tried again until its input has failed too many times.
  async function recover() {
    for (const stale of await runs.stale()) {
      const run = await runs.takeOver(stale.id, owner, leaseMs);
      if (!run) continue;
      const lease = { runId: run.id, owner, epoch: run.leaseEpoch };
      const retry = run.attempt < maxAttempts;
      const failure: Failure = { error: "", kind: retry ? "interrupted" : "gave_up" };
      try {
        await write(lease, run, async (append) => {
          for (const row of (await transcript(run)).rows) {
            if (row.kind !== "agent" || row.runId !== run.id || row.status !== "streaming") {
              continue;
            }
            const { text, reasoning } = await deltas.partsOf(row.id);
            await deltas.remove(row.id);
            await append({
              type: "message.completed",
              actor: AGENT,
              data: {
                messageId: row.id,
                runId: run.id,
                parts: replyParts(text, reasoning),
                status: "failed",
              },
            });
          }
          await end(lease, run, append, { status: "failed", failure }, retry);
        });
        await tellEnded(run);
        if (!retry) logger.warn({ runId: run.id, attempt: run.attempt }, "run input given up on");
      } catch (err) {
        logger.error({ err, runId: run.id }, "run recovery failed");
      }
    }
  }

  // Tells whoever needs to of the run that ended; what they do with it is theirs to get right.
  async function tellEnded(run: Run) {
    try {
      await ended((await runs.find(run.id)) ?? run);
    } catch (err) {
      logger.error({ err, runId: run.id }, "run end not told");
    }
  }

  // The run's span: in the trace of what woke its thread, or none when not traced.
  async function spanOf(run: Run) {
    if (!options.traces) return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    const thread = await threads.find(run.threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    return options.traces.start(run, {
      "thread.id": run.threadId,
      "run.id": run.id,
      "run.attempt": run.attempt,
      ...(run.reason && { "run.reason": run.reason }),
      ...(space && { "space.id": space.id, "org.id": space.orgId }),
    });
  }

  async function begin(run: Run) {
    const span = await spanOf(run);
    const execution: Execution = {
      run,
      lease: { runId: run.id, owner, epoch: run.leaseEpoch },
      ref: null,
      effort: null,
      controller: new AbortController(),
      done: Promise.resolve(),
      span,
    };
    executions.set(run.id, execution);
    // Claimed: the run's thread now shows the agent replying.
    bus.activity({ threadId: run.threadId });
    // A claim can happen while a request is handled; the run is traced apart from it.
    const release = transcripts.hold(run.threadId);
    execution.done = context
      .with(trace.setSpan(ROOT_CONTEXT, span), () => execute(execution))
      .finally(release);
  }

  // Moves the call running now in one of the runs here to the background; whether it could.
  function moveHere(threadId: string, callId: string) {
    for (const execution of executions.values()) {
      const { running } = execution;
      if (execution.run.threadId !== threadId || running?.callId !== callId) continue;
      if (running.spec.waitsFor === "answer" || running.spec.name.startsWith("calls.")) {
        return false;
      }
      running.move();
      return true;
    }
    return false;
  }

  // Claims and begins the runs waiting, after failing those others left: one pass at a time,
  // and asked for while one is under way, that one goes round once more.
  const ticker = options.sync.ticker(
    "runs",
    async () => {
      if (stopped) return;
      await recover();
      for (
        let run = await runs.claim(owner, leaseMs);
        run;
        run = await runs.claim(owner, leaseMs)
      ) {
        await begin(run);
      }
    },
    pollMs,
  );
  const tick = () => ticker.now();

  // Keeps the leases of the runs in progress here, letting go of any no longer this worker's, and
  // fails those others left.
  const keeper = options.sync.keeper({
    name: "runs",
    everyMs: leaseMs / 3,
    held: () => executions.values(),
    renew: async (execution: Execution) => {
      try {
        stopIfAsked(execution, await runs.renew(execution.lease, leaseMs));
        return true;
      } catch (err) {
        if (!(err instanceof LeaseLost)) {
          logger.error({ err, runId: execution.run.id }, "lease renewal failed");
        }
        return false;
      }
    },
    onLost: (execution: Execution) => {
      execution.controller.abort({ kind: "lease" } satisfies Abort);
    },
    sweep: recover,
  });

  return {
    // Fails the runs a stopped server left running whose leases have expired. Call before serving
    // and starting; the worker looks again as it ticks.
    async recover() {
      await recover();
    },

    // The model the thread replies with, opened, and what its next call would send were the
    // branch to end at the row, or at its last when none is named: the start of what is asked
    // about that row from outside the thread's runs, so that it reads what the provider's prompt
    // cache holds of the thread.
    async requestAt(threadId: string, branchId: string, rowId?: string) {
      const thread = await threads.find(threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!thread || !space) throw new RunFailure({ error: "", kind: "gone" });
      const picked = await models.replyModel(space, { model: thread.model, effort: thread.effort });
      if (!picked) throw new RunFailure({ error: "", kind: "no_model" });
      const ref = picked.used?.ref ?? picked.chosen.ref;
      const model = await models.open(space.orgId, ref);
      const { rows } = await transcript({ threadId, branchId });
      const index = rowId === undefined ? -1 : rows.findIndex((row) => row.id === rowId);
      const read = await whole(rows.slice(0, index === -1 ? rows.length : index + 1));
      return {
        model,
        ref,
        rows: read,
        request: await requestOf(space, thread, read, picked.effort),
      };
    },

    async start() {
      if (!stopped) return;
      stopped = false;
      const woken = async (threadId: string) => {
        // Whatever woke the thread is linked from its next run, and from the one under way.
        const cause = options.traces?.caused(threadId);
        for (const execution of executions.values()) {
          if (execution.run.threadId !== threadId) continue;
          // Not the run's own work, as when one of its tools wakes its thread.
          const own = cause?.context.traceId === execution.span.spanContext().traceId;
          if (cause && !own) execution.span.addLink(cause);
          try {
            stopIfAsked(execution, await runs.hold(execution.lease));
          } catch (err) {
            if (!(err instanceof LeaseLost)) logger.error({ err }, "stop check failed");
          }
        }
        await tick();
      };
      const wakes = bus.onWake(
        (threadId) =>
          void woken(threadId).catch((err: unknown) => logger.error({ err }, "wake failed")),
      );
      // A person asked through another instance to move a call running here.
      const moves = bus.onMoveCall(({ threadId, callId }) => {
        moveHere(threadId, callId);
      });
      // What may have been missed is looked for at once.
      const gaps = bus.onGap(() => {
        void tick();
        void keeper.beat();
      });
      unsubscribe = [wakes, moves, gaps];
      await keeper.start();
      await ticker.start();
    },

    // Moves the thread's call that is running now to the background, where its run carries on
    // without waiting for it; whether it was running here and may move. A run another instance
    // holds is asked to, and that instance moves it if it may.
    async moveToBackground(threadId: string, callId: string) {
      if (moveHere(threadId, callId)) return true;
      const run = await runs.active(threadId);
      if (run?.status !== "running" || !run.leaseOwner || run.leaseOwner === owner) return false;
      bus.moveCall({ threadId, callId });
      return true;
    },

    // Stops claiming and lets the runs in progress go, for recovery here or elsewhere.
    async stop() {
      stopped = true;
      await ticker.stop();
      await keeper.stop();
      for (const stop of unsubscribe) stop();
      unsubscribe = [];
      for (const execution of executions.values()) {
        execution.controller.abort({ kind: "shutdown" } satisfies Abort);
      }
      await Promise.allSettled([...executions.values()].map((execution) => execution.done));
    },

    // Resolves once no run is in progress and none is waiting to be claimed.
    async idle() {
      for (;;) {
        await tick();
        if (executions.size === 0) return;
        await Promise.allSettled([...executions.values()].map((execution) => execution.done));
      }
    },
  };
}

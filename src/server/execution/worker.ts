// The agent worker: an in-process loop, woken by the event signals and by a slow poll, that claims
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
// replies with nothing; other runs leave it waiting. Notices wait like a steer: each
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
import { addUsage } from "@/shared/usage.ts";
import { ulid } from "ulid";

import type { AfterCommit, Sync, Transact } from "@/server/sync/sync.ts";
import { type Lease as RowLease, LeaseLost } from "@/server/sync/lease.ts";
import type { Signals } from "@/server/sync/signals.ts";
import { connectionOf, failureSentence } from "./failure-text.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { RunTraces } from "@/server/kernel/tracing.ts";
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
import type { Append, ThreadLog } from "@/server/threads/log.ts";
import type { DeltaStore, Thread, ThreadStore } from "@/server/threads/types.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import type { Queue } from "@/server/queue/queue.ts";
import type { EventDataMap, ReplyPart, ReplyStatus, RunReason } from "@/shared/threads/events.ts";
import { asksToCompact, type TranscriptRow } from "@/shared/transcript.ts";

import type { CallContext, Calls, RequestContext, RunHold } from "@/server/calls/calls.ts";
import { compact, type ThreadRequest, wholeWhereRead } from "./compaction.ts";
import {
  contextOf,
  type Guidance,
  type ToolOn,
  humanMessage,
  NO_GUIDANCE,
  noticesMessage,
} from "./context.ts";
import { deferredByServer } from "@/server/tools/search.ts";
import type {
  AnyToolSpec,
  DeferredTool,
  ModelNames,
  SpaceTools,
  ToolNames,
  Tools,
} from "@/server/tools/registry.ts";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type EndStatus = Extract<RunStatus, "completed" | "failed" | "cancelled">;

export interface Run {
  id: string;
  threadId: string;
  // The branch it writes in.
  branchId: string;
  status: RunStatus;
  // The seq of the message that woke the agent.
  wokenBySeq: number;
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
  // Stopped with the run that started its thread, whose agent is not told.
  cancelSilent: boolean;
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
  wokenBySeq: number;
  createdBy: string | null;
  continuesRunId?: string | null;
  reason?: RunReason | null;
  attempt?: number;
}

// Where runs are stopped: the current branch of a thread, a branch, or every thread of a space or
// of an org.
export type StopTarget =
  | { threadId: string }
  | { branchId: string }
  | { spaceId: string }
  | { orgId: string };

// The right to write for a run, held by one worker until it ends or expires.
export interface Lease extends RowLease {
  runId: string;
}

export { LeaseLost };

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
  // Asks each run under way there that nobody asked yet to stop, in one statement each, queueing
  // again one that waits so that a worker ends it; the runs asked. A null user is the server
  // itself, as when the agent may no longer run in the thread's space.
  stop(target: StopTarget, by: string | null, silent: boolean, at: Date): Promise<Run[]>;
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
  // Lets the lease go while the run waits for a person's decision; nothing holds it meanwhile.
  // Null once someone asked it to stop, for its holder to end it.
  wait(lease: Lease): Promise<Run | null>;
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
  // Records the run's tool calls, decides which may run, and runs them.
  calls: Pick<Calls, "request" | "next" | "run" | "closeFor">;
  // Where the inputs waiting for the agent stand, and how a run takes them in.
  queue: Pick<Queue, "waiting" | "admission">;
  threads: Pick<ThreadStore, "find" | "eventAt">;
  // Held while a run executes, so its thread is folded once.
  transcripts: Pick<Transcripts, "of" | "hold" | "whole">;
  spaceStore: Pick<SpaceStore, "find">;
  deltas: DeltaStore;
  log: ThreadLog;
  signals: Signals;
  transact: Transact;
  afterCommit: AfterCommit;
  // Names this server instance in the leases it takes on runs.
  instanceId: string;
  // The worker's periodic pass and the keeper of its leases.
  sync: Pick<Sync, "ticker" | "keeper" | "inTransaction" | "holds">;
  models: Pick<Models, "open" | "replyModel">;
  tools: Pick<
    Tools,
    | "toolsIn"
    | "offered"
    | "forModel"
    | "modelNames"
    | "fromServers"
    | "namesNow"
    | "searchTool"
    | "turnOn"
    | "turnedOn"
  >;
  // What the org and the space tell the agent beyond Mage's own prompt, given the tools offered,
  // and what the thread does about it.
  guidance?: (
    space: Space,
    offered: readonly AnyToolSpec[],
    thread: Thread,
    now: SpaceTools,
  ) => Promise<Guidance>;
  // What the thread's agent reads ahead of the thread itself; nothing when not given.
  before?: (thread: Thread) => Promise<ModelMessage[]>;
  // Starts what follows a run that ended, inside the write that ends it, or what a thread whose
  // start was missed has waiting.
  advance?: (threadId: string, opts: { after?: Run }) => Promise<Run | null>;
  // Hears of each run that ended, with the run that follows it if any, inside the write that ends
  // it.
  ended?: (run: Run, next: Run | null) => Promise<void>;
  // Hears of each run whose end is kept, once the write that ended it commits.
  endKept?: (run: Run) => Promise<void>;
  // The thread whose agent started a subagent's thread, locked with it as a run of it ends.
  parentOf?: (threadId: string) => Promise<string | null>;
  // Threads whose agent has something to start on and no run under way, looked at each pass.
  stranded?: () => Promise<string[]>;
  logger: Logger;
  // What ties each run's span to the work that woke its thread; runs are not traced without it.
  traces?: RunTraces;
  // Whether the agent may run in the space; a run claimed where it may not is stopped unstarted.
  runsIn?: (space: Space) => Promise<boolean>;
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

// What a run step reads of its thread and space at its start.
interface RunContext {
  thread: Thread;
  space: Space;
  // What the space had of tools when the step started.
  now: SpaceTools;
  // The tools the thread's agent may call, and of them those its model is sent: the search only
  // where there is something to search.
  offered: AnyToolSpec[];
  available: AnyToolSpec[];
  deferral: { all: DeferredTool[]; on: Set<string>; turnedOn: ToolOn[]; left: DeferredTool[] };
  names: ModelNames;
  // What each tool is called now, read once the step asks for calls.
  titles?: (toolId: string) => ToolNames | null;
  guidance: Guidance;
  before: ModelMessage[];
}

// The model a run replies with, and the thread's own model and effort it was chosen from.
interface Replying {
  model: OpenModel;
  effort: Thread["effort"];
  own: Pick<Thread, "model" | "effort">;
}

interface Running {
  run: Run;
  lease: Lease;
  // The model ref the run replies with, once chosen, and the effort it is asked for.
  ref: string | null;
  effort: Thread["effort"];
  controller: AbortController;
  done: Promise<void>;
  span: Span;
  // The thread whose agent started this one's, for a subagent's run.
  parent: string | null;
}

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

// Starts a run in a transaction that is appending to the thread; what it takes in at its start is
// for the caller to admit.
export async function startRun(runs: Pick<RunStore, "create">, append: Append, input: NewRun) {
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
  return run;
}

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : "The model did not answer.";
}

export function createRunWorker(options: RunWorkerOptions) {
  const { runs, calls, queue, threads, transcripts, spaceStore, deltas, log, signals, transact } =
    options;
  const { models, tools, logger } = options;
  const now = options.now ?? (() => new Date());
  const guidance = options.guidance ?? (() => NO_GUIDANCE);
  const runsIn = options.runsIn ?? (async () => Promise.resolve(true));
  const before = options.before ?? (() => []);
  const advance = options.advance ?? (async () => null);
  const parentOf = options.parentOf ?? (async () => null);
  const stranded = options.stranded ?? (async () => []);
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 5_000;
  const flushMs = options.flushMs ?? 75;
  const maxSteps = options.maxSteps ?? 20;
  const maxAttempts = options.maxAttempts ?? 3;
  const owner = options.instanceId;
  const executions = new Map<string, Running>();
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

  // Appends the run's events to its branch only while its lease holds; `also` names the other
  // threads the write may reach, locked with the run's in order.
  async function write<T>(
    lease: Lease,
    run: Pick<Run, "threadId" | "branchId">,
    work: (append: Append) => T,
    also: string[] = [],
  ) {
    return (
      await log.write(
        run.threadId,
        async (append) => {
          await runs.hold(lease);
          return work(append);
        },
        run.branchId,
        also,
      )
    ).result;
  }

  // A write that may end the run: it holds the thread that started the run's thread as well, for
  // what is told there of the end.
  async function ending<T>(
    execution: Pick<Running, "run" | "lease" | "parent">,
    work: (append: Append) => T,
  ) {
    return write(execution.lease, execution.run, work, execution.parent ? [execution.parent] : []);
  }

  // Ends the run, closing its calls, then starts what follows and tells whoever needs to of its
  // end, all in the write under way, which holds the thread that started the run's thread too.
  async function end(
    lease: Lease,
    run: Run,
    append: Append,
    outcome: { status: EndStatus; failure?: Failure; usage?: ModelUsage },
    retry = false,
  ) {
    const { status, failure, usage } = outcome;
    // Its calls still open will not run.
    await calls.closeFor(run, append);
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
    // The same input again when it is to be retried; else whatever waited for it, where its
    // branch still takes runs.
    const next = retry
      ? await startRun(runs, append, {
          threadId: run.threadId,
          branchId: run.branchId,
          askedModel: run.askedModel,
          askedEffort: run.askedEffort,
          wokenBySeq: run.wokenBySeq,
          createdBy: null,
          continuesRunId: run.id,
          reason: "retry",
          attempt: run.attempt + 1,
        })
      : await advance(run.threadId, { after: ended });
    await options.ended?.(ended, next);
    return next !== null;
  }

  // The reply slots of one run: each model step reserves one when it starts and completes it when
  // it ends. The pieces of a reply, of its reasoning and of its answer, are stored and announced in
  // small batches as they arrive, and dropped once the completed reply holds the whole text. How
  // long the model reasoned runs from its first reasoning piece to the first piece of its answer.
  function replies(execution: Running) {
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
          signals.publish(run.threadId, {
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
        return ending(execution, async (append) => {
          await close(append, "completed");
          return then(append);
        });
      },
      settled,
      close,
    };
  }

  // Whether the run was asked to stop, or is already aborted; a stop seen is aborted once the
  // write under way is kept, so a write run again aborts nothing twice.
  function stopIfAsked(execution: Running, run: Pick<Run, "cancelRequestedAt">) {
    const { controller } = execution;
    if (run.cancelRequestedAt && !controller.signal.aborted) {
      options.afterCommit(() => {
        if (!controller.signal.aborted) controller.abort({ kind: "cancel" } satisfies Abort);
      });
      return true;
    }
    return controller.signal.aborted;
  }

  // At a step boundary: stops the run when asked to, otherwise takes in the waiting messages
  // (all of them before the first model call, afterwards only those sent to steer) in the order
  // they were sent, then every notice waiting, and returns them, the notices as one.
  // Those asking to compact the thread wait for runs of their own.
  // A reply whose step ended is completed before what is taken in after it.
  async function boundary(
    execution: Running,
    all: boolean,
    reply?: ReturnType<typeof replies>,
  ): Promise<ModelMessage[]> {
    const { run, lease, controller } = execution;
    await reply?.settled();
    const admitted = await write(lease, run, async (append) => {
      if (stopIfAsked(execution, await runs.hold(lease))) return [];
      const taken = await queue.admission.admit(run, all ? "all" : "steering", {
        before: async () => reply?.closeEnded(append),
      });
      const people = taken.flatMap((input) => (input.message ? [input.message] : []));
      const notices = taken.flatMap((input) => (input.notice ? [input.notice] : []));
      return [
        ...people.map(humanMessage),
        ...(notices.length > 0 ? [noticesMessage(notices)] : []),
      ];
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return admitted;
  }

  // Ends the run as completed inside the write under way, once the model ended with a step that
  // made no calls, unless a message sent to steer or a notice that wakes the agent waits, or it
  // was asked to stop; whether it did. A notice that does not wake it waits for the next run. The reply that step wrote is completed in the same write, so the two
  // are kept, and shown, together.
  async function endIfDone(execution: Running, append: Append, usage: ModelUsage) {
    const { run, lease } = execution;
    if (stopIfAsked(execution, await runs.hold(lease))) return false;
    const steers = (await queue.admission.admissible(run.threadId, run.branchId)).some(
      (input) =>
        (input.kind === "notice" && input.wake) ||
        (input.delivery === "steer" && !(input.message && asksToCompact(input.message))),
    );
    if (steers) return false;
    await end(lease, run, append, { status: "completed", usage });
    return true;
  }

  // The tools the thread's agent may call now.
  async function offeredIn(space: Space, thread: Thread, now?: SpaceTools) {
    return tools.offered(space, thread, now);
  }

  // The model the thread replies with now, opened.
  async function replying(execution: Running, space: Space, thread: Thread): Promise<Replying> {
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
  async function deferralOf(threadId: string, space: Space, now: SpaceTools) {
    const all = await tools.fromServers(space, await tools.modelNames(space, now), now);
    const ids = new Set(all.map((tool) => tool.id));
    const turnedOn = (await tools.turnedOn(threadId)).filter((tool) => ids.has(tool.id));
    const on = new Set(turnedOn.map((tool) => tool.id));
    return { all, on, turnedOn, left: all.filter((tool) => !on.has(tool.id)) };
  }

  // What the step's calls are decided with, as the step read it at its start.
  function callContext(ctx: RunContext): CallContext {
    const { thread, space, offered, now } = ctx;
    return { thread, space, offered, now };
  }

  // What the calls the step asks for are recorded with, outside the write that records them.
  async function requestContext(ctx: RunContext): Promise<RequestContext> {
    ctx.titles ??= await tools.namesNow(ctx.space, ctx.now);
    const { deferral, titles, names } = ctx;
    return { ...callContext(ctx), left: deferral.left, titles, names };
  }

  // The run as its calls are made and run for it, held under its lease.
  function holdOf(execution: Running): RunHold {
    const { run, lease } = execution;
    return { run, hold: async () => runs.hold(lease), ref: execution.ref };
  }

  // The run's first open call that may run now; when none may and some wait for a person, the
  // run waits.
  async function nextCall(execution: Running, ctx: RunContext) {
    const { run, lease, controller } = execution;
    const next = await write(lease, run, async () => {
      if (stopIfAsked(execution, await runs.hold(lease))) return null;
      const found = await calls.next(holdOf(execution), callContext(ctx));
      // A run asked to stop since it last looked may not wait: it ends here instead.
      if (found === "wait" && !(await runs.wait(lease))) {
        stopIfAsked(execution, { cancelRequestedAt: now() });
        return null;
      }
      return found;
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (next === "wait") throw new Waiting();
    return next;
  }

  // Runs the run's open calls that may run, one at a time in order, until none is left, answering
  // whether any ran; throws Waiting when some wait for a decision. `request` gives a tool what the
  // thread's next model call would send.
  async function settle(
    execution: Running,
    ctx: RunContext,
    request: () => Promise<ThreadRequest>,
  ) {
    const { run, lease } = execution;
    const { space, now } = ctx;
    let ran = false;
    for (let next = await nextCall(execution, ctx); next; next = await nextCall(execution, ctx)) {
      ran = true;
      await calls.run(next, holdOf(execution), {
        signal: execution.controller.signal,
        threadRequest: request,
        deferral: async () => deferralOf(run.threadId, space, now),
        turnOn: async (callId, ids) =>
          write(lease, run, async () => tools.turnOn(run.threadId, callId, ids)),
      });
    }
    return ran;
  }

  // What the thread's next model call sends, as the thread is now. MCP tools stay out of the
  // request until the model turns them on with the tool search, which is offered whenever the
  // thread has any; the prompt lists them all, on or not. The model knows tools by their model
  // names; calls, results and the prompt name them so.
  async function threadRequest(
    execution: Running,
    ctx: RunContext,
    model: Replying,
  ): Promise<ThreadRequest> {
    return requestOf(ctx, (await transcript(execution.run)).rows, model.effort, execution.run.id);
  }

  // What a run step reads of its thread and space, once, at its start: the tools offered, those
  // left out of the request, what the model calls them, what it is told and reads ahead of the
  // thread. A change made during the step takes effect at the next.
  async function contextFor(space: Space, thread: Thread): Promise<RunContext> {
    const now = await tools.toolsIn(space);
    const offered = await offeredIn(space, thread, now);
    const deferral = await deferralOf(thread.id, space, now);
    const available = offered.filter(
      (spec) => spec.deferral !== "search" || deferral.all.length > 0,
    );
    return {
      thread,
      space,
      now,
      offered,
      available,
      deferral,
      names: await tools.modelNames(space, now),
      guidance: await guidance(space, available, thread, now),
      before: await before(thread),
    };
  }

  // What a model call would send for the rows, with the effort, as the run named sends it.
  async function requestOf(
    ctx: RunContext,
    rows: readonly TranscriptRow[],
    effort: Thread["effort"],
    runId?: string,
  ): Promise<ThreadRequest> {
    const { thread, available, deferral, names } = ctx;
    const searchable = new Set(deferral.all.map((tool) => tool.id));
    const { instructions, messages, firstEffort } = contextOf(
      await whole(rows),
      {
        ...ctx.guidance,
        toolName: names.toModel,
        ...(deferral.all.length && { deferredTools: deferredByServer(deferral.all) }),
      },
      ctx.before,
      deferral.turnedOn,
      effort,
    );
    const forModel = (specs: AnyToolSpec[]) =>
      tools.forModel(specs).map((tool) => ({ ...tool, id: names.toModel(tool.id) }));
    return {
      instructions,
      messages: messages.map((message) => namedFor(message, names.toModel)),
      sessionId: thread.id,
      ...(runId && { runId }),
      ...(effort && { effort }),
      ...(firstEffort && { firstEffort }),
      tools: forModel(available.filter((spec) => !searchable.has(spec.name))),
      searchable: forModel(available.filter((spec) => searchable.has(spec.name))),
      toolsOn: deferral.turnedOn.map((tool) => names.toModel(tool.id)),
      search: names.toModel(tools.searchTool() ?? ""),
    };
  }

  // The message that woke the run when it asks to compact the thread, and so the run is one that
  // compacts it; null otherwise.
  async function compactionAsked(run: Run) {
    const woke = await threads.eventAt(run.threadId, run.wokenBySeq);
    if (woke?.type !== "message") return null;
    if (woke.actor.kind !== "user" || !woke.data.command) return null;
    return asksToCompact(woke.data)
      ? { id: woke.id, by: woke.actor, focus: woke.data.command.args }
      : null;
  }

  // Compacts the thread with its model for whoever asked, taking in their message if it still
  // waits. With nothing to summarise, it leaves the thread as it is.
  async function compactFor(
    execution: Running,
    space: Space,
    thread: Thread,
    model: Replying,
    asked: NonNullable<Awaited<ReturnType<typeof compactionAsked>>>,
  ) {
    const { run, lease, controller } = execution;
    await write(lease, run, async () => {
      if (stopIfAsked(execution, await runs.hold(lease))) return;
      await queue.admission.admit(run, { ids: [asked.id] });
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    await compact({
      threadId: run.threadId,
      rows: await whole((await transcript(run)).rows),
      model: model.model,
      request: await threadRequest(execution, await contextFor(space, thread), model),
      ...(asked.focus && { focus: asked.focus }),
      actor: asked.by,
      write: async (work) => write(lease, run, work),
      signal: controller.signal,
    });
  }

  // Adds each step's token use to `usage`. Whether it ended the run.
  async function drive(
    execution: Running,
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
      (row) => row.kind === "tool" && row.runId === run.id && (!row.background || !!row.moved),
    );

    // What a tool is given of the thread's next model call is as the step it runs in reads it.
    let ctx: RunContext | null = null;
    const nextRequest = async () =>
      threadRequest(execution, (ctx ??= await contextFor(space, thread)), model);
    let steps = 0;
    // What the calls gave back goes to the model before the run ends.
    let answer = resumed;
    // Each model call is followed by another while steering messages keep arriving, or while
    // tool calls have results to give back.
    for (let call = 0; steps < maxSteps; call += 1) {
      const admitted = await boundary(execution, call === 0 && !resumed);
      // A run resumed after waiting reads its context again before its calls go on, and keeps it
      // for its first model call unless they ran.
      const fresh = !ctx;
      ctx ??= await contextFor(space, thread);
      const ran = await settle(execution, ctx, nextRequest);
      if (call > 0 && admitted.length === 0 && !answer) break;
      answer = false;
      // A tool that changed the thread's model or effort changes what replies from here.
      const current = (await threads.find(thread.id)) ?? thread;
      if (current.model !== model.own.model || current.effort !== model.own.effort) {
        model = await replying(execution, space, current);
      }
      if (!fresh || ran) ctx = await contextFor(space, current);
      const { names } = ctx;
      const asked: (ModelToolCall & { messageId: string })[] = [];
      let messageId = "";
      const stream = model.model.stream(
        {
          ...(await threadRequest(execution, ctx, model)),
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
            const { type: _type, ...call } = event;
            asked.push({
              ...call,
              toolId: names.fromModel(call.toolId) ?? call.toolId,
              messageId,
            });
            break;
          }
          case "step-end":
            addUsage(usage, event.usage);
            if (asked.length > 0) await reply.complete(event.usage);
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
      if (asked.length > 0) {
        await calls.request(holdOf(execution), asked, await requestContext(ctx));
        await settle(execution, ctx, nextRequest);
        answer = true;
      }
    }
    return false;
  }

  async function execute(execution: Running) {
    const { run, lease, controller, span } = execution;
    const reply = replies(execution);
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    // How the run's span ends: completed, failed, cancelled, waiting, or left to recovery.
    let outcome = "completed";
    try {
      if (!(await drive(execution, reply, usage))) {
        await reply.settled();
        await ending(execution, async (append) => {
          await reply.close(append, "completed");
          await end(lease, run, append, { status: "completed", usage });
        });
      }
      await kept(run);
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
          await ending(execution, async (append) => {
            await reply.close(append, "interrupted");
            await end(lease, run, append, { status: "cancelled", usage });
          });
          await kept(run);
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
        await ending(execution, async (append) => {
          await reply.close(append, "failed");
          await end(lease, run, append, { status: "failed", failure, usage });
        });
        await kept(run);
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
        await ending({ run, lease, parent: await parentOf(run.threadId) }, async (append) => {
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
        await kept(run);
        if (!retry) logger.warn({ runId: run.id, attempt: run.attempt }, "run input given up on");
      } catch (err) {
        logger.error({ err, runId: run.id }, "run recovery failed");
      }
    }
  }

  // Tells whoever needs to of the run whose end was kept; what they do with it is theirs to get
  // right.
  async function kept(run: Run) {
    try {
      await options.endKept?.((await runs.find(run.id)) ?? run);
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
    const execution: Running = {
      run,
      lease: { runId: run.id, owner, epoch: run.leaseEpoch },
      ref: null,
      effort: null,
      controller: new AbortController(),
      done: Promise.resolve(),
      span,
      parent: await parentOf(run.threadId),
    };
    executions.set(run.id, execution);
    // Claimed: the run's thread now shows the agent replying.
    signals.changed({ threadId: run.threadId });
    // A claim can happen while a request is handled; the run is traced apart from it.
    const release = transcripts.hold(run.threadId);
    execution.done = context
      .with(trace.setSpan(ROOT_CONTEXT, span), () => execute(execution))
      .finally(release);
  }

  // Claims and begins the runs waiting, after failing those others left: one pass at a time,
  // and asked for while one is under way, that one goes round once more.
  const ticker = options.sync.ticker(
    "runs",
    async () => {
      if (stopped) return;
      await recover();
      // Threads with something to start on and nothing under way start now, whatever start was
      // missed.
      for (const threadId of await stranded()) {
        try {
          await advance(threadId, {});
        } catch (err) {
          logger.error({ err, threadId }, "stranded thread not started");
        }
      }
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
    renew: async (execution: Running) => {
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
    onLost: (execution: Running) => {
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
        request: await requestOf(await contextFor(space, thread), read, picked.effort),
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
      const wakes = signals.onWake(
        (threadId) =>
          void woken(threadId).catch((err: unknown) => logger.error({ err }, "wake failed")),
      );
      // What may have been missed is looked for at once.
      const gaps = signals.onGap(() => {
        void tick();
        void keeper.beat();
      });
      unsubscribe = [wakes, gaps];
      await keeper.start();
      await ticker.start();
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

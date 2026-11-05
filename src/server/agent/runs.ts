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
// thread, as a subagent's do; and whoever needs to hears of each run that ends.

import { wireToolName } from "@/shared/tools.ts";
import { ulid } from "ulid";
import * as z from "zod";

import type { Transact } from "@/server/db/db.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { ConnectionError } from "@/server/models/connections.ts";
import {
  ModelError,
  type ModelErrorKind,
  type ModelMessage,
  type ModelToolCall,
  type ModelUsage,
} from "@/server/models/gateway.ts";
import type { Models, OpenModel } from "@/server/models/service.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import type { ThreadAccess } from "@/server/spaces/thread-access.ts";
import { type Append, eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { DeltaStore, Thread, ThreadStore } from "@/server/threads/service.ts";
import type {
  EventDataMap,
  ReplyPart,
  ReplyStatus,
  FailureKind,
  RunReason,
} from "@/shared/threads/events.ts";
import {
  asksToCompact,
  type PendingMessage,
  type ToolRow,
  transcriptOf,
} from "@/shared/transcript.ts";

import { compact } from "./compaction.ts";
import {
  contextOf,
  type Guidance,
  type ToolOn,
  humanMessage,
  NO_GUIDANCE,
  notificationsMessage,
} from "./context.ts";
import { deferredByServer, TOOL_SEARCH } from "./tool-search.ts";
import type { ToolOutput, AnyToolSpec, Tools } from "./tools.ts";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type EndStatus = Extract<RunStatus, "completed" | "failed" | "cancelled">;

export interface Run {
  id: string;
  threadId: string;
  status: RunStatus;
  // The seq of the message that woke the agent.
  triggerSeq: number;
  // The model ref it replied with, once it started.
  model: string | null;
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
  error: string | null;
  errorKind: FailureKind | null;
  errorDetail: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface NewRun {
  threadId: string;
  triggerSeq: number;
  createdBy: string | null;
  continuesRunId?: string | null;
  reason?: RunReason | null;
  attempt?: number;
}

// The right to write for a run, held by one worker until it ends or expires.
export interface Lease {
  runId: string;
  owner: string;
  epoch: number;
}

// Thrown by a write whose lease no longer holds.
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`lease on run ${runId} lost`);
  }
}

export interface RunStore {
  create(run: NewRun): Run;
  find(id: string): Run | null;
  // The thread's newest run.
  latest(threadId: string): Run | null;
  // The thread's queued, running or waiting run.
  active(threadId: string): Run | null;
  // The threads with a queued, running or waiting run.
  activeThreadIds(): string[];
  // The queued, running and waiting runs of the space's threads, or of the threads named.
  activeInSpace(spaceId: string): Run[];
  activeIn(threadIds: string[]): Run[];
  // Asks the thread's active run to stop, unless someone already has; null when there is none. A
  // null user is the server itself, as when the agent may no longer run in the thread's space.
  requestCancel(threadId: string, userId: string | null, at: Date): Run | null;
  // Takes the oldest queued run for the owner until `expiresAt`.
  claim(owner: string, expiresAt: Date): Run | null;
  // Takes a running run whose lease expired before `before`, or any running run without `before`.
  takeOver(id: string, owner: string, expiresAt: Date, before?: Date): Run | null;
  // Running runs whose lease expired before `before`, or every running run without it.
  stale(before?: Date): Run[];
  // The run as it is now; throws LeaseLost unless the lease holds.
  hold(lease: Lease): Run;
  // Extends the lease; throws LeaseLost unless it holds.
  renew(lease: Lease, expiresAt: Date): Run;
  // Records the model the run replies with.
  setModel(lease: Lease, model: string): void;
  // Adds the tools, turned on by the call, to those the run's thread offers from now on.
  turnOn(lease: Lease, callId: string, toolIds: readonly string[]): void;
  // The tools turned on in the thread, in the order they were.
  toolsOn(threadId: string): ToolOn[];
  // Lets the lease go while the run waits for a person's decision; nothing holds it meanwhile.
  wait(lease: Lease): Run;
  // Queues a waiting run again, to be claimed like any other; false when it was not waiting.
  resume(runId: string): boolean;
  // Ends the run and lets its lease go.
  end(
    lease: Lease,
    outcome: {
      status: EndStatus;
      error?: string;
      errorKind?: FailureKind;
      errorDetail?: string;
      usage?: { inputTokens: number; outputTokens: number };
    },
  ): Run;
}

export interface RunWorkerOptions {
  runs: RunStore;
  threads: Pick<ThreadStore, "find" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can">;
  deltas: DeltaStore;
  log: ThreadLog;
  bus: EventBus;
  transact: Transact;
  models: Pick<Models, "open" | "replyModel">;
  tools: Pick<
    Tools,
    | "offered"
    | "riskOf"
    | "forModel"
    | "decide"
    | "approvalHolds"
    | "answerHolds"
    | "modelNames"
    | "fromServers"
    | "namesNow"
  >;
  // What the org and the space tell the agent beyond Mage's own prompt, given the tools offered,
  // and what the thread does about it.
  guidance?: (space: Space, offered: readonly AnyToolSpec[], thread: Thread) => Guidance;
  // The tools the thread's agent may call of those its space offers; all of them when not given.
  narrow?: (thread: Thread, offered: AnyToolSpec[]) => AnyToolSpec[];
  // What the thread's agent reads ahead of the thread itself; nothing when not given.
  before?: (thread: Thread) => ModelMessage[];
  // Hears of each run that ended, after its end is stored.
  ended?: (run: Run) => void;
  logger: Logger;
  // Whether the agent may run in the space; a run claimed where it may not is stopped unstarted.
  runsIn?: (space: Space) => boolean;
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

const CONNECTION_LABELS = { codex: "Codex" } as const;

type ConnectionKind = keyof typeof CONNECTION_LABELS;

function connectionOf(ref: string): ConnectionKind | undefined {
  const kind = ref.slice(0, ref.indexOf("/"));
  return Object.hasOwn(CONNECTION_LABELS, kind) ? (kind as ConnectionKind) : undefined;
}

const FAILURE_MESSAGES: Record<ModelErrorKind, (label: string) => string> = {
  auth: (label) => `The ${label} sign-in no longer works. Reconnect it in Model providers.`,
  limit: (label) => `${label} limit reached.`,
  model: (label) => `${label} cannot use this model. Pick another model.`,
  network: (label) => `Couldn't reach ${label}.`,
};

// What people are told about a failure while replying with the model `ref`.
function failureOf(err: unknown, ref: string | null): RunFailure {
  if (err instanceof RunFailure) return err;
  const connection = ref ? connectionOf(ref) : undefined;
  const label = connection ? CONNECTION_LABELS[connection] : "The provider";
  const kinded =
    err instanceof ModelError
      ? err
      : err instanceof ConnectionError
        ? new ModelError("auth", err.message)
        : null;
  if (!kinded) return new RunFailure(`The model failed: ${messageOf(err)}`);
  return new RunFailure({
    error: kinded.summary ?? FAILURE_MESSAGES[kinded.kind](label),
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

// The thread's waiting messages whose authors may still post in it, and those whose authors no
// longer may.
export function sortWaiting(
  threads: Pick<ThreadStore, "find">,
  spaceStore: Pick<SpaceStore, "find">,
  access: Pick<ThreadAccess, "can">,
  threadId: string,
  pending: PendingMessage[],
) {
  const thread = threads.find(threadId);
  const space = thread && spaceStore.find(thread.spaceId);
  const admitted: PendingMessage[] = [];
  const refused: PendingMessage[] = [];
  for (const message of pending) {
    const allowed =
      !!space && access.can({ userId: message.author.userId, orgId: space.orgId }, thread, "post");
    (allowed ? admitted : refused).push(message);
  }
  return { admitted, refused };
}

// Drops the waiting messages of the org's threads whose authors can no longer post in them.
function dropRefusedWaiting(options: {
  threads: Pick<ThreadStore, "find" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "activeThreadIds">;
  access: Pick<ThreadAccess, "can">;
  log: ThreadLog;
  orgId: string;
}) {
  const { threads, spaceStore, runs, access, log, orgId } = options;
  for (const threadId of new Set(runs.activeThreadIds())) {
    const thread = threads.find(threadId);
    if (!thread || spaceStore.find(thread.spaceId)?.orgId !== orgId) continue;
    log.write(threadId, (append) => {
      const pending = transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary)).pending;
      const { refused } = sortWaiting(threads, spaceStore, access, threadId, pending);
      for (const message of refused) {
        append({ type: "message.dropped", actor: AGENT, data: { messageId: message.id } });
      }
    });
  }
}

// Asks the active runs of the org's threads in spaces where the agent may no longer run to stop,
// queueing again those that wait for a decision so that a worker ends them.
function stopBarredRuns(options: {
  threads: Pick<ThreadStore, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "activeThreadIds" | "requestCancel" | "resume">;
  bus: Pick<EventBus, "wake">;
  runsIn: (space: Space) => boolean;
  orgId: string;
  now?: () => Date;
}) {
  const { threads, spaceStore, runs, bus, runsIn, orgId } = options;
  for (const threadId of new Set(runs.activeThreadIds())) {
    const thread = threads.find(threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!space || space.orgId !== orgId || runsIn(space)) continue;
    const run = runs.requestCancel(threadId, null, options.now?.() ?? new Date());
    if (run?.status === "waiting") runs.resume(run.id);
    bus.wake(threadId);
  }
}

// Starts a run in a transaction that is appending to the thread, taking in the given messages.
export function startRun(
  runs: Pick<RunStore, "create">,
  append: Append,
  input: NewRun,
  admit: string[] = [],
) {
  const run = runs.create(input);
  append({
    type: "run.created",
    actor: input.createdBy ? { kind: "user", userId: input.createdBy } : AGENT,
    data: {
      runId: run.id,
      reason: input.reason ?? null,
      continuesRunId: input.continuesRunId ?? null,
    },
  });
  if (admit.length > 0) {
    append({ type: "message.admitted", actor: AGENT, data: { runId: run.id, messageIds: admit } });
  }
  return run;
}

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : "The model did not answer.";
}

export function createRunWorker(options: RunWorkerOptions) {
  const { runs, threads, spaceStore, access, deltas, log, bus, transact, models, tools, logger } =
    options;
  const now = options.now ?? (() => new Date());
  const guidance = options.guidance ?? (() => NO_GUIDANCE);
  const runsIn = options.runsIn ?? (() => true);
  const narrow = options.narrow ?? ((_thread: Thread, offered: AnyToolSpec[]) => offered);
  const before = options.before ?? (() => []);
  const ended = options.ended ?? (() => {});
  // When people may have lost a role in an org's spaces, their waiting messages there are dropped,
  // and the agent stops in spaces archived or put in trash.
  function accessChanged(orgId: string) {
    dropRefusedWaiting({ threads, spaceStore, runs, access, log, orgId });
    stopBarredRuns({ threads, spaceStore, runs, bus, runsIn, orgId, now });
  }
  options.hooks?.on("org.personalSpacesChanged", ({ orgId, allowed }) => {
    if (!allowed) accessChanged(orgId);
  });
  options.hooks?.on("org.membersSettled", ({ orgId }) => accessChanged(orgId));
  options.hooks?.on("space.accessChanged", ({ orgId }) => accessChanged(orgId));
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 5_000;
  const flushMs = options.flushMs ?? 75;
  const maxSteps = options.maxSteps ?? 20;
  const maxAttempts = options.maxAttempts ?? 3;
  const owner = ulid();
  const executions = new Map<string, Execution>();
  let stopped = true;
  let ticking = false;
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  function expiry() {
    return new Date(now().getTime() + leaseMs);
  }

  function transcript(threadId: string) {
    return transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary));
  }

  // Appends the run's events only while its lease holds.
  function write<T>(lease: Lease, threadId: string, work: (append: Append) => T) {
    return log.write(threadId, (append) => {
      runs.hold(lease);
      return work(append);
    }).result;
  }

  // Pending messages whose authors may still post in the thread, as members of its space or as
  // its guests; the others are dropped.
  function admissible(threadId: string, pending: PendingMessage[], append: Append) {
    const { admitted, refused } = sortWaiting(threads, spaceStore, access, threadId, pending);
    for (const message of refused) {
      append({ type: "message.dropped", actor: AGENT, data: { messageId: message.id } });
    }
    return admitted;
  }

  // Ends the run, then starts the next one: the same input again when it is to be retried, or the
  // messages that waited for it to end.
  function end(
    lease: Lease,
    run: Run,
    append: Append,
    outcome: { status: EndStatus; failure?: Failure; usage?: ModelUsage },
    retry = false,
  ) {
    const { status, failure, usage } = outcome;
    // Its calls still open will not run.
    for (const row of transcript(run.threadId).rows) {
      if (row.kind !== "tool" || row.runId !== run.id || !open(row)) continue;
      append({
        type: "tool.denied",
        actor: AGENT,
        data: { runId: run.id, callId: row.id, reason: "stopped" },
      });
    }
    const ended = runs.end(lease, {
      status,
      usage,
      ...(failure && {
        error: failure.error,
        errorKind: failure.kind,
        errorDetail: failure.detail,
      }),
    });
    if (status === "failed") {
      append({
        type: "run.failed",
        actor: AGENT,
        data: { runId: run.id, ...(failure ?? { error: "The agent could not reply." }) },
      });
    } else if (status === "cancelled") {
      const by = ended.cancelRequestedBy;
      append({
        type: "run.cancelled",
        actor: by ? { kind: "user", userId: by } : AGENT,
        data: { runId: run.id },
      });
    } else {
      append({ type: "run.completed", actor: AGENT, data: { runId: run.id } });
    }
    const { pending, inbox } = transcript(run.threadId);
    const waiting = admissible(run.threadId, pending, append);
    // An interrupting message starts the next run, with everything queued; else another agent's.
    const first = waiting.find((message) => message.mode === "interrupt") ?? waiting[0];
    const relayed = inbox[0];
    const next: NewRun | null = retry
      ? {
          threadId: run.threadId,
          triggerSeq: run.triggerSeq,
          createdBy: null,
          continuesRunId: run.id,
          reason: "retry",
          attempt: run.attempt + 1,
        }
      : first
        ? {
            threadId: run.threadId,
            triggerSeq: first.seq,
            createdBy: first.author.userId,
            continuesRunId: run.id,
            reason: first.mode === "interrupt" ? "interrupt" : "queued_input",
          }
        : relayed
          ? {
              threadId: run.threadId,
              triggerSeq: relayed.seq,
              createdBy: null,
              continuesRunId: run.id,
              reason: "queued_input",
            }
          : null;
    // A message asking to compact the thread is taken in by the run that does it, at once.
    const admit = !retry && first && asksToCompact(first) ? [first.id] : [];
    if (next) startRun(runs, append, next, admit);
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
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function flush() {
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
        const current = transact(() => {
          const held = runs.hold(lease);
          deltas.append(run.threadId, batch);
          return held;
        });
        bus.publish(run.threadId, { kind: "delta", delta: batch });
        stopIfAsked(execution, current);
      } catch (err) {
        if (!(err instanceof LeaseLost)) logger.error({ err, runId: run.id }, "reply pieces lost");
        controller.abort({ kind: "lease" } satisfies Abort);
      }
    }

    // Appends the open reply's completion, if any, and drops its pieces, inside a write.
    function close(append: Append, status: ReplyStatus, usage?: ModelUsage) {
      clearTimeout(timer);
      timer = undefined;
      if (!open) return;
      const { id, text, reasoning, reasoningFrom } = open;
      const durationMs = open.reasoningMs ?? (reasoningFrom && now().getTime() - reasoningFrom);
      open = null;
      deltas.remove(id);
      append({
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

    function start() {
      const id = ulid();
      write(lease, run.threadId, (append) => {
        close(append, "completed");
        append({
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
      };
      return id;
    }

    return {
      start,
      add(text: string, part: Part = "text") {
        if (!open) start();
        const reply = open!;
        // A batch holds pieces of one part.
        if (reply.part !== part) flush();
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
      complete(usage: ModelUsage) {
        write(lease, run.threadId, (append) => close(append, "completed", usage));
      },
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
  function boundary(execution: Execution, all: boolean): ModelMessage[] {
    const { run, lease, controller } = execution;
    const admitted = write(lease, run.threadId, (append) => {
      const current = runs.hold(lease);
      stopIfAsked(execution, current);
      if (controller.signal.aborted) return [];
      const { pending, inbox } = transcript(run.threadId);
      const people = admissible(run.threadId, pending, append).filter(
        (message) => !asksToCompact(message) && (all || message.mode === "steer"),
      );
      const ids = [...people, ...inbox].map((message) => message.id);
      if (ids.length > 0) {
        append({
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

  // The tools the thread's agent may call now.
  function offeredIn(space: Space, thread: Thread) {
    return narrow(thread, tools.offered(space));
  }

  // The model the thread replies with now, opened.
  async function replying(execution: Execution, space: Space, thread: Thread): Promise<Replying> {
    // A model turned off, or gone with its provider, gives way to the space's default, then the
    // org's, each with its own effort; opening the one named fails the run saying why when none
    // can reply.
    const own = { model: thread.model, effort: thread.effort };
    const picked = await models.replyModel(space, own);
    if (!picked) throw new RunFailure("Pick a model for this thread.");
    const ref = picked.used?.ref ?? picked.chosen.ref;
    execution.ref = ref;
    execution.effort = picked.effort;
    const model = await models.open(space.orgId, ref);
    runs.setModel(execution.lease, ref);
    return { model, effort: picked.effort, own };
  }

  // The MCP tools the thread leaves out of the model's requests until it turns them on: all it
  // could offer, those turned on, in the order they were, and those still left out.
  function deferralOf(execution: Execution, space: Space) {
    const all = tools.fromServers(space, tools.modelNames(space));
    const ids = new Set(all.map((tool) => tool.id));
    const turnedOn = runs.toolsOn(execution.run.threadId).filter((tool) => ids.has(tool.id));
    const on = new Set(turnedOn.map((tool) => tool.id));
    return { all, on, turnedOn, left: all.filter((tool) => !on.has(tool.id)) };
  }

  // A tool as the model knows it, which is how errors it reads name tools.
  function modelName(space: Space, toolId: string) {
    return wireToolName(tools.modelNames(space).toModel(toolId));
  }

  // Records the calls a model step asked for, each with whether it waits for a decision. A call of
  // a tool not offered, or left out of the request and not turned on, or with input the tool does
  // not take, fails at once.
  function request(
    execution: Execution,
    space: Space,
    calls: (ModelToolCall & { messageId: string })[],
  ) {
    const { run, lease } = execution;
    write(lease, run.threadId, (append) => {
      const thread = threads.find(run.threadId);
      if (!thread) throw new LeaseLost(run.id);
      const { rows } = transcript(run.threadId);
      const offered = offeredIn(space, thread);
      const { left } = deferralOf(execution, space);
      const named = tools.namesNow(space);
      for (const call of calls) {
        const { callId, toolId, input, messageId } = call;
        const unsearched = left.find((tool) => tool.id === toolId);
        const spec = unsearched
          ? undefined
          : offered.find((candidate) => candidate.name === toolId);
        const parsed = spec?.input.safeParse(input);
        const ok = !!spec && !!parsed?.success;
        const risk = ok ? tools.riskOf(space, spec, parsed.data, execution.ref) : "normal";
        // A call that asks always waits for its answer.
        const waits =
          ok &&
          (spec.waitsFor === "answer" ||
            tools.decide(
              rows,
              thread,
              space,
              toolId,
              spec.risk(parsed.data, { model: execution.ref }),
              parsed.data,
            ).kind === "wait");
        const names = named(toolId);
        append({
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
        append({
          type: "tool.ran",
          actor: AGENT,
          data: {
            runId: run.id,
            callId,
            ok: false,
            error: unsearched
              ? `${modelName(space, unsearched.name)} is not on yet. Search for it or select it with ${modelName(space, TOOL_SEARCH)} first.`
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
  function nextCall(execution: Execution, space: Space) {
    const { run, lease, controller } = execution;
    const next = write(lease, run.threadId, (append) => {
      stopIfAsked(execution, runs.hold(lease));
      if (controller.signal.aborted) return null;
      const thread = threads.find(run.threadId);
      if (!thread) throw new LeaseLost(run.id);
      const { rows } = transcript(run.threadId);
      const calls = rows.filter(
        (row): row is ToolRow => row.kind === "tool" && row.runId === run.id && open(row),
      );
      const offered = offeredIn(space, thread);
      let waiting = false;
      for (const call of calls) {
        const spec = offered.find((candidate) => candidate.name === call.toolId);
        const parsed = spec?.input.safeParse(call.input);
        let allowed = false;
        // Whose own login it goes with, for a tool that uses one, and the standing approval it
        // runs on, if any.
        let runAs: string | null = null;
        let standingOn: string | undefined;
        if (spec && parsed?.success && spec.waitsFor === "answer") {
          // A call that asks runs once answered, while the answer holds.
          if (call.state === "pending") {
            waiting = true;
            continue;
          }
          allowed = tools.answerHolds(call, rows, thread, space);
        } else if (spec && parsed?.success) {
          const risk = tools.riskOf(space, spec, parsed.data, execution.ref);
          if (call.state === "allowed") {
            allowed = tools.approvalHolds(call, rows, thread, space, risk);
            // An approved call runs with its approver's own login.
            if (spec.connection?.(parsed.data, space)) runAs = call.decision?.by.userId ?? null;
          } else {
            const declared = spec.risk(parsed.data, { model: execution.ref });
            const decision = tools.decide(rows, thread, space, call.toolId, declared, parsed.data);
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
          return { call, spec: spec!, input: parsed!.data as unknown, runAs, standingOn };
        }
        append({
          type: "tool.denied",
          actor: AGENT,
          data: { runId: run.id, callId: call.id, reason: "stale" },
        });
      }
      if (waiting) runs.wait(lease);
      return waiting ? ("wait" as const) : null;
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (next === "wait") throw new Waiting();
    return next;
  }

  // Runs the run's open calls that may run, one at a time in order, until none is left; throws
  // Waiting when some wait for a decision.
  async function settle(execution: Execution, space: Space) {
    const { run, lease } = execution;
    for (let next = nextCall(execution, space); next; next = nextCall(execution, space)) {
      const { call, spec, input, runAs, standingOn } = next;
      const started = now().getTime();
      // The search for left-out tools is given them, and turns them on for the rest of the thread.
      const deferral = spec.name === TOOL_SEARCH ? deferralOf(execution, space) : null;
      let output: ToolOutput;
      try {
        output = await (spec as AnyToolSpec).run(input, {
          threadId: run.threadId,
          spaceId: space.id,
          orgId: space.orgId,
          runId: run.id,
          callId: call.id,
          actor: AGENT,
          model: execution.ref,
          runAs,
          signal: execution.controller.signal,
          ...(call.answers && { answers: call.answers }),
          ...(deferral && {
            deferred: {
              tools: deferral.all,
              on: deferral.on,
              turnOn: (ids: string[]) =>
                write(lease, run.threadId, () => runs.turnOn(lease, call.id, ids)),
            },
          }),
          write: (work) => write(lease, run.threadId, (append) => work(append)),
        });
      } catch (err) {
        if (err instanceof LeaseLost) throw err;
        logger.warn({ err, runId: run.id, toolId: call.toolId }, "tool failed");
        output = { ok: false, error: messageOf(err) };
      }
      const ms = Math.max(0, now().getTime() - started);
      write(lease, run.threadId, (append) =>
        append({
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
        }),
      );
    }
  }

  // The message that woke the run when it asks to compact the thread, and so the run is one that
  // compacts it; null otherwise.
  function compactionAsked(run: Run) {
    const [trigger] = threads.eventsAfter(run.threadId, run.triggerSeq - 1);
    if (trigger?.seq !== run.triggerSeq || trigger.type !== "message") return null;
    if (trigger.actor.kind !== "user" || !trigger.data.command) return null;
    return asksToCompact(trigger.data)
      ? { id: trigger.id, by: trigger.actor, focus: trigger.data.command.args }
      : null;
  }

  // Compacts the thread with its model for whoever asked, taking in their message if it still
  // waits. With nothing to summarise, it leaves the thread as it is.
  async function compactFor(
    execution: Execution,
    model: Replying,
    asked: NonNullable<ReturnType<typeof compactionAsked>>,
  ) {
    const { run, lease, controller } = execution;
    write(lease, run.threadId, (append) => {
      stopIfAsked(execution, runs.hold(lease));
      if (controller.signal.aborted) return;
      if (!transcript(run.threadId).pending.some((message) => message.id === asked.id)) return;
      append({
        type: "message.admitted",
        actor: AGENT,
        data: { runId: run.id, messageIds: [asked.id] },
      });
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    await compact({
      threadId: run.threadId,
      rows: transcript(run.threadId).rows,
      model: model.model,
      ...(asked.focus && { focus: asked.focus }),
      actor: asked.by,
      write: (work) => write(lease, run.threadId, work),
      signal: controller.signal,
    });
  }

  // Adds each step's token use to `usage`.
  async function drive(execution: Execution, reply: ReturnType<typeof replies>, usage: ModelUsage) {
    const { run, controller } = execution;
    const thread = threads.find(run.threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) throw new LeaseLost(run.id);
    if (!runsIn(space)) {
      controller.abort({ kind: "cancel" } satisfies Abort);
      throw controller.signal.reason;
    }
    let model = await replying(execution, space, thread);
    const asked = compactionAsked(run);
    if (asked) {
      await compactFor(execution, model, asked);
      return;
    }
    // A run queued again after a decision takes in only the messages sent to steer it.
    const resumed = transcript(thread.id).rows.some(
      (row) => row.kind === "tool" && row.runId === run.id,
    );

    let steps = 0;
    // What the calls gave back goes to the model before the run ends.
    let answer = resumed;
    // Each model call is followed by another while steering messages keep arriving, or while
    // tool calls have results to give back.
    for (let call = 0; steps < maxSteps; call += 1) {
      const admitted = boundary(execution, call === 0 && !resumed);
      await settle(execution, space);
      if (call > 0 && admitted.length === 0 && !answer) break;
      answer = false;
      // A tool that changed the thread's model or effort changes what replies from here.
      const current = threads.find(thread.id) ?? thread;
      if (current.model !== model.own.model || current.effort !== model.own.effort) {
        model = await replying(execution, space, current);
      }
      // MCP tools stay out of the request until the model turns them on with the tool search,
      // which is offered whenever the thread has any; the prompt lists them all, on or not.
      const offered = offeredIn(space, current);
      const deferral = deferralOf(execution, space);
      const searchable = new Set(deferral.all.map((tool) => tool.id));
      const available = offered.filter(
        (spec) => spec.name !== TOOL_SEARCH || deferral.all.length > 0,
      );
      // The model knows tools by their model names; calls, results and the prompt name them so.
      const names = tools.modelNames(space);
      const { instructions, messages, firstEffort } = contextOf(
        transcript(thread.id).rows,
        {
          ...guidance(space, available, current),
          toolName: names.toModel,
          ...(deferral.all.length && { deferredTools: deferredByServer(deferral.all) }),
        },
        before(current),
        deferral.turnedOn,
        model.effort,
      );
      const forModel = (specs: AnyToolSpec[]) =>
        tools.forModel(specs).map((tool) => ({ ...tool, id: names.toModel(tool.id) }));
      const calls: (ModelToolCall & { messageId: string })[] = [];
      let messageId = "";
      const stream = model.model.stream(
        {
          instructions,
          messages: messages.map((message) => namedFor(message, names.toModel)),
          maxSteps: maxSteps - steps,
          sessionId: thread.id,
          ...(model.effort && { effort: model.effort }),
          ...(firstEffort && { firstEffort }),
          beforeStep: () => boundary(execution, false),
          tools: forModel(available.filter((spec) => !searchable.has(spec.name))),
          searchable: forModel(available.filter((spec) => searchable.has(spec.name))),
          toolsOn: deferral.turnedOn.map((tool) => names.toModel(tool.id)),
        },
        controller.signal,
      );
      for await (const event of stream) {
        switch (event.type) {
          case "step-start":
            steps += 1;
            messageId = reply.start();
            break;
          case "delta":
            reply.add(event.text);
            break;
          case "reasoning":
            reply.add(event.text, "reasoning");
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
            usage.inputTokens += event.usage.inputTokens;
            usage.outputTokens += event.usage.outputTokens;
            reply.complete(event.usage);
            break;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (calls.length > 0) {
        request(execution, space, calls);
        await settle(execution, space);
        answer = true;
      }
    }
  }

  async function execute(execution: Execution) {
    const { run, lease, controller } = execution;
    const reply = replies(execution);
    const renewal = setInterval(() => {
      try {
        stopIfAsked(execution, runs.renew(lease, expiry()));
      } catch (err) {
        if (!(err instanceof LeaseLost))
          logger.error({ err, runId: run.id }, "lease renewal failed");
        controller.abort({ kind: "lease" } satisfies Abort);
      }
    }, leaseMs / 3);
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      await drive(execution, reply, usage);
      write(lease, run.threadId, (append) => {
        reply.close(append, "completed");
        end(lease, run, append, { status: "completed", usage });
      });
      tellEnded(run);
    } catch (err) {
      if (err instanceof Waiting) {
        logger.info({ runId: run.id }, "run waits for a decision");
        return;
      }
      const abort = controller.signal.aborted ? (controller.signal.reason as Abort) : null;
      if (abort?.kind === "cancel") {
        try {
          write(lease, run.threadId, (append) => {
            reply.close(append, "interrupted");
            end(lease, run, append, { status: "cancelled", usage });
          });
          tellEnded(run);
        } catch (writeErr) {
          if (!(writeErr instanceof LeaseLost))
            logger.error({ err: writeErr }, "run end not saved");
        }
        return;
      }
      if (err instanceof LeaseLost || abort) {
        logger.info({ runId: run.id, reason: abort?.kind ?? "lease" }, "run left to recovery");
        return;
      }
      if (!(err instanceof RunFailure)) logger.warn({ err, runId: run.id }, "run failed");
      const { failure } = failureOf(err, execution.ref);
      try {
        write(lease, run.threadId, (append) => {
          reply.close(append, "failed");
          end(lease, run, append, { status: "failed", failure, usage });
        });
        tellEnded(run);
      } catch (writeErr) {
        if (!(writeErr instanceof LeaseLost)) logger.error({ err: writeErr }, "run end not saved");
      }
    } finally {
      clearInterval(renewal);
      executions.delete(run.id);
      tick();
    }
  }

  // Fails running runs nobody holds any more: those whose lease expired before `before`, or all of
  // them at boot. Each is tried again until its input has failed too many times.
  function recover(before?: Date) {
    for (const stale of runs.stale(before)) {
      const run = runs.takeOver(stale.id, owner, expiry(), before);
      if (!run) continue;
      const lease = { runId: run.id, owner, epoch: run.leaseEpoch };
      const retry = run.attempt < maxAttempts;
      const failure = {
        error: retry
          ? "The server stopped while the agent was replying."
          : `The agent stopped ${run.attempt} times on this input and gave up.`,
      };
      try {
        write(lease, run.threadId, (append) => {
          for (const row of transcript(run.threadId).rows) {
            if (row.kind !== "agent" || row.runId !== run.id || row.status !== "streaming") {
              continue;
            }
            const { text, reasoning } = deltas.partsOf(row.id);
            deltas.remove(row.id);
            append({
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
          end(lease, run, append, { status: "failed", failure }, retry);
        });
        tellEnded(run);
        if (!retry) logger.warn({ runId: run.id, attempt: run.attempt }, "run input given up on");
      } catch (err) {
        logger.error({ err, runId: run.id }, "run recovery failed");
      }
    }
  }

  // Tells whoever needs to of the run that ended; what they do with it is theirs to get right.
  function tellEnded(run: Run) {
    try {
      ended(runs.find(run.id) ?? run);
    } catch (err) {
      logger.error({ err, runId: run.id }, "run end not told");
    }
  }

  function begin(run: Run) {
    const execution: Execution = {
      run,
      lease: { runId: run.id, owner, epoch: run.leaseEpoch },
      ref: null,
      effort: null,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    executions.set(run.id, execution);
    // Claimed: the run's thread now shows the agent replying.
    bus.activity({ threadId: run.threadId });
    execution.done = execute(execution);
  }

  function tick() {
    if (stopped) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        recover(now());
        for (let run = runs.claim(owner, expiry()); run; run = runs.claim(owner, expiry())) {
          begin(run);
        }
      } while (again && !stopped);
    } catch (err) {
      logger.error({ err }, "run worker tick failed");
    } finally {
      ticking = false;
    }
  }

  return {
    // Fails the runs a stopped server left running. Call before serving and starting.
    recover() {
      recover();
    },

    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = bus.onWake((threadId) => {
        for (const execution of executions.values()) {
          if (execution.run.threadId !== threadId) continue;
          try {
            stopIfAsked(execution, runs.hold(execution.lease));
          } catch (err) {
            if (!(err instanceof LeaseLost)) logger.error({ err }, "stop check failed");
          }
        }
        tick();
      });
      timer = setInterval(tick, pollMs);
      tick();
    },

    // Stops claiming and leaves the runs in progress to the next boot's recovery.
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe?.();
      for (const execution of executions.values()) {
        execution.controller.abort({ kind: "shutdown" } satisfies Abort);
      }
      await Promise.allSettled([...executions.values()].map((execution) => execution.done));
    },

    // Resolves once no run is in progress and none is waiting to be claimed.
    async idle() {
      for (;;) {
        tick();
        if (executions.size === 0) return;
        await Promise.allSettled([...executions.values()].map((execution) => execution.done));
      }
    },
  };
}

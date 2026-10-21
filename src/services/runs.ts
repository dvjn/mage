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
// when it resets.

import { ulid } from "ulid";

import type { DeltaStore } from "@/ports/deltas.ts";
import type { EventBus } from "@/ports/event-bus.ts";
import type { Logger } from "@/ports/logger.ts";
import {
  ModelError,
  type ModelErrorKind,
  type ModelMessage,
  type ModelUsage,
} from "@/ports/model-gateway.ts";
import {
  type EndStatus,
  type Lease,
  LeaseLost,
  type NewRun,
  type Run,
  type RunStore,
} from "@/ports/runs.ts";
import type { SpaceStore } from "@/ports/spaces.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import type { Transact } from "@/ports/transaction.ts";
import { ConnectionError } from "@/services/connections.ts";
import { contextOf, humanMessage } from "@/services/context.ts";
import type { Models } from "@/services/models.ts";
import type { ThreadAccess } from "@/services/thread-access.ts";
import { type Append, eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import type { EventDataMap, ReplyPart, ReplyStatus } from "@/shared/threads.ts";
import { type PendingMessage, transcriptOf } from "@/shared/transcript.ts";

export interface RunWorkerOptions {
  runs: RunStore;
  threads: Pick<ThreadStore, "find" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can">;
  deltas: DeltaStore;
  log: ThreadLog;
  bus: EventBus;
  transact: Transact;
  models: Pick<Models, "defaultModel" | "open">;
  logger: Logger;
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

const CONNECTION_LABELS = { codex: "Codex", claude: "Claude" } as const;

type ConnectionKind = keyof typeof CONNECTION_LABELS;

function connectionOf(ref: string): ConnectionKind | undefined {
  const kind = ref.slice(0, ref.indexOf("/"));
  return Object.hasOwn(CONNECTION_LABELS, kind) ? (kind as ConnectionKind) : undefined;
}

const FAILURE_MESSAGES: Record<ModelErrorKind, (label: string) => string> = {
  auth: (label) => `The ${label} sign-in no longer works. Reconnect ${label} in Settings.`,
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
    error: FAILURE_MESSAGES[kinded.kind](label),
    kind: kinded.kind,
    ...(connection && { connection }),
    detail: kinded.detail,
    ...(kinded.resetsAt && { resetsAt: kinded.resetsAt.toISOString() }),
  });
}

// Why a run was aborted from outside its stream.
type Abort = { kind: "lease" } | { kind: "shutdown" } | { kind: "cancel" };

interface Execution {
  run: Run;
  lease: Lease;
  // The model ref the run replies with, once chosen.
  ref: string | null;
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
  const { runs, threads, spaceStore, access, deltas, log, bus, transact, models, logger } = options;
  const now = options.now ?? (() => new Date());
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
  // its guests.
  function admissible(threadId: string, pending: PendingMessage[]) {
    const thread = threads.find(threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!space) return [];
    return pending.filter((message) =>
      access.can({ userId: message.author.userId, orgId: space.orgId }, thread, "post"),
    );
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
    const waiting = admissible(run.threadId, transcript(run.threadId).pending);
    // An interrupting message starts the next run, with everything queued.
    const first = waiting.find((message) => message.mode === "interrupt") ?? waiting[0];
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
        : null;
    if (next) startRun(runs, append, next);
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
          data: { messageId: id, runId: run.id, ...(execution.ref && { model: execution.ref }) },
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
  // (all of them before the first model call, afterwards only those sent to steer) and returns
  // them.
  function boundary(execution: Execution, all: boolean): ModelMessage[] {
    const { run, lease, controller } = execution;
    const admitted = write(lease, run.threadId, (append) => {
      const current = runs.hold(lease);
      stopIfAsked(execution, current);
      if (controller.signal.aborted) return [];
      const waiting = admissible(run.threadId, transcript(run.threadId).pending).filter(
        (message) => all || message.mode === "steer",
      );
      if (waiting.length > 0) {
        append({
          type: "message.admitted",
          actor: AGENT,
          data: { runId: run.id, messageIds: waiting.map((message) => message.id) },
        });
      }
      return waiting;
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return admitted.map(humanMessage);
  }

  // Adds each step's token use to `usage`.
  async function drive(execution: Execution, reply: ReturnType<typeof replies>, usage: ModelUsage) {
    const { run, lease, controller } = execution;
    const thread = threads.find(run.threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) throw new LeaseLost(run.id);
    const ref = thread.model ?? models.defaultModel(space.orgId);
    if (!ref) throw new RunFailure("Pick a model for this thread.");
    execution.ref = ref;
    const model = await models.open(space.orgId, ref);
    runs.setModel(lease, ref);

    let steps = 0;
    // Each model call is followed by another while steering messages keep arriving.
    for (let call = 0; steps < maxSteps; call += 1) {
      const admitted = boundary(execution, call === 0);
      if (call > 0 && admitted.length === 0) break;
      const { instructions, messages } = contextOf(transcript(thread.id).rows);
      const stream = model.stream(
        {
          instructions,
          messages,
          maxSteps: maxSteps - steps,
          sessionId: thread.id,
          ...(thread.effort && { effort: thread.effort }),
          beforeStep: () => boundary(execution, false),
        },
        controller.signal,
      );
      for await (const event of stream) {
        if (event.type === "step-start") {
          steps += 1;
          reply.start();
        } else if (event.type === "delta") {
          reply.add(event.text);
        } else if (event.type === "reasoning") {
          reply.add(event.text, "reasoning");
        } else {
          usage.inputTokens += event.usage.inputTokens;
          usage.outputTokens += event.usage.outputTokens;
          reply.complete(event.usage);
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
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
    } catch (err) {
      const abort = controller.signal.aborted ? (controller.signal.reason as Abort) : null;
      if (abort?.kind === "cancel") {
        try {
          write(lease, run.threadId, (append) => {
            reply.close(append, "interrupted");
            end(lease, run, append, { status: "cancelled", usage });
          });
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
        if (!retry) logger.warn({ runId: run.id, attempt: run.attempt }, "run input given up on");
      } catch (err) {
        logger.error({ err, runId: run.id }, "run recovery failed");
      }
    }
  }

  function begin(run: Run) {
    const execution: Execution = {
      run,
      lease: { runId: run.id, owner, epoch: run.leaseEpoch },
      ref: null,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    executions.set(run.id, execution);
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

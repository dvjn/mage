// The agent worker: an in-process loop, woken by the event bus and by a slow poll, that claims
// queued runs and drives each one. A run takes in the messages waiting for it, then streams the
// model's reply, one reserved slot per model step. Every write a run makes checks its lease in the
// same transaction, and a renewal keeps the lease while the run works. Runs left running by a
// stopped server are failed with their partial reply kept and tried again, until the same input has
// failed too many times.

import { ulid } from "ulid";

import type { EventBus } from "@/ports/event-bus.ts";
import type { Logger } from "@/ports/logger.ts";
import type { ModelUsage } from "@/ports/model-gateway.ts";
import {
  type EndStatus,
  type Lease,
  LeaseLost,
  type NewRun,
  type Run,
  type RunStore,
} from "@/ports/runs.ts";
import type { SpaceStore } from "@/ports/spaces.ts";
import type { NewEvent, ThreadStore } from "@/ports/threads.ts";
import { contextOf } from "@/services/context.ts";
import type { Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import { type Append, eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import type { ReplyStatus } from "@/shared/threads.ts";
import { type PendingMessage, transcriptOf } from "@/shared/transcript.ts";

export interface RunWorkerOptions {
  runs: RunStore;
  threads: Pick<ThreadStore, "find" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  spaces: Pick<Spaces, "can">;
  log: ThreadLog;
  bus: EventBus;
  models: Pick<Models, "defaultModel" | "open">;
  logger: Logger;
  now?: () => Date;
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

// A failure whose message people see.
export class RunFailure extends Error {}

// Why a run was aborted from outside its stream.
type Abort = { kind: "lease" } | { kind: "shutdown" };

interface Execution {
  run: Run;
  lease: Lease;
  controller: AbortController;
  done: Promise<void>;
}

const AGENT = { kind: "agent" } as const;

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
  const { runs, threads, spaceStore, spaces, log, bus, models, logger } = options;
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 5_000;
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

  // Pending messages whose authors may still message in the thread's space.
  function admissible(threadId: string, pending: PendingMessage[]) {
    const space = spaceStore.find(threads.find(threadId)?.spaceId ?? "");
    if (!space) return [];
    return pending.filter((message) =>
      spaces.can({ userId: message.author.userId, orgId: space.orgId }, space, "message"),
    );
  }

  // Ends the run, then starts the next one: the same input again when it is to be retried, or the
  // messages that waited for it to end.
  function end(
    lease: Lease,
    run: Run,
    append: Append,
    outcome: { status: EndStatus; error?: string; usage?: ModelUsage },
    retry = false,
  ) {
    runs.end(lease, outcome);
    if (outcome.status === "failed") {
      append({
        type: "run.failed",
        actor: AGENT,
        data: { runId: run.id, error: outcome.error ?? "The agent could not reply." },
      });
    } else {
      append({ type: "run.completed", actor: AGENT, data: { runId: run.id } });
    }
    const waiting = admissible(run.threadId, transcript(run.threadId).pending);
    const next: NewRun | null = retry
      ? {
          threadId: run.threadId,
          triggerSeq: run.triggerSeq,
          createdBy: null,
          continuesRunId: run.id,
          reason: "retry",
          attempt: run.attempt + 1,
        }
      : waiting[0]
        ? {
            threadId: run.threadId,
            triggerSeq: waiting[0].seq,
            createdBy: waiting[0].author.userId,
            continuesRunId: run.id,
            reason: "queued_input",
          }
        : null;
    if (next) startRun(runs, append, next);
    return next !== null;
  }

  // The reply slots of one run: each model step reserves one when it starts and completes it when
  // it ends.
  function replies(execution: Execution) {
    const { run, lease } = execution;
    let open: { id: string; text: string } | null = null;

    // The event completing the open reply, if any, closing it.
    function completion(status: ReplyStatus): NewEvent | null {
      if (!open) return null;
      const { id, text } = open;
      open = null;
      return {
        type: "message.completed",
        actor: AGENT,
        data: {
          messageId: id,
          runId: run.id,
          parts: text ? [{ type: "text", text }] : [],
          status,
        },
      };
    }

    function start() {
      const done = completion("completed");
      const id = ulid();
      write(lease, run.threadId, (append) => {
        if (done) append(done);
        append({ type: "message.started", actor: AGENT, data: { messageId: id, runId: run.id } });
      });
      open = { id, text: "" };
    }

    return {
      start,
      add(text: string) {
        if (!open) start();
        open!.text += text;
      },
      complete() {
        const done = completion("completed");
        if (done) write(lease, run.threadId, (append) => append(done));
      },
      // Closes the open reply, if any, inside a write.
      close(append: Append, status: ReplyStatus) {
        const done = completion(status);
        if (done) append(done);
      },
    };
  }

  // Takes in the messages waiting for the run.
  function admit(execution: Execution) {
    const { run, lease } = execution;
    return write(lease, run.threadId, (append) => {
      const ids = admissible(run.threadId, transcript(run.threadId).pending).map((m) => m.id);
      if (ids.length > 0) {
        append({
          type: "message.admitted",
          actor: AGENT,
          data: { runId: run.id, messageIds: ids },
        });
      }
      return ids.length;
    });
  }

  async function drive(execution: Execution, reply: ReturnType<typeof replies>) {
    const { run, lease, controller } = execution;
    const thread = threads.find(run.threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) throw new LeaseLost(run.id);
    const ref = thread.model ?? models.defaultModel(space.orgId);
    if (!ref) throw new RunFailure("Pick a model for this thread.");
    const model = await models.open(space.orgId, ref).catch((err: unknown) => {
      throw new RunFailure(messageOf(err));
    });
    runs.setModel(lease, ref);

    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    admit(execution);
    const { instructions, messages } = contextOf(transcript(thread.id).rows);
    const stream = model.stream(
      { instructions, messages, maxSteps, sessionId: thread.id },
      controller.signal,
    );
    for await (const event of stream) {
      if (event.type === "step-start") reply.start();
      else if (event.type === "delta") reply.add(event.text);
      else {
        usage.inputTokens += event.usage.inputTokens;
        usage.outputTokens += event.usage.outputTokens;
        reply.complete();
      }
    }
    return usage;
  }

  async function execute(execution: Execution) {
    const { run, lease, controller } = execution;
    const reply = replies(execution);
    const renewal = setInterval(() => {
      try {
        runs.renew(lease, expiry());
      } catch (err) {
        if (!(err instanceof LeaseLost))
          logger.error({ err, runId: run.id }, "lease renewal failed");
        controller.abort({ kind: "lease" } satisfies Abort);
      }
    }, leaseMs / 3);
    let usage: ModelUsage | undefined;
    try {
      usage = await drive(execution, reply);
      write(lease, run.threadId, (append) => {
        reply.close(append, "completed");
        end(lease, run, append, { status: "completed", usage });
      });
    } catch (err) {
      const abort = controller.signal.aborted ? (controller.signal.reason as Abort) : null;
      if (err instanceof LeaseLost || abort) {
        logger.info({ runId: run.id, reason: abort?.kind ?? "lease" }, "run left to recovery");
        return;
      }
      if (!(err instanceof RunFailure)) logger.warn({ err, runId: run.id }, "run failed");
      const error = err instanceof RunFailure ? err.message : `The model failed: ${messageOf(err)}`;
      try {
        write(lease, run.threadId, (append) => {
          reply.close(append, "failed");
          end(lease, run, append, { status: "failed", error, usage });
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
      const error = retry
        ? "The server stopped while the agent was replying."
        : `The agent stopped ${run.attempt} times on this input and gave up.`;
      try {
        write(lease, run.threadId, (append) => {
          for (const row of transcript(run.threadId).rows) {
            if (row.kind !== "agent" || row.runId !== run.id || row.status !== "streaming")
              continue;
            append({
              type: "message.completed",
              actor: AGENT,
              data: {
                messageId: row.id,
                runId: run.id,
                parts: row.text ? [{ type: "text", text: row.text }] : [],
                status: "failed",
              },
            });
          }
          end(lease, run, append, { status: "failed", error }, retry);
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
      unsubscribe = bus.onWake(() => tick());
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

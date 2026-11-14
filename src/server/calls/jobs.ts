// Jobs: tool calls that run on beside the agent's runs, started by it or moved there by a person,
// each with an id the agent checks, lists and cancels it by. A job meets the same rules as a call
// a run makes: it runs at once, or waits for someone to approve it, which no run waits on. When one
// ends, the thread's agent is told once, with its result cut to a cap, as the people whose words
// steered it carry it. A job runs under a lease of the instance running it; one left running by a
// stopped server ends as interrupted and is never run again. Only a few of a thread's jobs run or
// wait at once.

import { ulid } from "ulid";
import * as z from "zod";

import { findAsync } from "@/server/kernel/async.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { Queue } from "@/server/queue/queue.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import { LeaseLost } from "@/server/sync/lease.ts";
import type { AfterCommit, Sync } from "@/server/sync/sync.ts";
import type { Append, ThreadLog } from "@/server/threads/log.ts";
import type { NewEvent, Thread, ThreadStore } from "@/server/threads/service.ts";
import type { Live } from "@/server/agent/live.ts";
import { steeringOf } from "./influence.ts";
import { callRecords } from "./views.ts";
import type { AnyToolSpec, ToolOutput, Tools, Toolset, ToolSpec } from "@/server/agent/tools.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import { wireToolName } from "@/shared/tools.ts";
import {
  BACKGROUND_LIMIT,
  type BackgroundWork,
  CALLS_TOOLSET,
  type CallStatus as ShownStatus,
  START_CALL,
} from "@/shared/calls.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";

import { and, eq } from "drizzle-orm";

import { call, type CallStatus } from "./schema.ts";
import type { CallLease, CallRow, CallStore } from "./store.ts";

// How many approved jobs one sweep takes up at most.
const READY_BATCH = 20;

// The longest a call's result runs in the notice that tells of it.
export const RESULT_CHARS = 20_000;

// What the agent is told about them.
export const CALLS_GUIDANCE =
  "Start a tool call with jobs.start when it is slow or independent of what you do next; you get an id at once and its result arrives as a notification. Start several, keep working, and end your turn to wait rather than polling; use jobs.check only when a decision depends on it. Cancel what you no longer need with jobs.cancel.";

// Where a job stands in the words its card, the tray and the agent read: waiting for a person or
// to be launched is pending, and every way it was stopped before it ran is cancelled.
export function shownStatus(status: CallStatus): ShownStatus {
  switch (status) {
    case "waiting":
    case "ready":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
    case "interrupted":
      return status;
    default:
      return "cancelled";
  }
}

// A job as its card and the tray show it, and whether the reader may stop it.
export function callWork(
  row: Pick<CallRow, "status" | "createdAt" | "endedAt">,
  canPost: boolean,
): BackgroundWork {
  const status = shownStatus(row.status);
  return {
    kind: "call",
    status,
    startedAt: row.createdAt.toISOString(),
    ...(row.endedAt && { endedAt: row.endedAt.toISOString() }),
    canCancel: canPost && (status === "running" || status === "pending"),
  };
}

// A call the tool refuses, with what the model is told.
class ToolRefusal extends Error {}

async function refusing<T>(
  work: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

// What a result says, as the agent reads it, cut to the cap.
function resultText(output: ToolOutput) {
  const value = output.ok ? valueForAgent(output.value) : output.error;
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)} (cut short)` : text;
}

const ACTOR = { kind: "agent" } as const;

export interface JobsOptions {
  store: CallStore;
  threads: Pick<ThreadStore, "find" | "eventsAt" | "lastRan" | "results">;
  spaceStore: Pick<SpaceStore, "find">;
  log: ThreadLog;
  queue: Pick<Queue, "enqueue" | "words">;
  logger: Logger;
  afterCommit: AfterCommit;
  tools: Pick<
    Tools,
    | "offered"
    | "evaluate"
    | "approvalHolds"
    | "riskOf"
    | "namesNow"
    | "modelNames"
    | "fromServers"
    | "run"
    | "turnedOn"
  >;
  live?: Pick<Live, "open" | "close" | "end" | "of">;
  instanceId: string;
  keeper: Sync["keeper"];
  transact: Sync["transact"];
  claimDue: Sync["claimDue"];
  leaseMs: number;
  now: () => Date;
  // Hears of each running call held here, as the keeper beats.
  beat: () => Promise<void>;
}

export type Jobs = ReturnType<typeof createJobs>;

export function createJobs(options: JobsOptions) {
  const { store, threads, spaceStore, log, queue, logger, leaseMs, now } = options;
  const owner = options.instanceId;
  // The jobs running here, each with what stops it and the lease it runs under.
  const live = new Map<string, { controller: AbortController; lease: CallLease }>();
  const key = (threadId: string, id: string) => `${threadId} ${id}`;

  function leaseOf(row: Pick<CallRow, "threadId" | "id" | "leaseEpoch">): CallLease {
    return { threadId: row.threadId, callId: row.id, owner, epoch: row.leaseEpoch };
  }

  // Stops the job running here, once the write that stopped it is kept.
  function abortHere(threadId: string, id: string, reason: string) {
    options.afterCommit(() => {
      const held = live.get(key(threadId, id));
      live.delete(key(threadId, id));
      held?.controller.abort(new Error(reason));
    });
  }

  async function contextOf(threadId: string) {
    const thread = await threads.find(threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) throw new ToolRefusal("The thread is gone.");
    return { thread, space };
  }

  async function titleOf(space: { id: string; orgId: string }, toolId: string) {
    return (await options.tools.namesNow(space))(toolId)?.title ?? toolId;
  }

  // What the job gave back, or why it failed, once it ended, as its result in the log says.
  async function outputOf(job: Pick<CallRow, "threadId" | "id">): Promise<ToolOutput | null> {
    const ran = await threads.lastRan(job.threadId, job.id);
    if (ran?.type !== "tool.ran") return null;
    if (!ran.data.ok) return { ok: false, error: ran.data.error ?? "The tool failed." };
    if (!ran.data.large) return { ok: true, value: ran.data.value ?? null };
    return { ok: true, value: (await threads.results([ran.id])).get(ran.id) ?? null };
  }

  // Whose words steered the job: those the agent had read when it was asked for.
  async function steeringOfJob(job: Pick<CallRow, "threadId" | "seq">) {
    const words = await queue.words(job.threadId);
    return steeringOf(words.filter((word) => word.seq < job.seq));
  }

  // Tells the thread's agent how the job ended, once however often its end is recorded.
  async function notify(
    job: Pick<CallRow, "threadId" | "id" | "toolId" | "seq">,
    text: string,
    result?: string,
  ) {
    const thread = await threads.find(job.threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) return;
    const title = await titleOf(space, job.toolId);
    await queue.enqueue(
      thread.id,
      {
        kind: "notice",
        notice: {
          kind: "call.ended",
          source: { threadId: thread.id, name: title, main: true, callId: job.id },
          actor: { kind: "source", label: title, type: "job" },
          text,
          people: await steeringOfJob(job),
          ...(result && { last: result }),
        },
      },
      {
        origin: { kind: "job", id: job.id },
        key: `job:${job.id}:ended`,
        source: { callId: job.id },
      },
    );
  }

  // Records the job's result in its row in the log, unless that ended already.
  async function recordRan(job: CallRow, append: Append, output: ToolOutput, ms = 0, extra = {}) {
    await options.live?.end(job.id);
    await append({
      type: "tool.ran",
      actor: ACTOR,
      data: {
        runId: job.runId,
        callId: job.id,
        ms,
        ...(output.ok ? { ok: true, value: output.value } : { ok: false, error: output.error }),
        ...extra,
      },
    });
  }

  // Ends the job with its output, unless it ended already or is no longer this instance's, and
  // tells the agent, in one write.
  async function end(job: CallRow, output: ToolOutput, started: Date, extra: object = {}) {
    const held = live.get(key(job.threadId, job.id));
    live.delete(key(job.threadId, job.id));
    if (!held) {
      // Ended elsewhere, with what it printed.
      options.live?.close(job.id);
      return;
    }
    const ms = Math.max(0, now().getTime() - started.getTime());
    try {
      await log.write(job.threadId, async (append) => {
        if (!(await store.finish(held.lease, output.ok ? "completed" : "failed"))) return;
        await recordRan(job, append, output, ms, extra);
        const { space } = await contextOf(job.threadId);
        await notify(
          job,
          `Background call ${job.id} (${await titleOf(space, job.toolId)}) ${output.ok ? "finished" : "failed"}`,
          resultText(output),
        );
      });
    } catch (err) {
      logger.warn({ err, callId: job.id }, "background call end not recorded");
    }
  }

  // Whether this instance still carries the job out under the lease.
  const holds = async (lease: CallLease) => store.holds(lease);

  // Goes on with the job's work held here, ending it when the work is done.
  function follow(
    job: CallRow,
    controller: AbortController,
    work: Promise<ToolOutput>,
    started: Date,
    extra: object = {},
  ) {
    live.set(key(job.threadId, job.id), { controller, lease: leaseOf(job) });
    void work.then(
      async (output) => end(job, output, started, extra),
      async (err: unknown) => {
        logger.warn({ err, callId: job.id, toolId: job.toolId }, "background call failed");
        await end(job, { ok: false, error: messageOf(err) }, started, extra);
      },
    );
  }

  // Runs the job now, held here, and ends it when it is done.
  async function launch(
    job: CallRow,
    spec: AnyToolSpec,
    input: unknown,
    runAs: string | null,
    extra: object = {},
    approvedBy?: string,
  ) {
    const { thread, space } = await contextOf(job.threadId);
    const controller = new AbortController();
    const lease = leaseOf(job);
    const started = now();
    let work: Promise<ToolOutput>;
    try {
      work = Promise.resolve(
        options.tools.run(spec, input, {
          threadId: thread.id,
          spaceId: space.id,
          orgId: space.orgId,
          runId: job.id,
          callId: job.id,
          background: true,
          actor: ACTOR,
          model: job.model,
          runAs,
          ...(approvedBy && { approvedBy }),
          influence: await steeringOfJob(job),
          signal: controller.signal,
          ...(options.live && {
            live: options.live.open(thread.id, job.id, async () =>
              (await holds(lease)) ? job.id : null,
            ),
          }),
          write: async (work) => (await fenced(lease, work)).result,
        }),
      );
    } catch (err) {
      work = Promise.reject(err);
    }
    follow(job, controller, work, started, extra);
  }

  // A write to the job's thread made only while the job is held under the lease.
  async function fenced<T>(lease: CallLease, work: (append: Append) => Promise<T>) {
    return log.write(lease.threadId, async (append) => {
      if (!(await holds(lease))) throw new LeaseLost(`job ${lease.callId}`);
      return work(append);
    });
  }

  // Ends the jobs a stopped server left running, telling their threads' agents: those whose lease
  // ran out. Another instance may be running the rest.
  async function recover() {
    for (const job of await store.stale()) {
      try {
        await log.write(job.threadId, async (append) => {
          if (!(await store.interrupt(job.threadId, job.id))) return;
          await recordRan(job, append, {
            ok: false,
            error: "The server stopped while the call ran.",
          });
          await notify(
            job,
            `Background call ${job.id} (${job.toolId}) was interrupted: the server stopped while it ran.`,
          );
          abortHere(job.threadId, job.id, "interrupted");
        });
      } catch (err) {
        logger.warn({ err, callId: job.id }, "interrupted call not recorded");
      }
    }
  }

  // Keeps the leases of the jobs running here, and stops those whose lease no longer holds, as when
  // someone stopped one through another instance; then ends those others left behind. Each beat
  // also looks at the run's calls running here, for a move someone asked for.
  const keeper = options.keeper({
    name: "jobs",
    everyMs: leaseMs / 3,
    held: () => live.keys(),
    renew: async (id: string) => {
      const held = live.get(id);
      return !held || (await store.renew(held.lease, leaseMs));
    },
    onLost: (id: string) => {
      live.get(id)?.controller.abort(new Error("cancelled"));
      live.delete(id);
    },
    sweep: async () => {
      await recover();
      await claimReady();
      await options.beat();
    },
  });

  // A job standing ready goes stale, if it still stands ready, and the agent is told why.
  async function goStale(job: CallRow, text: string) {
    await log.write(job.threadId, async (append) => {
      if (!(await store.goStale(job.threadId, job.id))) return;
      await append({
        type: "tool.denied",
        actor: ACTOR,
        data: { runId: job.runId, callId: job.id, reason: "stale" },
      });
      await notify(job, text);
    });
  }

  // An approved job standing ready: it runs here if the approval still holds, else it goes stale
  // and the agent is told.
  async function proceed(threadId: string, callId: string) {
    const job = await store.find(threadId, callId);
    if (!job?.background || job.status !== "ready") return;
    const { thread, space } = await contextOf(threadId);
    const tools = options.tools;
    const row = (await callRecords(threads, threadId, [job])).get(callId);
    const spec = (await tools.offered(space, thread)).find((one) => one.name === job.toolId);
    const parsed = row && spec && spec.input.safeParse(row.input);
    const holdsNow =
      !!row &&
      !!spec &&
      !!parsed?.success &&
      (await tools.approvalHolds(
        row,
        await queue.words(threadId),
        thread,
        space,
        await tools.riskOf(space, spec, parsed.data, job.model),
      ));
    if (!holdsNow || !spec || !row || !parsed?.success) {
      await goStale(
        job,
        `Background call ${callId} (${job.toolId}) was not allowed to run: its approval no longer held.`,
      );
      return;
    }
    // Another instance may have taken the decision up first.
    const started = await store.startJob(threadId, callId, owner, leaseMs);
    if (!started) return;
    const runAs = (await spec.connection?.(parsed.data, space))
      ? (row.decision?.by.userId ?? null)
      : null;
    await launch(started, spec, parsed.data, runAs, {}, row.decision?.by.userId);
  }

  // Takes up the approved jobs that stand ready, on whichever instance sweeps first; each is
  // started once, by the guarded start in `proceed`.
  async function claimReady() {
    const ready = await options.transact(async () =>
      options.claimDue(call, {
        where: and(eq(call.background, true), eq(call.status, "ready"))!,
        orderBy: call.createdAt,
        limit: READY_BATCH,
      }),
    );
    for (const job of ready) {
      try {
        await proceed(job.threadId, job.id);
      } catch (err) {
        logger.warn({ err, callId: job.id }, "approved call not started");
        // Left ready, it would be claimed first again on every sweep, ahead of those behind it.
        await goStale(job, `Background call ${job.id} (${job.toolId}) could not be started.`).catch(
          (err: unknown) => logger.warn({ err, callId: job.id }, "approved call not ended"),
        );
      }
    }
  }

  // The tool the agent may call by this name, for a job.
  async function specFor(thread: Thread, space: Pick<Space, "id" | "orgId">, toolId: string) {
    const tools = options.tools;
    const wanted =
      (await tools.modelNames(space)).fromModel(toolId) ??
      (
        await findAsync(
          await tools.offered(space, thread),
          async (one) =>
            one.name === toolId ||
            wireToolName((await tools.modelNames(space)).toModel(one.name)) === toolId,
        )
      )?.name ??
      toolId;
    const spec = (await tools.offered(space, thread)).find((one) => one.name === wanted);
    if (!spec) throw new ToolRefusal(`No tool is named ${toolId} here.`);
    if (spec.name.startsWith(`${CALLS_TOOLSET}.`)) {
      throw new ToolRefusal("A background call cannot start another.");
    }
    if (spec.waitsFor === "answer") {
      throw new ToolRefusal("A tool that asks cannot run in the background.");
    }
    const left = (await tools.fromServers(space, await tools.modelNames(space))).some(
      (tool) => tool.id === spec.name,
    );
    if (left && !(await tools.turnedOn(thread.id)).some((tool) => tool.id === spec.name)) {
      throw new ToolRefusal(
        `${toolId} is not on yet. Search for it or select it with tools.search first.`,
      );
    }
    return spec;
  }

  async function mine(id: string, threadId: string) {
    const job = await store.find(threadId, id);
    if (!job?.background) throw new ToolRefusal(`No call has the id ${id}.`);
    return job;
  }

  async function summaryOf(job: CallRow) {
    const { thread, space } = await contextOf(job.threadId);
    const output = await outputOf(job);
    // What a running job has printed so far, its end cut to the cap, and how far it has come.
    const printed = job.status === "running" ? await options.live?.of(job.id) : null;
    return {
      id: job.id,
      tool: await titleOf(space, job.toolId),
      toolId: job.toolId,
      status: shownStatus(job.status),
      ...(output?.ok && { result: resultText(output) }),
      ...(output && !output.ok && { error: output.error }),
      ...(printed?.progress && { progress: printed.progress }),
      ...(printed?.text && { output: printed.text.slice(-RESULT_CHARS) }),
      startedAt: job.createdAt.toISOString(),
      ...(job.endedAt && { endedAt: job.endedAt.toISOString() }),
      thread: thread.id,
    };
  }

  // Stops the job: it runs no more and tells nobody. Run elsewhere, the instance running it stops
  // it once its lease no longer holds. False when it had ended already.
  async function cancelJob(job: Pick<CallRow, "threadId" | "id" | "runId">) {
    const { result } = await log.write(job.threadId, async (append) => {
      if (!(await store.cancel(job.threadId, job.id))) return false;
      await options.live?.end(job.id);
      await append({
        type: "tool.denied",
        actor: ACTOR,
        data: { runId: job.runId, callId: job.id, reason: "stopped" },
      });
      abortHere(job.threadId, job.id, "cancelled");
      return true;
    });
    return result;
  }

  // Makes the job's row and its request in the log, inside the thread's write.
  async function requested(
    append: (event: NewEvent) => Promise<{ seq: number }>,
    job: {
      threadId: string;
      branchId: string;
      id: string;
      runId: string;
      toolId: string;
      input: unknown;
      risk: ToolRisk;
      waits: boolean;
      names?: { title?: string; toolset?: string | null } | null;
      // The run's call it goes on from, when moved to the background.
      movedFrom?: string;
      // The model it is judged under.
      model: string | null;
    },
  ) {
    const { names } = job;
    const requested = await append({
      type: "tool.requested",
      actor: ACTOR,
      data: {
        runId: job.runId,
        callId: job.id,
        messageId: "",
        toolId: job.toolId,
        input: job.input,
        risk: job.risk,
        waits: job.waits,
        background: true,
        ...(names?.title && { title: names.title }),
        ...(names?.toolset && { toolset: names.toolset }),
      },
    });
    const [made] = await store.insert([
      {
        threadId: job.threadId,
        id: job.id,
        branchId: job.branchId,
        runId: job.runId,
        toolId: job.toolId,
        risk: job.risk,
        status: job.waits ? "waiting" : "running",
        waitsFor: job.waits ? "decision" : null,
        seq: requested.seq,
        model: job.model,
        background: true,
        ...(job.movedFrom && { movedFrom: job.movedFrom }),
        ...(!job.waits && { lease: { owner, leaseMs } }),
      },
    ]);
    return made!;
  }

  // Refuses a job past the thread's limit, counted inside the thread's write.
  async function room(threadId: string) {
    return (await store.openJobs(threadId)) < BACKGROUND_LIMIT;
  }

  const start: ToolSpec<{ tool: string; input?: Record<string, unknown> }> = {
    name: START_CALL,
    modelName: "jobs.start",
    title: "Start",
    annotations: { readOnlyHint: false },
    movable: false,
    description:
      "Start a tool call in the background and return its id at once; its result arrives as a notification. It meets the tool's usual approval.",
    input: z.object({
      tool: z.string().min(1).meta({ title: "Tool", description: "The tool's name" }),
      input: z.record(z.string(), z.unknown()).optional().meta({ title: "Input" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return Promise.resolve(
        refusing(async () => {
          const { thread, space } = await contextOf(ctx.threadId);
          const spec = await specFor(thread, space, input.tool);
          const parsed = spec.input.safeParse(input.input ?? {});
          if (!parsed.success) {
            throw new ToolRefusal(`The input is not valid: ${z.prettifyError(parsed.error)}`);
          }
          const tools = options.tools;
          const branchId = thread.currentBranchId;
          const decision = await tools.evaluate(
            await queue.words(thread.id, branchId),
            await store.vouches(thread.id, branchId),
            thread,
            space,
            spec.name,
            await spec.risk(parsed.data, { model: ctx.model, orgId: space.orgId }),
            parsed.data,
          );
          const waits = decision.kind === "wait";
          const risk = await tools.riskOf(space, spec, parsed.data, ctx.model);
          const names = (await tools.namesNow(space))(spec.name);
          const id = ulid();
          const job = await ctx.write(async (append) => {
            if (!(await room(thread.id))) {
              throw new ToolRefusal(
                `This thread has ${BACKGROUND_LIMIT} background calls running or waiting. Wait for some to end or cancel them.`,
              );
            }
            return requested(append, {
              model: ctx.model,
              threadId: thread.id,
              branchId: (await threads.find(thread.id))?.currentBranchId ?? thread.currentBranchId,
              id,
              runId: ctx.runId,
              toolId: spec.name,
              input: parsed.data,
              risk,
              waits,
              names,
            });
          });
          if (!waits) {
            await launch(
              job,
              spec,
              parsed.data,
              decision.runAs ?? null,
              decision.kind === "standing" ? { standingOn: decision.callId } : {},
            );
          }
          return { id, status: shownStatus(job.status) };
        }),
      );
    },
  };

  const status: ToolSpec<{ id: string }> = {
    name: "calls.status",
    modelName: "jobs.check",
    title: "Status",
    annotations: { readOnlyHint: true },
    movable: false,
    description:
      "Where a background call stands: while it runs, its progress and the end of its output, where its tool reports them; once it ended, its result.",
    input: z.object({ id: z.string().min(1).meta({ title: "Id" }) }),
    risk: () => "normal",
    run({ id }, ctx) {
      return Promise.resolve(refusing(async () => summaryOf(await mine(id, ctx.threadId))));
    },
  };

  const list: ToolSpec<Record<string, never>> = {
    name: "calls.list",
    modelName: "jobs.list",
    title: "List",
    annotations: { readOnlyHint: true },
    movable: false,
    description: "This thread's background calls, newest first, without their results.",
    input: z.object({}).strict() as z.ZodType<Record<string, never>>,
    risk: () => "normal",
    run(_input, ctx) {
      return Promise.resolve(
        refusing(async () => ({
          calls: await Promise.all(
            (await store.jobs(ctx.threadId)).map(async (job) => {
              const {
                result: _result,
                error: _error,
                output: _output,
                ...rest
              } = await summaryOf(job);
              return rest;
            }),
          ),
        })),
      );
    },
  };

  const cancel: ToolSpec<{ id: string }> = {
    name: "calls.cancel",
    modelName: "jobs.cancel",
    title: "Cancel",
    annotations: { readOnlyHint: false },
    movable: false,
    description: "Stop a background call that is running or waiting for approval.",
    input: z.object({ id: z.string().min(1).meta({ title: "Id" }) }),
    risk: () => "normal",
    run({ id }, ctx) {
      return Promise.resolve(
        refusing(async () => {
          const job = await mine(id, ctx.threadId);
          if (!(await cancelJob(job))) {
            const now = await store.find(ctx.threadId, id);
            throw new ToolRefusal(`Call ${id} already ${now ? shownStatus(now.status) : "ended"}.`);
          }
          return { id, status: "cancelled" };
        }),
      );
    },
  };

  return {
    toolset(): Toolset {
      return {
        id: CALLS_TOOLSET,
        title: "Background jobs",
        source: "builtin",
        description: "Tool calls that run in the background",
        guidance: CALLS_GUIDANCE,
        tools: [start, status, list, cancel],
      };
    },

    requested,
    room,
    cancel: cancelJob,
    notify,
    follow,
    fenced,
    holds,
    leaseOf,
    recover,

    async start() {
      await keeper.start();
    },

    beat: async () => keeper.beat(),

    // Stops the jobs running here and lets them go, to be ended as interrupted by whoever looks
    // next.
    async stop() {
      await keeper.stop();
      for (const [id, held] of live) {
        live.delete(id);
        held.controller.abort(new Error("shutdown"));
        await store.expire(held.lease);
      }
    },
  };
}

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
import type { NewEvent, Thread, ThreadStore } from "@/server/threads/types.ts";
import type { Live } from "@/server/calls/live.ts";
import { influenceOf } from "./influence.ts";
import { callRecords } from "./views.ts";
import type {
  AnyToolSpec,
  CallView,
  ToolOutput,
  Tools,
  Toolset,
  ToolSpec,
} from "@/server/tools/registry.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import { notOnYet } from "@/server/tools/search.ts";
import { type ToolText, wireToolName } from "@/shared/tools.ts";
import {
  BACKGROUND_LIMIT,
  type Work,
  JOBS_TOOLSET,
  type JobStatus as ShownStatus,
  CANCEL_JOB,
  CHECK_JOB,
  LIST_JOBS,
  START_JOB,
} from "@/shared/jobs.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";

import { and, eq, sql } from "drizzle-orm";

import { call, type CallStatus } from "./schema.ts";
import type { CallLease, CallRow, CallStore } from "./store.ts";

// How many approved jobs one sweep takes up at most.
const READY_BATCH = 20;

// The longest a call's result runs in the notice that tells of it.
export const RESULT_CHARS = 20_000;

// What the agent is told about them.
export const CALLS_GUIDANCE: ToolText = (named) =>
  `Start a tool call with ${named(START_JOB)} when it is slow or independent of what you do next; you get an id at once and its result arrives as a notice. Start several, keep working, and end your turn to wait rather than polling; use ${named(CHECK_JOB)} only when a decision depends on it. Cancel what you no longer need with ${named(CANCEL_JOB)}.`;

// Where a job stands in the words its card, the tray and the agent read: waiting for a person,
// queued for its turn to run, and every way it was stopped before it ran is cancelled.
export function shownStatus(status: CallStatus): ShownStatus {
  switch (status) {
    case "waiting":
      return "waiting";
    case "ready":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return status;
    default:
      return "cancelled";
  }
}

// A job as its card and the tray show it, and whether the reader may stop it.
export function callWork(
  row: Pick<CallRow, "status" | "createdAt" | "startedAt" | "endedAt">,
  canPost: boolean,
): Work {
  const status = shownStatus(row.status);
  return {
    kind: "job",
    status,
    // Since it began running, or began waiting for a person; none while it waits for its turn.
    startedAt:
      (row.startedAt ?? (row.status === "waiting" ? row.createdAt : null))?.toISOString() ?? null,
    ...(row.endedAt && { endedAt: row.endedAt.toISOString() }),
    canCancel: canPost && (status === "running" || status === "waiting" || status === "queued"),
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
  // Why the thread may no longer run work, as a subagent's archived; null while it may.
  retired?: (thread: Thread) => Promise<string | null>;
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
    | "textNamer"
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
  async function influenceOfJob(job: Pick<CallRow, "threadId" | "seq">) {
    const words = await queue.words(job.threadId);
    return influenceOf(words.filter((word) => word.seq < job.seq));
  }

  // Tells the thread's agent how the job ended, once however often its end is recorded, naming
  // the call by its id and its tool's title.
  async function notify(
    job: Pick<CallRow, "threadId" | "id" | "toolId" | "seq">,
    how: string,
    result?: string,
  ) {
    const thread = await threads.find(job.threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) return;
    const title = await titleOf(space, job.toolId);
    const text = `Background call ${job.id} (${title}) ${how}`;
    await queue.enqueue(
      thread.id,
      {
        kind: "notice",
        notice: {
          kind: "call.ended",
          source: { threadId: thread.id, name: title, main: true, callId: job.id },
          actor: { kind: "source", label: title, type: "job" },
          text,
          influence: await influenceOfJob(job),
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
        await notify(job, output.ok ? "finished" : "failed", resultText(output));
        // Its place goes to the oldest job queued for one, here or on another instance.
        options.afterCommit(() => void keeper.beat());
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
    // Held here before it runs, so a cancel from now on reaches it; one recorded since it started
    // means it never runs.
    live.set(key(job.threadId, job.id), { controller, lease });
    if (!(await holds(lease))) {
      live.delete(key(job.threadId, job.id));
      return;
    }
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
          influence: await influenceOfJob(job),
          named: options.tools.textNamer(await options.tools.modelNames(space)),
          signal: controller.signal,
          ...(options.live && {
            live: options.live.open(thread.id, job.id, async () => holds(lease)),
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
          await notify(job, "was interrupted: the server stopped while it ran.");
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
  async function goStale(job: CallRow, how: string) {
    await log.write(job.threadId, async (append) => {
      if (!(await store.goStale(job.threadId, job.id))) return;
      await append({
        type: "tool.denied",
        actor: ACTOR,
        data: { runId: job.runId, callId: job.id, reason: "stale" },
      });
      await notify(job, how);
    });
  }

  // A job standing ready, approved or queued for its turn: judged again inside the write that
  // starts it, it runs here once the thread has room for it; one that may no longer run goes stale
  // and the agent is told why. What fails while it is looked at leaves it waiting for the next sweep.
  async function proceed(threadId: string, callId: string) {
    const { result: go } = await log.write(threadId, async () => {
      const job = await store.find(threadId, callId);
      if (!job?.background || job.status !== "ready") return null;
      const stale = async (why: string) => {
        await goStale(job, `was not started: ${why}`);
        return null;
      };
      const thread = await threads.find(threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!thread || !space || space.trashedAt) return stale("its thread is gone.");
      if (space.archivedAt) return stale("its space is archived.");
      const retired = await options.retired?.(thread);
      if (retired) return stale(retired);
      const row = (await callRecords(threads, threadId, [job])).get(callId);
      if (!row) return stale("its request is gone.");
      let spec: AnyToolSpec;
      try {
        spec = await specFor(thread, space, job.toolId);
      } catch (err) {
        if (err instanceof ToolRefusal) return stale(err.message);
        throw err;
      }
      const parsed = spec.input.safeParse(row.input);
      if (!parsed.success) return stale("its input no longer fits the tool.");
      const judged = await judgeNow({
        thread,
        space,
        spec,
        input: parsed.data,
        model: job.model,
        branchId: job.branchId,
        beforeSeq: job.seq,
        row,
      });
      if (judged.kind === "wait") return stale("it now needs approval. Ask for it again.");
      if (judged.kind === "lapsed") return stale("its approval no longer held.");
      // Under the thread's lock, so two instances never fill the same last place; one that finds
      // no room is left for a later sweep, and one another instance started is passed over.
      if (!(await room(threadId))) return null;
      const started = await store.startJob(threadId, callId, owner, leaseMs);
      return started && { started, spec, input: parsed.data, judged, row };
    });
    if (!go) return;
    await launch(
      go.started,
      go.spec,
      go.input,
      go.judged.runAs,
      go.judged.extra,
      go.row.decision?.by.userId,
    );
  }

  // Takes up the jobs that stand ready, approved or queued, in the order they came to wait, on
  // whichever instance sweeps first; each is started once, by the guarded start in `proceed`.
  async function claimReady() {
    const ready = await options.transact(async () =>
      options.claimDue(call, {
        // Only as many of each thread's as it has places free, in the order they came to wait for
        // a turn: approved, or asked for allowed.
        where: and(
          eq(call.background, true),
          eq(call.status, "ready"),
          sql`(${call.threadId}, ${call.id}) in (
            select q.thread_id, q.id from (
              select r.thread_id, r.id,
                     row_number() over (partition by r.thread_id
                                        order by coalesce(r.decided_at, r.created_at), r.id) as turn
                from call r where r.background and r.status = 'ready') q
             where q.turn <= ${BACKGROUND_LIMIT} - (
               select count(*) from call x
                where x.thread_id = q.thread_id and x.background and x.status = 'running'))`,
        )!,
        orderBy: sql`coalesce(${call.decidedAt}, ${call.createdAt})`,
        limit: READY_BATCH,
      }),
    );
    for (const job of ready) {
      try {
        await proceed(job.threadId, job.id);
      } catch (err) {
        // Left waiting: the next sweep looks at it again.
        logger.warn({ err, callId: job.id }, "queued call not started");
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
    if (spec.name.startsWith(`${JOBS_TOOLSET}.`)) {
      throw new ToolRefusal("A background call cannot start another.");
    }
    if (spec.waitsFor === "answer") {
      throw new ToolRefusal("A tool that asks cannot run in the background.");
    }
    const names = await tools.modelNames(space);
    const left = (await tools.fromServers(space, names)).some((tool) => tool.id === spec.name);
    if (left && !(await tools.turnedOn(thread.id)).some((tool) => tool.id === spec.name)) {
      throw new ToolRefusal(notOnYet(spec.name, names.toModel));
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
      tool: wireToolName((await options.tools.modelNames(space)).toModel(job.toolId)),
      status: shownStatus(job.status),
      ...(output?.ok && { result: resultText(output) }),
      ...(output && !output.ok && { error: output.error }),
      ...(printed?.progress && { progress: printed.progress }),
      ...(printed?.text && { output: printed.text.slice(-RESULT_CHARS) }),
      startedAt: job.startedAt?.toISOString() ?? null,
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
        data: { runId: job.runId, callId: job.id, reason: "cancelled" },
      });
      abortHere(job.threadId, job.id, "cancelled");
      options.afterCommit(() => void keeper.beat());
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
      // Waiting for a decision, ready for its turn to run, or running here now.
      status: "waiting" | "ready" | "running";
      names?: { title?: string; toolset?: string | null } | null;
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
        waits: job.status === "waiting",
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
        status: job.status,
        waitsFor: job.status === "waiting" ? "decision" : null,
        seq: requested.seq,
        model: job.model,
        background: true,
        ...(job.status === "running" && { lease: { owner, leaseMs } }),
      },
    ]);
    return made!;
  }

  // Whether the thread has a place for one more running job, counted inside the thread's write.
  async function room(threadId: string) {
    return (await store.runningJobs(threadId)) < BACKGROUND_LIMIT;
  }

  // What lets a call run in the background now, judged as its ask was: with the words its branch
  // held when it was asked for (those before `beforeSeq` for one asked for already) and the vouches
  // the branch holds. One approved runs while its approval holds, with its approver's own login
  // where the tool uses one; else it is judged afresh.
  async function judgeNow(ask: {
    thread: Thread;
    space: Space;
    spec: AnyToolSpec;
    input: unknown;
    model: string | null;
    branchId: string;
    beforeSeq?: number;
    row?: CallView;
  }): Promise<
    | { kind: "run"; runAs: string | null; extra: { standingOn?: string } }
    | { kind: "wait" }
    | { kind: "lapsed" }
  > {
    const { thread, space, spec, input, model, branchId, beforeSeq, row } = ask;
    const tools = options.tools;
    const words = (await queue.words(thread.id, branchId)).filter(
      (word) => beforeSeq === undefined || word.seq < beforeSeq,
    );
    if (row?.decision) {
      const risk = await tools.riskOf(space, spec, input, model);
      if (!(await tools.approvalHolds(row, words, thread, space, risk))) return { kind: "lapsed" };
      const own = await spec.connection?.(input, space);
      return { kind: "run", runAs: own ? row.decision.by.userId : null, extra: {} };
    }
    const decision = await tools.evaluate(
      words,
      await store.vouches(thread.id, branchId),
      thread,
      space,
      spec.name,
      await spec.risk(input, { model, orgId: space.orgId }),
      input,
    );
    if (decision.kind === "wait") return { kind: "wait" };
    return {
      kind: "run",
      runAs: decision.runAs ?? null,
      extra: decision.kind === "standing" ? { standingOn: decision.callId } : {},
    };
  }

  const start: ToolSpec<{ tool: string; input?: Record<string, unknown> }> = {
    name: START_JOB,
    title: "Start",
    annotations: { readOnlyHint: false },
    movable: false,
    description: `Start a tool call in the background and return its id at once; its result arrives as a notice. It meets the tool's usual approval. Past ${BACKGROUND_LIMIT} running, it is queued and starts when one ends.`,
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
          const judged = await judgeNow({
            thread,
            space,
            spec,
            input: parsed.data,
            model: ctx.model,
            branchId: thread.currentBranchId,
          });
          const risk = await tools.riskOf(space, spec, parsed.data, ctx.model);
          const names = (await tools.namesNow(space))(spec.name);
          const id = ulid();
          const job = await ctx.write(async (append) =>
            requested(append, {
              model: ctx.model,
              threadId: thread.id,
              branchId: (await threads.find(thread.id))?.currentBranchId ?? thread.currentBranchId,
              id,
              runId: ctx.runId,
              toolId: spec.name,
              input: parsed.data,
              risk,
              // One allowed waits its turn behind those already waiting for one, or past the
              // thread's limit.
              status:
                judged.kind === "wait"
                  ? "waiting"
                  : (await store.hasReady(thread.id)) || !(await room(thread.id))
                    ? "ready"
                    : "running",
              names,
            }),
          );
          if (judged.kind === "run" && job.status === "running") {
            await launch(job, spec, parsed.data, judged.runAs, judged.extra);
          }
          return {
            id,
            status: shownStatus(job.status),
            ...(job.status === "ready" && {
              queued: `This thread has ${BACKGROUND_LIMIT} background calls running; it starts when one ends.`,
            }),
          };
        }),
      );
    },
  };

  const status: ToolSpec<{ id: string }> = {
    name: CHECK_JOB,
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
    name: LIST_JOBS,
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
    name: CANCEL_JOB,
    title: "Cancel",
    annotations: { readOnlyHint: false },
    movable: false,
    description: "Stop a background call that is running, queued or waiting for approval.",
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
        id: JOBS_TOOLSET,
        title: "Background jobs",
        source: "builtin",
        description: "Tool calls that run in the background",
        guidance: CALLS_GUIDANCE,
        tools: [start, status, list, cancel],
      };
    },

    requested,
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

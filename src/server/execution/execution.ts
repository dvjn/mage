// The agent's runs from start to end, the one place they are started, stopped and ended. A run
// starts by one rule, asked whenever something may have changed: when an input is enqueued, as a
// run ends, and on every pass of the worker, which so heals a start that was missed. A person's
// message always starts the agent when nothing runs on its branch; a notice that wakes it starts
// it only while every gate agrees, as a subagent's limit of places. A stop locks the runs it asks
// in id order, records who asked and queues again a run that waits, for a worker to end it; a run
// asked to stop never goes on to wait. A run's end, what follows it and whoever hears of it are one write.
// What a thread's agent is offered and reads beyond Mage's own comes from the systems that
// contribute it.

import type { Reader } from "@/server/access/access.ts";
import type { Calls } from "@/server/calls/calls.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { ModelMessage } from "@/server/models/gateway.ts";
import type { Notice } from "@/server/queue/notices.ts";
import type { Queue, QueuedInput } from "@/server/queue/queue.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { AfterCommit } from "@/server/sync/sync.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore } from "@/server/threads/types.ts";
import type { AnyToolSpec, SpaceTools } from "@/server/tools/registry.ts";
import type { Effort } from "@/server/models/gateway.ts";
import { asksToCompact } from "@/shared/transcript.ts";

import { anythingToCompact } from "./compaction.ts";

import type { Guidance } from "./context.ts";
import {
  createRunWorker,
  type Run,
  type RunStore,
  type RunWorkerOptions,
  startRun,
  type StopTarget,
} from "./worker.ts";

export type { Run, RunStatus, RunWorker, StopTarget } from "./worker.ts";

// What other systems read of runs.
export type RunReads = Pick<
  RunStore,
  | "find"
  | "latest"
  | "latestIn"
  | "active"
  | "activeOn"
  | "activeOnCurrent"
  | "activeIn"
  | "activeInSpace"
>;
export { LeaseLost, RunFailure } from "./worker.ts";

// What a system adds to what a thread's agent is offered and reads.
export interface Contribution {
  // What the thread's agent reads ahead of the thread itself.
  before?(thread: Thread): Promise<ModelMessage[]>;
  // What the thread is told again once compacted.
  reopens?(thread: Thread): Promise<Notice[]>;
  // What the agent is told beyond Mage's own prompt, given what those before it said.
  guidance?(
    space: Space,
    offered: readonly AnyToolSpec[],
    thread: Thread,
    now: SpaceTools,
    so: Guidance,
  ): Promise<Partial<Guidance>>;
}

export interface ExecutionOptions extends Omit<
  RunWorkerOptions,
  | "instanceId"
  | "guidance"
  | "before"
  | "reopens"
  | "advance"
  | "ended"
  | "endKept"
  | "parentOf"
  | "stranded"
> {
  queue: Pick<
    Queue,
    "waiting" | "admission" | "enqueue" | "stranded" | "onEnqueued" | "messageWaits"
  >;
  calls: Pick<Calls, "request" | "next" | "run" | "closeFor" | "onSettled" | "waits">;
  threads: Pick<ThreadStore, "find" | "eventAt" | "children">;
  spaceStore: Pick<SpaceStore, "find">;
  log: ThreadLog;
  signals: Signals;
  afterCommit: AfterCommit;
  // Where execution hears that people may have lost a role in an org's spaces, that spaces were
  // archived or put in trash, or that an org is being deleted.
  hooks?: Hooks;
  // Names this server instance in the leases it takes on runs.
  instanceId: string;
  // What a test sets of its workers in place of what execution gives them.
  overrides?: Partial<RunWorkerOptions>;
}

export type Execution = ReturnType<typeof createExecution>;

export function createExecution(options: ExecutionOptions) {
  const { runs, queue, calls, threads, spaceStore, log, signals } = options;
  const now = options.now ?? (() => new Date());
  const runsIn = options.runsIn ?? (async () => true);
  const contributions: Contribution[] = [];
  const gates: ((threadId: string) => Promise<boolean>)[] = [];
  const endedListeners: ((run: Run, next: Run | null) => Promise<void>)[] = [];
  const keptListeners: ((run: Run) => Promise<void>)[] = [];

  async function mayStart(threadId: string) {
    for (const gate of gates) if (!(await gate(threadId))) return false;
    return true;
  }

  // Starts the agent on the thread's current branch when nothing runs there and something waits
  // that starts it: a person's message always, a notice that wakes it while the gates agree. The
  // new run takes in at its start everything waiting, in one admission: every message but one
  // asking to compact, then every notice; a run that compacts takes in only the message that asks
  // for it. An interrupting message enqueued while a run is under way stops that run. Answers the
  // run started, if any.
  async function advance(
    threadId: string,
    opts: { input?: QueuedInput; after?: Run } = {},
  ): Promise<Run | null> {
    const { input, after } = opts;
    if (input?.kind === "notice" && !input.wake) return null;
    const thread = await threads.find(threadId);
    if (!thread) return null;
    const branchId = input?.branchId ?? after?.branchId ?? thread.currentBranchId;
    // A branch no longer current takes nothing more.
    if (branchId !== thread.currentBranchId) return null;
    // A thread whose start was missed with only notices waiting is asked its gate before it is
    // held, so one held back costs the pass no lock; the gate is asked again inside the write.
    if (!input && !after && !(await queue.messageWaits(threadId, branchId))) {
      if (!(await mayStart(threadId))) return null;
    }
    // A subagent's run starts on a notice only in a write that holds its starter's thread too,
    // where the gate counts its running siblings: taken first when this is the outermost write.
    // A write that holds only the subagent's thread starts nothing, and the worker's pass does.
    const starter = thread.parentThreadId;
    const holdsStarter = () => !starter || options.sync.holds("thread", starter);
    const also = starter && !options.sync.inTransaction() ? [starter] : [];
    return (
      await log.write(
        threadId,
        async (append) => {
          if (await runs.activeOn(branchId)) {
            if (input?.kind === "message" && input.delivery === "interrupt") {
              await stop({ threadId }, input.authorId);
            }
            return null;
          }
          const start = async (fields: Partial<Parameters<typeof startRun>[2]>) =>
            startRun(runs, append, {
              threadId,
              branchId,
              wokenBySeq: 0,
              createdBy: null,
              ...(after && { continuesRunId: after.id, reason: "queued_input" }),
              ...fields,
            });
          // Takes in what waits; a run that compacts, only the message that asks for it.
          const admit = async (run: Run, compacts?: QueuedInput) => {
            await queue.admission.admit(run, compacts ? { ids: [compacts.id] } : "all");
          };
          if (input?.kind === "message") {
            const run = await start({ wokenBySeq: input.seq, createdBy: input.authorId });
            const sent = await threads.eventAt(threadId, input.seq);
            await admit(
              run,
              sent?.type === "message" && asksToCompact(sent.data) ? input : undefined,
            );
            return run;
          }
          const waiting = after
            ? await queue.admission.admissible(threadId, branchId)
            : await queue.waiting(threadId, branchId);
          const messages = waiting.filter((one) => one.kind === "message");
          // An interrupting message starts the next run, with everything queued.
          const first = messages.find((one) => one.delivery === "interrupt") ?? messages[0];
          if (first) {
            const run = await start({
              wokenBySeq: first.seq,
              createdBy: first.authorId,
              ...(after && {
                reason: first.delivery === "interrupt" ? "interrupt" : "queued_input",
              }),
            });
            await admit(run, first.message && asksToCompact(first.message) ? first : undefined);
            return run;
          }
          const notices = waiting.filter((one) => one.kind === "notice");
          const waking = notices.find((one) => one.wake);
          if (!waking) return null;
          if (!holdsStarter()) {
            signals.wake(threadId);
            return null;
          }
          if (!(await mayStart(threadId))) return null;
          const run = await start({ wokenBySeq: waking.seq });
          await admit(run);
          return run;
        },
        branchId,
        also,
      )
    ).result;
  }

  // Asks the runs under way there to stop, in one transaction run again on a deadlock, and wakes
  // their threads as it commits, so the stop and its wake are heard together. A silent stop is not
  // told to the thread that started a subagent's.
  async function stop(target: StopTarget, by: string | null, opts: { silent?: boolean } = {}) {
    return options.transact(async () => {
      const stopped = await runs.stop(target, by, !!opts.silent, now());
      for (const run of stopped) signals.wake(run.threadId);
      return stopped;
    });
  }

  // When people may have lost a role in an org's spaces, their waiting messages there are
  // dropped, and the agent stops in spaces archived or put in trash.
  async function accessChanged(orgId: string) {
    for (const threadId of new Set(await runs.activeThreadIds())) {
      const thread = await threads.find(threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!space || space.orgId !== orgId) continue;
      await queue.admission.dropRefused(threadId);
      if (!(await runsIn(space))) await stop({ threadId }, null);
    }
  }
  options.hooks?.on("org.personalSpacesChanged", async ({ orgId, allowed }) => {
    if (!allowed) await accessChanged(orgId);
  });
  options.hooks?.on("org.membersSettled", async ({ orgId }) => accessChanged(orgId));
  options.hooks?.on("space.accessChanged", async ({ orgId }) => accessChanged(orgId));
  options.hooks?.on("org.deleting", async ({ orgId, by }) => {
    await stop({ orgId }, by);
  });

  // What an input enqueued sets going, in the write that enqueues it.
  queue.onEnqueued(async (input) => {
    await advance(input.threadId, { input });
  });

  // A run waiting on its calls goes on once none of them waits any more.
  calls.onSettled(async (call) => {
    if (call.background) return;
    const run = await runs.find(call.runId);
    if (run?.status !== "waiting") return;
    if (await calls.waits({ id: run.id, threadId: run.threadId, branchId: run.branchId })) return;
    if (await runs.resume(run.id)) signals.wake(run.threadId);
  });

  // A worker as a server process starts it, sharing these stores; one more than this instance's
  // stands for another instance's, under a name of its own.
  function makeWorker(more: Partial<RunWorkerOptions> = {}, instanceId = options.instanceId) {
    return createRunWorker({
      ...options,
      instanceId,
      before: async (thread) => {
        const read: ModelMessage[] = [];
        for (const one of contributions) if (one.before) read.push(...(await one.before(thread)));
        return read;
      },
      reopens: async (thread) => {
        const told: Notice[] = [];
        for (const one of contributions) told.push(...((await one.reopens?.(thread)) ?? []));
        return told;
      },
      guidance: async (space, offered, thread, toolsNow) => {
        let guidance: Guidance = { org: "", space: "" };
        for (const one of contributions) {
          if (one.guidance) {
            guidance = {
              ...guidance,
              ...(await one.guidance(space, offered, thread, toolsNow, guidance)),
            };
          }
        }
        return guidance;
      },
      advance: async (threadId, opts) => advance(threadId, opts),
      ended: async (run, next) => {
        for (const listener of endedListeners) await listener(run, next);
      },
      endKept: async (run) => {
        for (const listener of keptListeners) await listener(run);
      },
      parentOf: async (threadId) => (await threads.find(threadId))?.parentThreadId ?? null,
      stranded: async () => queue.stranded(),
      ...options.overrides,
      ...more,
    });
  }
  const worker = makeWorker();

  return {
    advance,
    stop,

    // Whether compacting the thread, asked for now, has something to do: a run under way to wait
    // for, or earlier messages to summarise.
    async compactable(threadId: string) {
      if (await runs.active(threadId)) return true;
      return anythingToCompact((await options.transcripts.of(threadId)).transcript().rows);
    },

    // A person's stop: the thread's run under way, and silently those of the subagents its agent
    // started; the agent keeps what it has written. Refused when nothing was under way.
    async stopBy(reader: Reader) {
      const { thread } = reader;
      const by = reader.principal.userId;
      const own = (await stop({ threadId: thread.id }, by)).length > 0;
      let theirs = false;
      for (const child of await threads.children(thread.id)) {
        // Only the subagents this thread's agent started, not theirs.
        if (child.parentThreadId !== thread.id) continue;
        if ((await stop({ threadId: child.id }, by, { silent: true })).length > 0) theirs = true;
      }
      if (!own && !theirs) throw new ServiceError(409, "The agent is not replying");
      signals.changed({ threadId: thread.id });
    },

    // Starts a run that tries the thread's last run again, when it failed or was stopped and
    // nothing has run since.
    async retry(reader: Reader, runId: string) {
      const { thread } = reader;
      const { events } = await log.write(thread.id, async (append) => {
        if (await runs.active(thread.id))
          throw new ServiceError(409, "The agent is already replying");
        const last = await runs.latest(thread.id);
        if (last?.id !== runId || (last.status !== "failed" && last.status !== "cancelled")) {
          throw new ServiceError(409, "Only the last reply can be tried again");
        }
        await startRun(runs, append, {
          threadId: thread.id,
          wokenBySeq: last.wokenBySeq,
          createdBy: reader.principal.userId,
          continuesRunId: last.id,
          reason: "retry",
        });
      });
      signals.wake(thread.id);
      return { event: events[0]! };
    },

    // Starts the run of a branch just made, inside the write that makes it: it takes in again the
    // messages kept from where it starts, then the edited message, if any.
    async rewrite(
      threadId: string,
      branchId: string,
      input: {
        by: string;
        wokenBySeq: number;
        keep: readonly string[];
        message?: QueuedInput | null;
        asked?: { model: string; effort: Effort | null } | null;
      },
    ) {
      return (
        await log.write(
          threadId,
          async (append) => {
            const run = await startRun(runs, append, {
              threadId,
              branchId,
              wokenBySeq: input.message?.seq ?? input.wokenBySeq,
              createdBy: input.by,
              reason: "rewrite",
              askedModel: input.asked?.model ?? null,
              askedEffort: input.asked?.effort ?? null,
            });
            await queue.admission.admit(
              run,
              { ids: input.message ? [input.message.id] : [] },
              { kept: input.keep },
            );
            return run;
          },
          branchId,
        )
      ).result;
    },

    // The run under way on the thread's current branch, if any.
    state: async (threadId: string) => runs.active(threadId),
    // The runs under way in the threads named, each thread's current branch's after any other's.
    states: async (threadIds: string[]) => runs.activeIn(threadIds),

    contribute(contribution: Contribution) {
      contributions.push(contribution);
    },

    gate(gate: (threadId: string) => Promise<boolean>) {
      gates.push(gate);
    },

    // Hears of each run that ended, with the run that follows it, inside the write that ends it.
    onEnded(listener: (run: Run, next: Run | null) => Promise<void>) {
      endedListeners.push(listener);
    },

    // Hears of each run whose end is kept, after the write that ended it: for what reads other
    // threads, which that write does not hold.
    onEndKept(listener: (run: Run) => Promise<void>) {
      keptListeners.push(listener);
    },

    worker,
    makeWorker,
  };
}

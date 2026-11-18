// Tool calls from asked for to ended, the only writer of the call table and of a call's events.
// A run asks for calls; each is recorded with where it stands, runs at once, waits for a person's
// decision, or waits for answers when it asks questions. People decide, answer, move a call to the
// background or cancel a job; each is one guarded change of the call's row with its event, and
// whatever waits on the call hears of it in the same write. A run's call runs under the run's
// lease and every write it makes is fenced by it; a call moved to the background goes on as a job,
// fenced by the job's own lease from then on. A move asked for while the call runs is kept in the
// call's row: the instance running it acts on it when it hears so, and at the latest on its next
// beat. What is decided about each call, who may decide it and whether a decision still holds, is
// the tools' authority over the call's row, whose words the thread's agent read and the vouches
// its branch holds, all read inside the write they guard.

import { context, trace } from "@opentelemetry/api";
import * as z from "zod";

import type { Reader } from "@/server/access/access.ts";
import type { Live } from "@/server/calls/live.ts";
import type {
  AnyToolSpec,
  CallPresentation,
  DeferredTool,
  ModelNames,
  SpaceTools,
  ToolContext,
  ToolNames,
  ToolOutput,
  Tools,
  People,
  Vouch,
} from "@/server/tools/registry.ts";
import { type CallStates, lastWriter } from "@/server/tools/registry.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { ModelToolCall } from "@/server/models/gateway.ts";
import type { Queue, Word } from "@/server/queue/queue.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import { LeaseLost } from "@/server/sync/lease.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { AfterCommit, Sync } from "@/server/sync/sync.ts";
import type { Append, ThreadLog } from "@/server/threads/log.ts";
import type { NewEvent, Thread, ThreadStore } from "@/server/threads/types.ts";
import { influenceOf } from "./influence.ts";
import { type AskAnswers, askInputSchema, answersProblem } from "@/shared/ask.ts";
import type { EventDataMap, ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import { notOnYet } from "@/server/tools/search.ts";
import { wireToolName } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";

import { callWork, createJobs } from "./jobs.ts";
import { approvedNow, CallPaused, judge, ranData, spanEnded, toolSpan } from "./lifecycle.ts";
import { createScripts } from "./scripts.ts";
import type { CallStatus } from "./schema.ts";
import type { CallRow, CallStore } from "./store.ts";
import { type CallRecord, callRecords } from "./views.ts";

export { callWork, CALLS_GUIDANCE, RESULT_CHARS, shownStatus } from "./jobs.ts";

export type Call = CallRow;

// The run that asks for calls.
export interface RunRef {
  id: string;
  threadId: string;
  branchId: string;
}

// The run a call is made for, held by the caller: `hold` throws LeaseLost once the run's lease no
// longer holds; `ref` is the model it replies with.
export interface RunHold {
  run: RunRef;
  hold(): Promise<unknown>;
  ref: string | null;
}

// What the step that decides calls read of its thread and space at its start: what the space had
// of tools, and of them those the thread's agent may call. A change made during the step takes
// effect at the next.
export interface CallContext {
  thread: Thread;
  space: Space;
  now: SpaceTools;
  offered: AnyToolSpec[];
}

// What the step that asks for calls read besides: the server tools left out of the request and not
// turned on, and what each tool is called, by people and by the model.
export interface RequestContext extends CallContext {
  left: DeferredTool[];
  titles: (toolId: string) => ToolNames | null;
  names: ModelNames;
}

// A call that may run now, with how: whose login it goes with, the standing approval it runs on
// and who approved it.
export interface Runnable {
  call: CallRecord;
  spec: AnyToolSpec;
  input: unknown;
  runAs: string | null;
  standingOn?: string;
  approvedBy?: string;
}

// What a run's call runs with beyond the call: the run's stop, what the thread's next model call
// would send, and for the search of left-out tools, those tools and how they are turned on.
export interface CallEnv {
  signal: AbortSignal;
  threadRequest: NonNullable<ToolContext["threadRequest"]>;
  named: ToolContext["named"];
  deferral: () => Promise<{ all: DeferredTool[]; on: ReadonlySet<string> }>;
  turnOn: (callId: string, ids: string[]) => Promise<void>;
}

// A call that waits for a person, with whether the reader may act on it.
export interface WaitingCall {
  call: Call;
  row: CallRecord;
  waitsFor: "decision" | "answer";
  canAct: boolean;
  // The risk its tool's policy gives it now.
  risk: ToolRisk;
}

export interface CallsOptions {
  store: CallStore;
  threads: Pick<ThreadStore, "find" | "findAll" | "eventsAt" | "lastRan" | "results">;
  spaceStore: Pick<SpaceStore, "find">;
  log: ThreadLog;
  signals: Signals;
  queue: Pick<Queue, "enqueue" | "words" | "spoke">;
  logger: Logger;
  afterCommit: AfterCommit;
  tools: Pick<
    Tools,
    | "toolsIn"
    | "offered"
    | "evaluate"
    | "approvalHolds"
    | "rulesIn"
    | "answerHolds"
    | "riskOf"
    | "namesNow"
    | "modelNames"
    | "textNamer"
    | "fromServers"
    | "run"
    | "callState"
    | "callStates"
    | "connectionFor"
    | "asks"
    | "movable"
    | "turnedOn"
  >;
  // Where running calls say what they print, for the people watching; nowhere when not given.
  live?: Pick<Live, "open" | "close" | "end" | "keep" | "of" | "moved">;
  instanceId: string;
  keeper: Sync["keeper"];
  transact: Sync["transact"];
  claimDue: Sync["claimDue"];
  // Why the thread may no longer run work, as a subagent's archived; null while it may.
  retired?: (thread: Thread) => Promise<string | null>;
  leaseMs?: number;
  now?: () => Date;
}

export type Calls = ReturnType<typeof createCalls>;

// What a call is judged again with: its thread and space, their tools now, the model it is judged
// under, and the authority of its branch.
interface Judging {
  thread: Thread;
  space: Space;
  now: SpaceTools;
  model: string | null;
  authority: { words(): Promise<Word[]>; vouches(): Promise<Vouch[]>; people: People };
}

const ACTOR = { kind: "agent" } as const;

// What a call moved to the background gives back to the run in place of its result.
const MOVED = Symbol("moved");

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : "The model did not answer.";
}

// Whether a call has not been settled yet.
function open(row: Pick<ToolRow, "state">) {
  return row.state === "waiting" || row.state === "ready";
}

export function createCalls(options: CallsOptions) {
  const { store, threads, spaceStore, log, signals, logger } = options;
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;
  const settledListeners: ((call: Call) => Promise<void>)[] = [];
  // The run's calls running here, by thread and id, each with what moves it to the background.
  const running = new Map<string, { threadId: string; id: string; move(): void }>();
  const key = (threadId: string, id: string) => `${threadId} ${id}`;
  let unsubscribe: (() => void)[] = [];

  const jobs = createJobs({
    store,
    ...(options.retired && { retired: options.retired }),
    threads,
    spaceStore,
    log,
    queue: options.queue,
    logger,
    afterCommit: options.afterCommit,
    tools: options.tools,
    ...(options.live && { live: options.live }),
    instanceId: options.instanceId,
    keeper: options.keeper,
    transact: options.transact,
    claimDue: options.claimDue,
    leaseMs,
    now,
    beat: async () => moveAsked([...running.values()]),
  });

  const scripts = createScripts({
    threads,
    spaceStore,
    logger,
    tools: options.tools,
    now,
    // What a script's calls are judged with, and how they are recorded.
    steps: {
      words: async (threadId, branchId) => options.queue.words(threadId, branchId),
      vouches: async (threadId, branchId) => store.vouches(threadId, branchId),
      judge: async (ask) => judge(options.tools, ask),
      requested: async (row) => (await store.insert([row]))[0]!,
      ran,
      async pause(threadId, callId, kept) {
        const paused = await store.pause(threadId, callId, kept);
        // What it printed stays for those watching while it waits; it prints it again as it goes on.
        if (paused) await options.live?.keep(threadId, callId, kept.printed);
        return paused;
      },
      async resumeOf(threadId, callId) {
        const pause = await store.takePause(threadId, callId);
        const made = await store.made(threadId, callId);
        const rows = await store.findAll(
          threadId,
          (pause?.waiting ?? []).map((one) => one.callId),
        );
        const records = await callRecords(threads, threadId, rows);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const waitedOn = new Map<number, { row: Call; record: CallRecord }>();
        for (const { future, callId: id } of pause?.waiting ?? []) {
          const row = byId.get(id);
          const record = records.get(id);
          if (row && record) waitedOn.set(future, { row, record });
        }
        return { pause, made: made.count, waitedOn };
      },
      start: async (threadId, callId) => store.start(threadId, callId),
      allow: async (threadId, callId) => store.allow(threadId, callId, null, "once"),
      cancelBelow: async (append, threadId, ids) => jobs.cancelBelow(append, threadId, ids, false),
      drop: async (append, call, reason) => unrun(append, call, reason),
      approvedNow: async (ask) => approvedNow(options.tools, ask),
    },
  });

  // A move asked of a call running here is acted on as soon as its thread is woken, as the
  // request wakes it; the keeper's beat finds one whose hint was missed.
  signals.onWake((threadId) => {
    const here = [...running.values()].filter((one) => one.threadId === threadId);
    if (here.length === 0) return;
    void moveAsked(here).catch((err: unknown) => logger.error({ err }, "move not checked"));
  });

  // Moves the calls running here that someone asked to move.
  async function moveAsked(calls: { threadId: string; id: string }[]) {
    for (const asked of await store.moveAsked(calls)) {
      running.get(key(asked.threadId, asked.id))?.move();
    }
  }

  // Tells the listeners, inside the write under way, that the call no longer waits.
  async function settled(call: Call) {
    for (const listener of settledListeners) await listener(call);
  }

  // Whose words the branch's agent read and the vouches for now it holds, read once when asked.
  function authorityOf(threadId: string, branchId: string) {
    let words: ReturnType<Queue["words"]> | undefined;
    let vouches: ReturnType<CallStore["vouches"]> | undefined;
    return {
      words: async () => (words ??= options.queue.words(threadId, branchId)),
      vouches: async () => (vouches ??= store.vouches(threadId, branchId)),
      // Each person read once for the calls judged together.
      people: new Map() as People,
    };
  }

  // The thread's call where its current branch reads it, as authority reads it.
  async function recordOf(threadId: string, callId: string) {
    const row = await store.onCurrent(threadId, callId);
    const record = row && (await callRecords(threads, threadId, [row])).get(callId);
    return row && record ? { row, record } : null;
  }

  // Records a run's call's result, and ends its row as it says.
  async function ran(
    append: (event: NewEvent) => Promise<unknown>,
    threadId: string,
    data: EventDataMap["tool.ran"],
  ) {
    await append({ type: "tool.ran", actor: ACTOR, data });
    await (data.ok ? store.complete : store.fail)(threadId, data.callId);
  }

  // Whether the waiting call still waits for a person, judged again as things stand: one that
  // came to need nobody is let run by whatever starts it, the run or the call that made it, in
  // the write that starts it. Nothing is written here. One that asks always waits for its answer.
  async function stillWaits(call: CallRecord, offered: readonly AnyToolSpec[], judging: Judging) {
    const spec = offered.find((one) => one.name === call.toolId);
    const parsed = spec?.input.safeParse(call.input);
    if (!spec || !parsed?.success || spec.waitsFor === "answer") return true;
    const { authority } = judging;
    const decision = await judge(options.tools, {
      words: await authority.words(),
      vouches: await authority.vouches(),
      thread: judging.thread,
      space: judging.space,
      spec,
      input: parsed.data,
      model: judging.model,
      now: judging.now,
      people: authority.people,
    });
    return decision.kind === "wait";
  }

  // The jobs paused at calls of their own that no longer need anyone, judged together as things
  // stand; nothing is written, the job lets them run as it goes on.
  async function freedJobs(threadId: string) {
    const waiting = await store.waitingUnderJobs(threadId);
    if (waiting.length === 0) return [];
    const thread = await threads.find(threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) return [];
    const now = await options.tools.toolsIn(space);
    const offered = await options.tools.offered(space, thread, now);
    const records = await callRecords(threads, threadId, waiting);
    const authority = authorityOf(threadId, thread.currentBranchId);
    const held = new Set<string>();
    for (const row of waiting) {
      const record = records.get(row.id);
      const judging = { thread, space, now, model: row.model, authority };
      if (!record || (await stillWaits(record, offered, judging))) held.add(row.parentId!);
    }
    return [...new Set(waiting.map((row) => row.parentId!))].filter((id) => !held.has(id));
  }

  // Ends an open call that will not run, saying why, inside the write under way; a paused script
  // drops where it stood.
  async function unrun(
    append: (event: NewEvent) => Promise<unknown>,
    call: { threadId: string; id: string; runId: string; toolId: string },
    reason: "stale" | "cancelled",
    // Whether what it made ends here too; the caller ending many ends theirs together.
    below = true,
  ) {
    const ended =
      reason === "stale"
        ? await store.goStale(call.threadId, call.id)
        : await store.cancel(call.threadId, call.id);
    if (!ended) return;
    await options.live?.end(call.id);
    await append({
      type: "tool.denied",
      actor: ACTOR,
      data: { runId: call.runId, callId: call.id, reason },
    });
    // And what it made, but for jobs, which run on.
    if (below) await jobs.cancelBelow(append, call.threadId, [call.id], false);
  }

  // A write for the run, made only while the caller holds it.
  async function held<T>(hold: RunHold, work: (append: Append) => Promise<T>) {
    return (
      await log.write(
        hold.run.threadId,
        async (append) => {
          await hold.hold();
          return work(append);
        },
        hold.run.branchId,
      )
    ).result;
  }

  return {
    // Records the calls a model step asked for, each with whether it waits for a decision or an
    // answer. A call of a tool not offered, or left out of the request and not turned on, or with
    // input the tool does not take, fails at once.
    async request(
      hold: RunHold,
      asked: (ModelToolCall & { messageId: string })[],
      ctx: RequestContext,
    ) {
      const { run } = hold;
      const { thread, space, now, offered, left, titles: named } = ctx;
      return held(hold, async (append) => {
        const authority = authorityOf(run.threadId, run.branchId);
        const tools = options.tools;
        const made: Parameters<CallStore["insert"]>[0] = [];
        for (const call of asked) {
          const { callId, toolId, input, messageId } = call;
          const unsearched = left.find((tool) => tool.id === toolId);
          const spec = unsearched ? undefined : offered.find((one) => one.name === toolId);
          const parsed = spec && spec.input.safeParse(input);
          const ok = !!spec && !!parsed?.success;
          const risk: ToolRisk = ok
            ? await tools.riskOf(space, spec, parsed.data, hold.ref, now)
            : "normal";
          // A call that asks always waits for its answer.
          const answers = ok && spec.waitsFor === "answer";
          const waits =
            ok &&
            (answers ||
              (
                await judge(tools, {
                  words: await authority.words(),
                  vouches: await authority.vouches(),
                  thread,
                  space,
                  spec,
                  input: parsed.data,
                  model: hold.ref,
                  now,
                  people: authority.people,
                })
              ).kind === "wait");
          const names = named(toolId);
          const requested = await append({
            type: "tool.requested",
            actor: ACTOR,
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
          made.push({
            threadId: run.threadId,
            id: callId,
            branchId: run.branchId,
            seq: requested.seq,
            runId: run.id,
            toolId,
            risk,
            status: !ok ? "failed" : waits ? "waiting" : "ready",
            waitsFor: waits ? (answers ? "answer" : "decision") : null,
            background: false,
            model: hold.ref,
          });
          if (ok) continue;
          await append({
            type: "tool.ran",
            actor: ACTOR,
            data: {
              runId: run.id,
              callId,
              ok: false,
              error: unsearched
                ? notOnYet(unsearched.id, ctx.names.toModel)
                : spec
                  ? `The input is not valid: ${z.prettifyError(parsed!.error!)}`
                  : `No tool is named ${wireToolName(ctx.names.toModel(toolId))} here.`,
              ms: 0,
            },
          });
        }
        return store.insert(made);
      });
    },

    // The run's first open call that may run now, after marking stale those whose approval no
    // longer holds or whose tool is gone; "wait" when none may and some wait for a person.
    async next(hold: RunHold, ctx: CallContext): Promise<Runnable | "wait" | null> {
      const { run } = hold;
      const { thread, space, now, offered } = ctx;
      return held(hold, async (append) => {
        const authority = authorityOf(run.threadId, run.branchId);
        let waiting = false;
        const tools = options.tools;
        const left = (await store.openFor(run.threadId, run.id)).filter((row) => !row.background);
        const records = await callRecords(threads, run.threadId, left);
        const judging = { thread, space, now, model: hold.ref, authority };
        // A call another made is the caller's to run; one that still waits holds its caller paused.
        const paused = new Set<string>();
        for (const row of left) {
          const record = records.get(row.id);
          if (!row.parentId || row.status !== "waiting" || !record) continue;
          if (await stillWaits(record, offered, judging)) paused.add(row.parentId);
        }
        if (paused.size > 0) waiting = true;
        const calls = left
          .filter((row) => !row.parentId && !paused.has(row.id))
          .toSorted((a, b) => a.seq - b.seq)
          .flatMap((row) => {
            const record = records.get(row.id);
            return record && open(record) ? [record] : [];
          });
        for (const call of calls) {
          const spec = offered.find((one) => one.name === call.toolId);
          const parsed = spec && spec.input.safeParse(call.input);
          let allowed = false;
          // Whose own login it goes with, for a tool that uses one, and the standing approval it
          // runs on, if any.
          let runAs: string | null = null;
          let standingOn: string | undefined;
          let approvedBy: string | undefined;
          if (spec && parsed?.success && spec.waitsFor === "answer") {
            // A call that asks runs once answered, while the answer holds.
            if (call.state === "waiting" || !call.decision) {
              waiting = true;
              continue;
            }
            allowed = await tools.answerHolds(call, await authority.words(), thread, space, now);
          } else if (spec && parsed?.success) {
            const { decision } = call;
            if (call.state === "ready" && decision) {
              const approved = await approvedNow(tools, {
                call: { ...call, decision },
                words: await authority.words(),
                thread,
                space,
                spec,
                input: parsed.data,
                model: hold.ref,
                now,
              });
              allowed = !!approved;
              if (approved) ({ runAs, approvedBy } = approved);
            } else {
              const decision = await judge(tools, {
                words: await authority.words(),
                vouches: await authority.vouches(),
                thread,
                space,
                spec,
                input: parsed.data,
                model: hold.ref,
                now,
                people: authority.people,
              });
              allowed = decision.kind !== "wait";
              if (!allowed && call.waits) {
                waiting = true;
                continue;
              }
              if (decision.kind !== "wait") runAs = decision.runAs ?? null;
              if (decision.kind === "standing") standingOn = decision.callId;
              // One that waited and no longer needs anyone stands ready, decided by nobody.
              if (allowed && call.state === "waiting") {
                await store.allow(run.threadId, call.id, null, "once");
              }
            }
          }
          if (allowed) {
            return {
              call,
              spec: spec!,
              input: parsed!.data as unknown,
              runAs,
              ...(standingOn && { standingOn }),
              ...(approvedBy && { approvedBy }),
            };
          }
          await unrun(append, { ...call, threadId: run.threadId }, "stale");
        }
        return waiting ? ("wait" as const) : null;
      });
    },

    // Runs the call under the run's hold: it stands running while the tool runs between writes,
    // then its result is recorded. One asked to move to the background goes on as a job under its
    // own id from then on, and the run reads that it moved.
    async run(next: Runnable, hold: RunHold, env: CallEnv) {
      const { run } = hold;
      const { call, spec, input, runAs, standingOn, approvedBy } = next;
      // Heard of from before it stands running, so no move asked of it is missed.
      const toBackground = new Promise<typeof MOVED>((resolve) => {
        if (spec.movable === false || spec.waitsFor === "answer") return;
        running.set(key(run.threadId, call.id), {
          threadId: run.threadId,
          id: call.id,
          move: () => resolve(MOVED),
        });
      });
      try {
        await held(hold, async () => {
          if (!(await store.start(run.threadId, call.id))) {
            throw new Error(`call ${call.id} is not ready to run`);
          }
        });
      } catch (err) {
        running.delete(key(run.threadId, call.id));
        throw err;
      }
      const started = now().getTime();
      const thread = await threads.find(run.threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!thread || !space) throw new LeaseLost(`run ${run.id}`);
      // The search for left-out tools is given them, and turns them on for the rest of the thread.
      const deferral = spec.deferral === "search" ? await env.deferral() : null;
      const span = toolSpan(call.toolId, call.id, input);
      // The call has a stop of its own, which the run's stop reaches until it is moved.
      const controller = new AbortController();
      const stopCall = () => controller.abort(env.signal.reason);
      if (env.signal.aborted) stopCall();
      env.signal.addEventListener("abort", stopCall, { once: true });
      // The job it becomes, once moved, whose lease fences its writes from then on.
      let job: Call | null = null;
      let output: ToolOutput;
      // Whose words the model had read when it asked for the call.
      const influence = influenceOf(await options.queue.words(run.threadId, run.branchId));
      try {
        const work = context.with(trace.setSpan(context.active(), span), () =>
          options.tools.run(spec, input, {
            threadId: run.threadId,
            spaceId: space.id,
            orgId: space.orgId,
            runId: run.id,
            callId: call.id,
            actor: ACTOR,
            model: hold.ref,
            runAs,
            ...(approvedBy && { approvedBy }),
            influence,
            signal: controller.signal,
            ...(options.live && {
              // Stored while the call runs under the run's lease, then once moved, while this
              // instance holds the job's.
              live: options.live.open(run.threadId, call.id, async () => {
                const row = await store.find(run.threadId, call.id);
                if (row?.status !== "running") return false;
                if (row.background) return await jobs.holds(jobs.leaseOf(row));
                try {
                  await hold.hold();
                  return true;
                } catch (err) {
                  if (!(err instanceof LeaseLost)) throw err;
                  return false;
                }
              }),
            }),
            ...(call.answers && { answers: call.answers }),
            threadRequest: env.threadRequest,
            named: env.named,
            ...(deferral && {
              deferred: {
                tools: deferral.all,
                on: deferral.on,
                turnOn: async (ids: string[]) => env.turnOn(call.id, ids),
              },
            }),
            // Fenced by the run's lease, or once moved, by the job's.
            write: async (work) =>
              job
                ? (await jobs.fenced(jobs.leaseOf(job), work)).result
                : await held(hold, async (append) => work(append)),
          }),
        );
        const result = await Promise.race([work, toBackground]);
        if (result === MOVED) {
          env.signal.removeEventListener("abort", stopCall);
          job = await held(hold, async (append) => {
            const moved = await store.toBackground(run.threadId, call.id, {
              owner: options.instanceId,
              leaseMs,
            });
            if (!moved) return null;
            await append({
              type: "tool.moved",
              actor: ACTOR,
              data: { runId: run.id, callId: call.id, ms: Math.max(0, now().getTime() - started) },
            });
            return moved;
          });
          if (job) {
            await options.live?.moved(run.threadId, job.id);
            jobs.follow(job, controller, work, new Date(started));
            output = { ok: true, value: { movedToBackground: true, callId: job.id } };
          } else {
            // It ended meanwhile: what it gives back is its run's.
            env.signal.addEventListener("abort", stopCall, { once: true });
            if (env.signal.aborted) stopCall();
            output = await work;
          }
        } else {
          output = result;
        }
      } catch (err) {
        if (err instanceof LeaseLost) {
          span.end();
          throw err;
        }
        // Paused, it stays open and is not recorded.
        if (err instanceof CallPaused) {
          span.end();
          return;
        }
        logger.warn({ err, runId: run.id, toolId: call.toolId }, "tool failed");
        output = { ok: false, error: messageOf(err) };
      } finally {
        running.delete(key(run.threadId, call.id));
        if (!job) {
          env.signal.removeEventListener("abort", stopCall);
          options.live?.close(call.id);
        }
      }
      spanEnded(span, output);
      if (job) return;
      const ms = Math.max(0, now().getTime() - started);
      await held(hold, async (append) => {
        // What it printed while it ran goes as its result is recorded.
        await options.live?.end(call.id);
        await ran(
          append,
          run.threadId,
          ranData(run.id, call.id, output, ms, { ...(standingOn && { standingOn }) }),
        );
      });
    },

    // The ended run's calls that had not ended will not run, inside the write that ends it.
    async closeFor(run: RunRef, append: Append) {
      const left = await store.openFor(run.threadId, run.id);
      if (left.length === 0) return;
      for (const call of left.toSorted((a, b) => a.seq - b.seq)) {
        await unrun(append, call, "cancelled", false);
      }
      // And what they made, but for jobs, which run on past the run.
      await jobs.cancelBelow(
        append,
        run.threadId,
        left.map((call) => call.id),
        false,
      );
    },

    // Approves or denies a call waiting for a decision. The first decision wins; a call that no
    // longer waits is no longer needed.
    async decide(reader: Reader, callId: string, decision: { allow: boolean; scope: ToolScope }) {
      const { thread } = reader;
      const space = await spaceStore.find(thread.spaceId);
      if (!space) throw new ServiceError(404, "Thread not found");
      const userId = reader.principal.userId;
      const { events, result } = await log.write(thread.id, async (append) => {
        const found = await recordOf(thread.id, callId);
        if (!found) throw new ServiceError(404, "Tool call not found");
        const { row, record: call } = found;
        const live = row.background ? row.status === "waiting" : isOpen(row.status);
        if (!live) throw new ServiceError(409, "No longer needed");
        const tools = options.tools;
        const words = await options.queue.words(thread.id);
        const state = await tools.callState(userId, call, words, thread, space, row.model);
        if (state.waitsFor === "answer")
          throw new ServiceError(409, "This call waits for an answer");
        if (state.waitsFor !== "decision") throw new ServiceError(409, "Already decided");
        if (!state.canAct) {
          const independent = state.risk === "review" && lastWriter(words) === userId;
          throw new ServiceError(
            403,
            independent
              ? "Independent approval needs someone other than the author of the latest message"
              : "Only this tool's approvers can decide",
          );
        }
        if (decision.allow && decision.scope === "for_now" && state.risk !== "normal") {
          throw new ServiceError(400, "This call can only be allowed once");
        }
        // A call allowed runs with its approver's own login, where its tool uses one.
        const connection = await tools.connectionFor(space, call.toolId, userId, call.input);
        if (decision.allow && connection && !connection.connected) {
          throw new ServiceError(409, `Connect to ${connection.title} first`);
        }
        const actor = { kind: "user" as const, userId };
        const decided = await append(
          decision.allow
            ? {
                type: "tool.approved",
                actor,
                data: { runId: call.runId, callId, scope: decision.scope },
              }
            : { type: "tool.denied", actor, data: { runId: call.runId, callId, reason: "denied" } },
        );
        const moved = decision.allow
          ? await store.allow(thread.id, callId, userId, decision.scope, decided.seq)
          : await store.deny(thread.id, callId, userId, decided.seq);
        if (!moved) throw new ServiceError(409, "Already decided");
        if (moved.background && !decision.allow) {
          await jobs.notify(moved, "was denied.");
        }
        await settled(moved);
        // A job paused at calls that the decision leaves needing nobody goes on, as a run would.
        const freed = await freedJobs(thread.id);
        options.afterCommit(() => {
          for (const id of freed) void jobs.proceed(thread.id, id).catch(() => {});
        });
        return moved;
      });
      // The wake has the keeper sweep at once, here and elsewhere, which starts a job approved.
      signals.wake(thread.id);
      return { runId: result.runId, event: events[0]! };
    },

    // Answers the questions a call waits on, or with null skips them. Anyone who may use or
    // approve the tool may; the first answer wins.
    async answer(reader: Reader, callId: string, answers: AskAnswers | null) {
      const { thread } = reader;
      const space = await spaceStore.find(thread.spaceId);
      if (!space) throw new ServiceError(404, "Thread not found");
      const userId = reader.principal.userId;
      const { events, result } = await log.write(thread.id, async (append) => {
        const found = await recordOf(thread.id, callId);
        if (!found) throw new ServiceError(404, "Tool call not found");
        const { row, record: call } = found;
        const tools = options.tools;
        if (!(await tools.asks(call, space))) throw new ServiceError(409, "This call asks nothing");
        if (!isOpen(row.status)) throw new ServiceError(409, "No longer needed");
        const words = await options.queue.words(thread.id);
        const state = await tools.callState(userId, call, words, thread, space, row.model);
        if (state.waitsFor !== "answer") throw new ServiceError(409, "Already answered");
        if (!state.canAct) {
          throw new ServiceError(403, "Only people who can use this tool here can answer");
        }
        const asked = askInputSchema.safeParse(call.input);
        const problem = answers && asked.success && answersProblem(asked.data.questions, answers);
        if (problem) throw new ServiceError(400, problem);
        const actor = { kind: "user" as const, userId };
        const given = await append(
          answers
            ? { type: "tool.answered", actor, data: { runId: call.runId, callId, answers } }
            : {
                type: "tool.denied",
                actor,
                data: { runId: call.runId, callId, reason: "skipped" },
              },
        );
        const moved = answers
          ? await store.allow(thread.id, callId, userId, "once", given.seq)
          : await store.skip(thread.id, callId, userId, given.seq);
        if (!moved) throw new ServiceError(409, "Already answered");
        // An answer is its writer's words, which the agent reads.
        if (answers) await options.queue.spoke(thread.id, given.seq);
        await settled(moved);
        return moved;
      });
      signals.wake(thread.id);
      return { runId: result.runId, event: events[0]! };
    },

    // Moves a run's call to the background: one waiting for a decision goes on at once as a job
    // that waits for the same decision, and the run goes on; one running is asked to move, which
    // its holder does.
    async toJob(reader: Reader, callId: string) {
      const { thread } = reader;
      const space = await spaceStore.find(thread.spaceId);
      if (!space) throw new ServiceError(404, "Thread not found");
      await log.write(thread.id, async (append) => {
        const found = await recordOf(thread.id, callId);
        if (!found) throw new ServiceError(404, "Tool call not found");
        const { row, record: call } = found;
        if (!open(call)) throw new ServiceError(409, "This call is no longer running");
        if (row.background || call.within || !(await options.tools.movable(call, space))) {
          throw new ServiceError(409, "This call cannot move to the background");
        }
        if (call.state === "waiting") {
          // Waiting in a run nobody holds: it goes on as a job that waits for the same decision,
          // and the run goes on as if it no longer waited.
          if (row.status !== "waiting" || !(await store.toBackground(thread.id, callId))) {
            throw new ServiceError(409, "No longer needed");
          }
          await append({
            type: "tool.moved",
            actor: ACTOR,
            data: { runId: call.runId, callId: call.id, ms: 0 },
          });
          await settled(row);
          return;
        }
        if (!(await store.requestMove(thread.id, callId))) {
          throw new ServiceError(409, "This call is not running yet");
        }
      });
      signals.wake(thread.id);
    },

    // Stops a job that runs, waits its turn or waits for a decision, as a person asked.
    async cancel(reader: Reader, callId: string) {
      const job = await store.find(reader.thread.id, callId);
      if (!job?.background) throw new ServiceError(404, "Call not found");
      if (!(await jobs.cancel(job, reader.principal.userId)))
        throw new ServiceError(409, "This call has ended");
    },

    async find(threadId: string, callId: string) {
      return store.find(threadId, callId);
    },

    // Whether one of the run's own calls still waits for a person, as judged now.
    async waits(run: RunRef) {
      const waiting = (await store.openFor(run.threadId, run.id)).filter(
        (call) => call.status === "waiting" && !call.background,
      );
      if (waiting.length === 0) return false;
      const thread = await threads.find(run.threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!thread || !space) return true;
      const now = await options.tools.toolsIn(space);
      const offered = await options.tools.offered(space, thread, now);
      const records = await callRecords(threads, run.threadId, waiting);
      const authority = authorityOf(run.threadId, run.branchId);
      for (const row of waiting) {
        const record = records.get(row.id);
        const judging = { thread, space, now, model: row.model, authority };
        if (!record || (await stillWaits(record, offered, judging))) return true;
      }
      return false;
    },

    // The calls of the threads that wait for a person, as their rows say.
    waitingIn: async (threadIds: readonly string[]) => store.waiting(threadIds),

    // The calls of the threads that wait for a person, each with whether the reader may act on it.
    async waitingOn(
      reader: { userId: string; states?: CallStates },
      threadIds: readonly string[],
    ): Promise<WaitingCall[]> {
      const waiting = await store.waiting(threadIds);
      const found: WaitingCall[] = [];
      const byThread = Map.groupBy(waiting, (call) => call.threadId);
      // Their threads, and each space they are in, read once for them all.
      const threadsOf = new Map(
        (await threads.findAll([...byThread.keys()])).map((thread) => [thread.id, thread]),
      );
      const spaces = new Map<string, Awaited<ReturnType<typeof spaceStore.find>>>();
      // The tools of each space and the reader in each thread tree, read once for them all.
      const states = reader.states ?? options.tools.callStates(reader.userId);
      for (const [threadId, calls] of byThread) {
        const thread = threadsOf.get(threadId);
        if (thread && !spaces.has(thread.spaceId)) {
          spaces.set(thread.spaceId, await spaceStore.find(thread.spaceId));
        }
        const space = thread && spaces.get(thread.spaceId);
        if (!thread || !space) continue;
        const records = await callRecords(threads, threadId, calls);
        const words = await options.queue.words(threadId);
        for (const call of calls) {
          const row = records.get(call.id);
          if (!row) continue;
          const state = await states.of(row, words, thread, space, call.model);
          found.push({
            call,
            row,
            waitsFor: call.waitsFor ?? "decision",
            canAct: state.canAct,
            risk: state.risk,
          });
        }
      }
      return found;
    },

    // Hears, inside the write, of each call that stops waiting for a person.
    onSettled(listener: (call: Call) => Promise<void>) {
      settledListeners.push(listener);
    },

    // The thread's jobs, newest first.
    jobsIn: async (threadId: string) => store.jobs(threadId),

    toolset: () => jobs.toolset(),
    scriptsToolset: () => scripts.toolset(),

    // A job's card, on whichever call it is, as the reader sees it: the thread's jobs read once.
    async present(reader: Reader, rows: readonly ToolRow[]) {
      const jobs = rows.some((row) => row.background)
        ? new Map((await store.jobs(reader.thread.id)).map((job) => [job.id, job]))
        : new Map<string, Call>();
      const canPost = reader.can("post");
      return (row: ToolRow): CallPresentation | undefined => {
        const job = row.background ? jobs.get(row.id) : undefined;
        return job ? { work: callWork(job, canPost), live: true } : undefined;
      };
    },

    // The rows of a log copied into the thread, as the log says each stands.
    async fromLog(threadId: string) {
      await store.fromLog(threadId);
    },

    // Ends the jobs other instances left behind.
    recover: async () => jobs.recover(),

    // Keeps the leases of the jobs running here, and ends those others left, now and as time goes
    // on; a thread woken, or a gap in what was heard, has them looked at at once.
    async start() {
      if (unsubscribe.length > 0) return;
      await jobs.start();
      unsubscribe = [signals.onWake(() => void jobs.beat()), signals.onGap(() => void jobs.beat())];
    },

    // A beat of the keeper now, as one comes on its own.
    beat: async () => jobs.beat(),

    // Stops the jobs running here and lets them go, and closes the scripts' sandbox.
    async stop() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      await jobs.stop();
      await scripts.stop();
    },
  };
}

// Whether the call has not ended.
function isOpen(status: CallStatus) {
  return status === "ready" || status === "waiting" || status === "running";
}

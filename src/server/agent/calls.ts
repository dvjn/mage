// Background calls: tool calls that run on beside the agent, started by it or moved there from a
// run that was waiting on them, each with an id the agent checks, lists and cancels it by. A call
// meets the same rules as one made directly: it runs at once, or waits as a call of its own for
// someone to approve it, with the approval the same as for any call, which a run does not wait on.
// When one ends, the thread's agent is notified with its result, cut to a cap, as the people whose
// words steered it carry it. A call that was left running by a stopped server ends as interrupted.
// Only a few of a thread's calls run or wait at once.

import { ulid } from "ulid";
import * as z from "zod";

import type { Lease } from "@/server/sync/lease.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { Sync } from "@/server/sync/sync.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { SpaceStore } from "@/server/spaces/service.ts";
import type { Append, ThreadLog } from "@/server/threads/log.ts";
import type { NewEvent, Thread, ThreadStore } from "@/server/threads/service.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import { wireToolName } from "@/shared/tools.ts";
import {
  BACKGROUND_LIMIT,
  type BackgroundWork,
  CALLS_TOOLSET,
  type CallStatus,
  START_CALL,
} from "@/shared/calls.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";
import type { ToolRow } from "@/shared/transcript.ts";

import type { Live } from "./live.ts";
import type { Notifier } from "./notifications.ts";
import type { RunStore } from "./runs.ts";
import { steeringIn } from "./subagents.ts";
import type { AnyToolSpec, ToolOutput, Tools, Toolset, ToolSpec } from "./tools.ts";
import { findAsync } from "@/server/kernel/async.ts";

export interface CallRecord {
  id: string;
  threadId: string;
  // The run that started it, or whose call was moved to the background.
  runId: string;
  toolId: string;
  input: unknown;
  status: CallStatus;
  createdAt: Date;
  endedAt: Date | null;
  // The instance running it, while it runs, until when, and how many times it was taken.
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  leaseEpoch: number;
}

// The right to carry out a running call, held by one server instance.
export interface CallLease extends Lease {
  callId: string;
}

export interface CallStore {
  // Running ones are held under `lease` from the start.
  create(
    call: Omit<
      CallRecord,
      "createdAt" | "endedAt" | "leaseOwner" | "leaseExpiresAt" | "leaseEpoch"
    >,
    lease?: { owner: string; leaseMs: number },
  ): Promise<CallRecord>;
  find(id: string): Promise<CallRecord | null>;
  // The thread's calls, newest first.
  inThread(threadId: string): Promise<CallRecord[]>;
  // The thread's calls that are running or wait for approval.
  open(threadId: string): Promise<CallRecord[]>;
  // Runs a call that waited for approval, held by the owner; null when it no longer waits.
  start(id: string, owner: string, leaseMs: number): Promise<CallRecord | null>;
  // Extends the lease; false when it no longer holds, as when the call was stopped or taken over.
  renew(lease: CallLease, leaseMs: number): Promise<boolean>;
  // Ends a running call under its lease; false when the lease no longer holds.
  finish(lease: CallLease, fields: Pick<CallRecord, "status" | "endedAt">): Promise<boolean>;
  // Ends the lease now, for whoever looks next to find the call left behind.
  expire(lease: CallLease): Promise<void>;
  // Running calls whose lease ran out.
  stale(): Promise<CallRecord[]>;
  // Marks a stale call interrupted, unless another did first; null then.
  interrupt(id: string, at: Date): Promise<CallRecord | null>;
  // Stops a call that runs or waits; null when it had ended already.
  cancel(id: string, at: Date): Promise<CallRecord | null>;
  update(id: string, fields: Partial<Pick<CallRecord, "status" | "endedAt">>): Promise<void>;
}

// The longest a call's result runs in the notification that tells of it.
export const RESULT_CHARS = 20_000;

// What the agent is told about them.
export const CALLS_GUIDANCE =
  "Start a tool call with jobs.start when it is slow or independent of what you do next; you get an id at once and its result arrives as a notification. Start several, keep working, and end your turn to wait rather than polling; use jobs.check only when a decision depends on it. Cancel what you no longer need with jobs.cancel.";

export interface CallsOptions {
  calls: CallStore;
  threads: Pick<ThreadStore, "find">;
  transcripts: Pick<Transcripts, "of" | "whole">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "find" | "toolsOn">;
  log: ThreadLog;
  bus: Signals;
  logger: Logger;
  // The tools; given when needed, since they include these.
  tools: () => Pick<
    Tools,
    | "offered"
    | "evaluate"
    | "approvalHolds"
    | "riskOf"
    | "namesNow"
    | "modelNames"
    | "fromServers"
    | "run"
  >;
  // The tools the thread's agent may call of those its space offers; all of them when not given.
  narrow?: (thread: Thread, offered: AnyToolSpec[]) => Promise<AnyToolSpec[]>;
  notifier: Notifier;
  // Where running calls say what they print, for the people watching; nowhere when not given.
  live?: Pick<Live, "open" | "move" | "moved" | "close" | "end" | "of">;
  // Names this server instance in the leases it takes on the calls it runs.
  instanceId: string;
  // Keeps those leases.
  keeper: Sync["keeper"];
  leaseMs?: number;
  now?: () => Date;
}

export type Calls = ReturnType<typeof createCalls>;

// A background call as its card and the tray show it, and whether the reader may stop it.
export function callWork(record: CallRecord, canPost: boolean): BackgroundWork {
  return {
    kind: "call",
    status: record.status,
    startedAt: record.createdAt.toISOString(),
    ...(record.endedAt && { endedAt: record.endedAt.toISOString() }),
    canCancel: canPost && (record.status === "running" || record.status === "pending"),
  };
}

// What a call that is moved to the background carries on with.
export interface Adoption {
  threadId: string;
  runId: string;
  // The id it had in its run.
  callId: string;
  toolId: string;
  input: unknown;
  risk: ToolRisk;
  title?: string;
  toolset?: string;
  work: Promise<ToolOutput>;
  controller: AbortController;
  started: Date;
}

const ACTOR = { kind: "agent" } as const;

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

export function createCalls(options: CallsOptions) {
  const { calls, threads, transcripts, spaceStore, runs, log, bus, logger } = options;
  const now = options.now ?? (() => new Date());
  const narrow = options.narrow ?? ((_thread: Thread, offered: AnyToolSpec[]) => offered);
  const { notifier } = options;
  const owner = options.instanceId;
  const leaseMs = options.leaseMs ?? 30_000;
  // The calls running here, by id, each with what stops it and the lease it runs under.
  const live = new Map<string, { controller: AbortController; lease: CallLease }>();
  let started = false;
  let unsubscribe: (() => void)[] = [];

  function leaseOf(record: CallRecord): CallLease {
    return { callId: record.id, owner, epoch: record.leaseEpoch };
  }

  // Whether this instance still carries the call out under the lease.
  async function holds(lease: CallLease) {
    const now = await calls.find(lease.callId);
    return now?.leaseOwner === lease.owner && now.leaseEpoch === lease.epoch;
  }

  // Ends the calls a stopped server left running, telling their threads' agents: those whose
  // lease ran out. Another instance may be running the rest.
  async function recover() {
    for (const record of await calls.stale()) {
      try {
        const interrupted = await settle(
          record,
          async () => calls.interrupt(record.id, now()),
          async (append) => {
            await closeRow(record, append, {
              ok: false,
              error: "The server stopped while the call ran.",
            });
            await notify(
              record,
              `Background call ${record.id} (${record.toolId}) was interrupted: the server stopped while it ran.`,
            );
          },
        );
        if (!interrupted) continue;
        live.get(record.id)?.controller.abort(new Error("interrupted"));
        live.delete(record.id);
      } catch (err) {
        logger.warn({ err, callId: record.id }, "interrupted call not recorded");
      }
    }
  }

  // Keeps the leases of the calls running here, and stops those whose lease no longer holds, as
  // when someone stopped the call through another instance; then ends those others left behind.
  const keeper = options.keeper({
    name: "jobs",
    everyMs: leaseMs / 3,
    held: () => live.keys(),
    renew: async (id: string) => {
      const held = live.get(id);
      return !held || (await calls.renew(held.lease, leaseMs));
    },
    onLost: (id: string) => {
      live.get(id)?.controller.abort(new Error("cancelled"));
      live.delete(id);
    },
    sweep: recover,
  });

  async function contextOf(threadId: string) {
    const thread = await threads.find(threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) throw new ToolRefusal("The thread is gone.");
    return { thread, space };
  }

  async function rowsOf(threadId: string) {
    return (await transcripts.of(threadId)).transcript().rows;
  }

  async function titleOf(space: { id: string; orgId: string }, toolId: string) {
    return (await options.tools().namesNow(space))(toolId)?.title ?? toolId;
  }

  // The call's row in its thread's log, which holds what it was asked and gave back.
  async function rowOf(record: CallRecord) {
    return (await rowsOf(record.threadId)).find(
      (one): one is ToolRow => one.kind === "tool" && one.id === record.id,
    );
  }

  // The model that replied in the run that started the call.
  async function modelOf(record: CallRecord) {
    return (await runs.find(record.runId))?.model ?? null;
  }

  // Whose words steered the call: those the agent had read when it was asked for.
  async function steeringOf(record: CallRecord) {
    const rows = await rowsOf(record.threadId);
    const at = rows.findIndex((row) => row.id === record.id);
    return steeringIn(at === -1 ? rows : rows.slice(0, at));
  }

  // Closes the call's row if it is still open, as it was left: ran with its result, or stopped.
  // The log records the call; its row in the table says only where it stands.
  async function closeRow(
    record: CallRecord,
    append: Append,
    output: ToolOutput | "stopped",
    ms = 0,
    extra = {},
  ) {
    // What it printed while it ran goes as its end is recorded.
    await options.live?.end(record.id);
    // A stop is written whatever the row, so readers see where the call stands.
    if (output === "stopped") {
      await append({
        type: "tool.denied",
        actor: ACTOR,
        data: { runId: record.id, callId: record.id, reason: "stopped" },
      });
      return;
    }
    const row = await rowOf(record);
    if (!row || (row.state !== "pending" && row.state !== "allowed")) return;
    await append({
      type: "tool.ran",
      actor: ACTOR,
      data: {
        runId: record.id,
        callId: record.id,
        ms,
        ...(output.ok ? { ok: true, value: output.value } : { ok: false, error: output.error }),
        ...extra,
      },
    });
  }

  // Moves the call on in one write: `change` to its row in the table, which holds only while the
  // call stands as it was, then `record` in the log, the agent told along with it. So the table
  // and the log never disagree. False when the change no longer held.
  async function settle(
    record: CallRecord,
    change: () => Promise<unknown>,
    write: (append: Append) => Promise<void>,
  ) {
    const { result } = await log.write(record.threadId, async (append) => {
      if (!(await change())) return false;
      await write(append);
      return true;
    });
    if (result) bus.wake(record.threadId);
    return result;
  }

  // The call's row in the log. It goes under its own id as its run, so that no run of the thread
  // counts it among its own calls: it neither waits for it nor stops it when it ends.
  async function requested(
    append: (event: NewEvent) => Promise<unknown>,
    call: {
      id: string;
      toolId: string;
      input: unknown;
      risk: ToolRisk;
      waits: boolean;
      names?: { title?: string; toolset?: string | null } | null;
    },
  ) {
    const { id, names } = call;
    await append({
      type: "tool.requested",
      actor: ACTOR,
      data: {
        runId: id,
        callId: id,
        messageId: "",
        toolId: call.toolId,
        input: call.input,
        risk: call.risk,
        waits: call.waits,
        background: true,
        ...(names?.title && { title: names.title }),
        ...(names?.toolset && { toolset: names.toolset }),
      },
    });
  }

  // Tells the thread's agent how the call ended.
  async function notify(record: CallRecord, text: string, result?: string) {
    const thread = await threads.find(record.threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    if (!thread || !space) return;
    await notifier.send(thread.id, {
      kind: "call.ended",
      source: {
        threadId: thread.id,
        name: await titleOf(space, record.toolId),
        main: true,
        callId: record.id,
      },
      actor: { kind: "source", label: await titleOf(space, record.toolId), type: "job" },
      text,
      people: await steeringOf(record),
      ...(result && { last: result }),
    });
  }

  // Ends the call with its output, unless it ended already or is no longer this instance's, and
  // tells the agent.
  async function end(id: string, output: ToolOutput, started: Date, extra: object = {}) {
    const held = live.get(id);
    live.delete(id);
    const record = await calls.find(id);
    if (!held || !record) {
      // Ended elsewhere, with what it printed.
      options.live?.close(id);
      return;
    }
    const ms = Math.max(0, now().getTime() - started.getTime());
    const status = output.ok ? ("done" as const) : ("failed" as const);
    try {
      await settle(
        record,
        async () => calls.finish(held.lease, { status, endedAt: now() }),
        async (append) => {
          await closeRow(record, append, output, ms, extra);
          await notify(
            record,
            `Background call ${id} (${await titleOf((await contextOf(record.threadId)).space, record.toolId)}) ${output.ok ? "finished" : "failed"}`,
            resultText(output),
          );
        },
      );
    } catch (err) {
      logger.warn({ err, callId: id }, "background call end not recorded");
    }
  }

  // Runs the call now, held here, and ends it when it is done.
  async function launch(
    record: CallRecord,
    spec: AnyToolSpec,
    runAs: string | null,
    extra: object = {},
    approvedBy?: string,
  ) {
    const { thread, space } = await contextOf(record.threadId);
    const controller = new AbortController();
    const lease = leaseOf(record);
    live.set(record.id, { controller, lease });
    const started = now();
    let work: Promise<ToolOutput>;
    try {
      work = Promise.resolve(
        options.tools().run(spec, record.input, {
          threadId: thread.id,
          spaceId: space.id,
          orgId: space.orgId,
          runId: record.id,
          callId: record.id,
          background: true,
          actor: ACTOR,
          model: await modelOf(record),
          runAs,
          ...(approvedBy && { approvedBy }),
          signal: controller.signal,
          ...(options.live && {
            live: options.live.open(thread.id, record.id, async () => holds(lease)),
          }),
          write: async (work) =>
            (await log.write(thread.id, async (append) => work(append))).result,
        }),
      );
    } catch (err) {
      work = Promise.reject(err);
    }
    void work.then(
      async (output) => end(record.id, output, started, extra),
      async (err: unknown) => {
        logger.warn({ err, callId: record.id, toolId: record.toolId }, "background call failed");
        await end(record.id, { ok: false, error: messageOf(err) }, started, extra);
      },
    );
  }

  // The tool the agent may call by this name, for a background call.
  async function specFor(thread: Thread, space: { id: string; orgId: string }, toolId: string) {
    const tools = options.tools();
    const wanted =
      (await tools.modelNames(space)).fromModel(toolId) ??
      (
        await findAsync(
          await tools.offered(space),
          async (one) =>
            one.name === toolId ||
            wireToolName((await tools.modelNames(space)).toModel(one.name)) === toolId,
        )
      )?.name ??
      toolId;
    const spec = (await narrow(thread, await tools.offered(space))).find(
      (one) => one.name === wanted,
    );
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
    if (left && !(await runs.toolsOn(thread.id)).some((tool) => tool.id === spec.name)) {
      throw new ToolRefusal(
        `${toolId} is not on yet. Search for it or select it with tools.search first.`,
      );
    }
    return spec;
  }

  async function mine(id: string, threadId: string) {
    const record = await calls.find(id);
    if (!record || record.threadId !== threadId) throw new ToolRefusal(`No call has the id ${id}.`);
    return record;
  }

  async function summaryOf(record: CallRecord) {
    const { thread, space } = await contextOf(record.threadId);
    const row = await rowOf(record);
    const output = row && (await transcripts.whole([row]))[0]!.output;
    // What a running call has printed so far, its end cut to the cap, and how far it has come.
    const printed = record.status === "running" ? await options.live?.of(record.id) : null;
    return {
      id: record.id,
      tool: await titleOf(space, record.toolId),
      toolId: record.toolId,
      status: record.status,
      ...(output?.ok && { result: resultText(output) }),
      ...(output && !output.ok && { error: output.error }),
      ...(printed?.progress && { progress: printed.progress }),
      ...(printed?.text && { output: printed.text.slice(-RESULT_CHARS) }),
      startedAt: record.createdAt.toISOString(),
      ...(record.endedAt && { endedAt: record.endedAt.toISOString() }),
      thread: thread.id,
    };
  }

  // Stops the call: it runs no more and tells nobody. Run elsewhere, the instance running it stops
  // it once its lease no longer holds. False when it had ended already.
  async function stop(record: CallRecord) {
    const stopped = await settle(
      record,
      async () => calls.cancel(record.id, now()),
      async (append) => closeRow(record, append, "stopped"),
    );
    if (!stopped) return false;
    live.get(record.id)?.controller.abort(new Error("cancelled"));
    live.delete(record.id);
    return true;
  }

  const start: ToolSpec<{ tool: string; input?: Record<string, unknown> }> = {
    name: START_CALL,
    modelName: "jobs.start",
    title: "Start",
    annotations: { readOnlyHint: false },
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
          if ((await calls.open(thread.id)).length >= BACKGROUND_LIMIT) {
            throw new ToolRefusal(
              `This thread has ${BACKGROUND_LIMIT} background calls running or waiting. Wait for some to end or cancel them.`,
            );
          }
          const tools = options.tools();
          const rows = await rowsOf(thread.id);
          const decision = await tools.evaluate(
            rows,
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
          const record = await ctx.write(async (append) => {
            const made = await calls.create(
              {
                id,
                threadId: thread.id,
                runId: ctx.runId,
                toolId: spec.name,
                input: parsed.data,
                status: waits ? "pending" : "running",
              },
              waits ? undefined : { owner, leaseMs },
            );
            await requested(append, {
              id,
              toolId: spec.name,
              input: parsed.data,
              risk,
              waits,
              names,
            });
            return made;
          });
          if (!waits) {
            await launch(
              record,
              spec,
              decision.runAs ?? null,
              decision.kind === "standing" ? { standingOn: decision.callId } : {},
            );
          }
          return { id, status: record.status };
        }),
      );
    },
  };

  const status: ToolSpec<{ id: string }> = {
    name: "calls.status",
    modelName: "jobs.check",
    title: "Status",
    annotations: { readOnlyHint: true },
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
    description: "This thread's background calls, newest first, without their results.",
    input: z.object({}).strict() as z.ZodType<Record<string, never>>,
    risk: () => "normal",
    run(_input, ctx) {
      return Promise.resolve(
        refusing(async () => ({
          calls: await Promise.all(
            (await calls.inThread(ctx.threadId)).map(async (record) => {
              const {
                result: _result,
                error: _error,
                output: _output,
                ...rest
              } = await summaryOf(record);
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
    description: "Stop a background call that is running or waiting for approval.",
    input: z.object({ id: z.string().min(1).meta({ title: "Id" }) }),
    risk: () => "normal",
    run({ id }, ctx) {
      return Promise.resolve(
        refusing(async () => {
          const record = await mine(id, ctx.threadId);
          if (!(await stop(record))) {
            throw new ToolRefusal(
              `Call ${id} already ${(await calls.find(id))?.status ?? "ended"}.`,
            );
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

    find: async (id: string) => calls.find(id),

    // Whether the thread has room for another call running or waiting.
    room: async (threadId: string) => (await calls.open(threadId)).length < BACKGROUND_LIMIT,

    // A call a person approved or denied while it waited: a denied one ends and the agent is told;
    // an approved one runs, if the approval still holds.
    async proceed(threadId: string, callId: string, allow: boolean) {
      const record = await calls.find(callId);
      if (!record || record.threadId !== threadId || record.status !== "pending") return;
      const { thread, space } = await contextOf(threadId);
      const tools = options.tools();
      const rows = await rowsOf(threadId);
      const row = rows.find((one): one is ToolRow => one.kind === "tool" && one.id === callId);
      const spec = (await narrow(thread, await tools.offered(space))).find(
        (one) => one.name === record.toolId,
      );
      const parsed = spec && spec.input.safeParse(record.input);
      const holds =
        allow &&
        !!row &&
        !!spec &&
        !!parsed?.success &&
        (await tools.approvalHolds(
          row,
          rows,
          thread,
          space,
          await tools.riskOf(space, spec, parsed.data, await modelOf(record)),
        ));
      if (!holds || !spec) {
        await settle(
          record,
          async () => calls.cancel(callId, now()),
          async (append) => {
            if (allow) {
              await append({
                type: "tool.denied",
                actor: ACTOR,
                data: { runId: callId, callId, reason: "stale" },
              });
            }
            await notify(
              record,
              `Background call ${callId} (${record.toolId}) was ${allow ? "not allowed to run: its approval no longer held" : "denied"}.`,
            );
          },
        );
        return;
      }
      // Another instance may have taken the decision up first.
      const started = await calls.start(callId, owner, leaseMs);
      if (!started) return;
      const runAs = (await spec.connection?.(record.input, space))
        ? (row.decision?.by.userId ?? null)
        : null;
      await launch(started, spec, runAs, {}, row.decision?.by.userId);
    },

    // Stops a call that is running or waiting for approval, as a person asked.
    async cancel(threadId: string, callId: string) {
      const record = await calls.find(callId);
      if (!record || record.threadId !== threadId) throw new ServiceError(404, "Call not found");
      if (!(await stop(record))) throw new ServiceError(409, "This call has ended");
    },

    // Moves a call that waits for approval in a run to the background, as a call of its own that
    // waits for the same decision, and gives the run its id as the call's result. Returns the id.
    async detach(
      threadId: string,
      call: {
        id: string;
        runId: string;
        toolId: string;
        input: unknown;
        risk: ToolRisk;
        title?: string;
        toolset?: string;
      },
      append: Append,
    ) {
      const id = ulid();
      await calls.create({
        id,
        threadId,
        runId: call.runId,
        toolId: call.toolId,
        input: call.input,
        status: "pending",
      });
      await requested(append, { ...call, id, waits: true, names: call });
      await append({
        type: "tool.ran",
        actor: ACTOR,
        data: {
          runId: call.runId,
          callId: call.id,
          ok: true,
          value: { movedToBackground: true, callId: id },
          ms: 0,
        },
      });
      return id;
    },

    // Takes over a call that was running in a run, as a call of its own beside it that goes on and
    // ends as any does, and returns its id. The run's call says it moved there.
    async adopt(call: Adoption) {
      const id = ulid();
      const record = (
        await log.write(call.threadId, async (append) => {
          const made = await calls.create(
            {
              id,
              threadId: call.threadId,
              runId: call.runId,
              toolId: call.toolId,
              input: call.input,
              status: "running",
            },
            { owner, leaseMs },
          );
          await requested(append, { ...call, id, waits: false, names: call });
          // What it printed so far goes on with it.
          const lease = leaseOf(made);
          await options.live?.move(call.callId, id, async () => holds(lease));
          return made;
        })
      ).result;
      live.set(record.id, { controller: call.controller, lease: leaseOf(record) });
      await options.live?.moved(call.threadId, id);
      void call.work.then(
        async (output) => end(record.id, output, call.started),
        async (err: unknown) => {
          logger.warn({ err, callId: record.id, toolId: record.toolId }, "background call failed");
          await end(record.id, { ok: false, error: messageOf(err) }, call.started);
        },
      );
      return id;
    },

    recover,

    // Keeps the leases of the calls running here, and ends those other instances left behind, now
    // and as time goes on. A thread woken, or a gap in what was heard, has them checked at once.
    async start() {
      if (started) return;
      started = true;
      await keeper.start();
      const beat = () => void keeper.beat();
      unsubscribe = [bus.onWake(beat), bus.onGap(beat)];
    },

    // Stops the calls running here and lets them go, to be ended as interrupted by whoever looks
    // next.
    async stop() {
      started = false;
      await keeper.stop();
      for (const stop of unsubscribe) stop();
      unsubscribe = [];
      for (const [id, held] of live) {
        live.delete(id);
        held.controller.abort(new Error("shutdown"));
        await calls.expire(held.lease);
      }
    },
  };
}

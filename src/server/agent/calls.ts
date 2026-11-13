// Background calls: tool calls that run on beside the agent, started by it or moved there from a
// run that was waiting on them, each with an id the agent checks, lists and cancels it by. A call
// meets the same rules as one made directly: it runs at once, or waits as a call of its own for
// someone to approve it, with the approval the same as for any call, which a run does not wait on.
// When one ends, the thread's agent is notified with its result, cut to a cap, as the people whose
// words steered it carry it. A call that was left running by a stopped server ends as interrupted.
// Only a few of a thread's calls run or wait at once.

import { ulid } from "ulid";
import * as z from "zod";

import type { Lease } from "@/server/db/lease.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
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
    lease?: { owner: string; expiresAt: Date },
  ): CallRecord;
  find(id: string): CallRecord | null;
  // The thread's calls, newest first.
  inThread(threadId: string): CallRecord[];
  // The thread's calls that are running or wait for approval.
  open(threadId: string): CallRecord[];
  // Runs a call that waited for approval, held by the owner; null when it no longer waits.
  start(id: string, owner: string, expiresAt: Date): CallRecord | null;
  // Extends the lease; false when it no longer holds, as when the call was stopped or taken over.
  renew(lease: CallLease, expiresAt: Date): boolean;
  // Ends a running call under its lease; false when the lease no longer holds.
  finish(lease: CallLease, fields: Pick<CallRecord, "status" | "endedAt">): boolean;
  // Ends the lease now, for whoever looks next to find the call left behind.
  expire(lease: CallLease): void;
  // Running calls whose lease expired before `before`.
  stale(before: Date): CallRecord[];
  // Marks a stale call interrupted, unless another did first; null then.
  interrupt(id: string, before: Date, at: Date): CallRecord | null;
  // Stops a call that runs or waits; null when it had ended already.
  cancel(id: string, at: Date): CallRecord | null;
  update(id: string, fields: Partial<Pick<CallRecord, "status" | "endedAt">>): void;
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
  bus: EventBus;
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
  narrow?: (thread: Thread, offered: AnyToolSpec[]) => AnyToolSpec[];
  notifier: Notifier;
  // Where running calls say what they print, for the people watching; nowhere when not given.
  live?: Pick<Live, "open" | "move" | "moved" | "close" | "end" | "of">;
  // Names this server instance in the leases it takes on the calls it runs.
  instanceId?: string;
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

function refusing<T>(work: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: work() };
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
  const owner = options.instanceId ?? ulid();
  const leaseMs = options.leaseMs ?? 30_000;
  // The calls running here, by id, each with what stops it and the lease it runs under.
  const live = new Map<string, { controller: AbortController; lease: CallLease }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  function expiry() {
    return new Date(now().getTime() + leaseMs);
  }

  function leaseOf(record: CallRecord): CallLease {
    return { callId: record.id, owner, epoch: record.leaseEpoch };
  }

  // Whether this instance still carries the call out under the lease.
  function holds(lease: CallLease) {
    const now = calls.find(lease.callId);
    return now?.leaseOwner === lease.owner && now.leaseEpoch === lease.epoch;
  }

  // Keeps the leases of the calls running here, and stops those whose lease no longer holds, as
  // when someone stopped the call through another instance.
  function renew(threadId?: string) {
    for (const [id, held] of live) {
      if (threadId && calls.find(id)?.threadId !== threadId) continue;
      if (calls.renew(held.lease, expiry())) continue;
      live.delete(id);
      held.controller.abort(new Error("cancelled"));
    }
  }

  function contextOf(threadId: string) {
    const thread = threads.find(threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) throw new ToolRefusal("The thread is gone.");
    return { thread, space };
  }

  function rowsOf(threadId: string) {
    return transcripts.of(threadId).transcript().rows;
  }

  function titleOf(space: { id: string; orgId: string }, toolId: string) {
    return options.tools().namesNow(space)(toolId)?.title ?? toolId;
  }

  // The call's row in its thread's log, which holds what it was asked and gave back.
  function rowOf(record: CallRecord) {
    return rowsOf(record.threadId).find(
      (one): one is ToolRow => one.kind === "tool" && one.id === record.id,
    );
  }

  // The model that replied in the run that started the call.
  function modelOf(record: CallRecord) {
    return runs.find(record.runId)?.model ?? null;
  }

  // Whose words steered the call: those the agent had read when it was asked for.
  function steeringOf(record: CallRecord) {
    const rows = rowsOf(record.threadId);
    const at = rows.findIndex((row) => row.id === record.id);
    return steeringIn(at === -1 ? rows : rows.slice(0, at));
  }

  // Closes the call's row if it is still open, as it was left: ran with its result, or stopped.
  // The log records the call; its row in the table says only where it stands.
  function closeRow(
    record: CallRecord,
    append: Append,
    output: ToolOutput | "stopped",
    ms = 0,
    extra = {},
  ) {
    // What it printed while it ran goes as its end is recorded.
    options.live?.end(record.id);
    // A stop is written whatever the row, so readers see where the call stands.
    if (output === "stopped") {
      append({
        type: "tool.denied",
        actor: ACTOR,
        data: { runId: record.id, callId: record.id, reason: "stopped" },
      });
      return;
    }
    const row = rowOf(record);
    if (!row || (row.state !== "pending" && row.state !== "allowed")) return;
    append({
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
  function settle(record: CallRecord, change: () => unknown, write: (append: Append) => void) {
    const { result } = log.write(record.threadId, (append) => {
      if (!change()) return false;
      write(append);
      return true;
    });
    if (result) bus.wake(record.threadId);
    return result;
  }

  // The call's row in the log. It goes under its own id as its run, so that no run of the thread
  // counts it among its own calls: it neither waits for it nor stops it when it ends.
  function requested(
    append: (event: NewEvent) => unknown,
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
    append({
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
  function notify(record: CallRecord, text: string, result?: string) {
    const thread = threads.find(record.threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) return;
    notifier.send(thread.id, {
      kind: "call.ended",
      source: {
        threadId: thread.id,
        name: titleOf(space, record.toolId),
        main: true,
        callId: record.id,
      },
      actor: { kind: "source", label: titleOf(space, record.toolId), type: "job" },
      text,
      people: steeringOf(record),
      ...(result && { last: result }),
    });
  }

  // Ends the call with its output, unless it ended already or is no longer this instance's, and
  // tells the agent.
  function end(id: string, output: ToolOutput, started: Date, extra: object = {}) {
    const held = live.get(id);
    live.delete(id);
    const record = calls.find(id);
    if (!held || !record) {
      // Ended elsewhere, with what it printed.
      options.live?.close(id);
      return;
    }
    const ms = Math.max(0, now().getTime() - started.getTime());
    const status = output.ok ? ("done" as const) : ("failed" as const);
    try {
      settle(
        record,
        () => calls.finish(held.lease, { status, endedAt: now() }),
        (append) => {
          closeRow(record, append, output, ms, extra);
          notify(
            record,
            `Background call ${id} (${titleOf(contextOf(record.threadId).space, record.toolId)}) ${output.ok ? "finished" : "failed"}`,
            resultText(output),
          );
        },
      );
    } catch (err) {
      logger.warn({ err, callId: id }, "background call end not recorded");
    }
  }

  // Runs the call now, held here, and ends it when it is done.
  function launch(
    record: CallRecord,
    spec: AnyToolSpec,
    runAs: string | null,
    extra: object = {},
    approvedBy?: string,
  ) {
    const { thread, space } = contextOf(record.threadId);
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
          model: modelOf(record),
          runAs,
          ...(approvedBy && { approvedBy }),
          signal: controller.signal,
          ...(options.live && {
            live: options.live.open(thread.id, record.id, () => holds(lease)),
          }),
          write: (work) => log.write(thread.id, (append) => work(append)).result,
        }),
      );
    } catch (err) {
      work = Promise.reject(err);
    }
    void work.then(
      (output) => end(record.id, output, started, extra),
      (err: unknown) => {
        logger.warn({ err, callId: record.id, toolId: record.toolId }, "background call failed");
        end(record.id, { ok: false, error: messageOf(err) }, started, extra);
      },
    );
  }

  // The tool the agent may call by this name, for a background call.
  function specFor(thread: Thread, space: { id: string; orgId: string }, toolId: string) {
    const tools = options.tools();
    const wanted =
      tools.modelNames(space).fromModel(toolId) ??
      tools
        .offered(space)
        .find(
          (one) =>
            one.name === toolId ||
            wireToolName(tools.modelNames(space).toModel(one.name)) === toolId,
        )?.name ??
      toolId;
    const spec = narrow(thread, tools.offered(space)).find((one) => one.name === wanted);
    if (!spec) throw new ToolRefusal(`No tool is named ${toolId} here.`);
    if (spec.name.startsWith(`${CALLS_TOOLSET}.`)) {
      throw new ToolRefusal("A background call cannot start another.");
    }
    if (spec.waitsFor === "answer") {
      throw new ToolRefusal("A tool that asks cannot run in the background.");
    }
    const left = tools
      .fromServers(space, tools.modelNames(space))
      .some((tool) => tool.id === spec.name);
    if (left && !runs.toolsOn(thread.id).some((tool) => tool.id === spec.name)) {
      throw new ToolRefusal(
        `${toolId} is not on yet. Search for it or select it with tools.search first.`,
      );
    }
    return spec;
  }

  function mine(id: string, threadId: string) {
    const record = calls.find(id);
    if (!record || record.threadId !== threadId) throw new ToolRefusal(`No call has the id ${id}.`);
    return record;
  }

  function summaryOf(record: CallRecord) {
    const { thread, space } = contextOf(record.threadId);
    const row = rowOf(record);
    const output = row && transcripts.whole([row])[0]!.output;
    // What a running call has printed so far, its end cut to the cap, and how far it has come.
    const printed = record.status === "running" ? options.live?.of(record.id) : null;
    return {
      id: record.id,
      tool: titleOf(space, record.toolId),
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
  function stop(record: CallRecord) {
    const stopped = settle(
      record,
      () => calls.cancel(record.id, now()),
      (append) => closeRow(record, append, "stopped"),
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
        refusing(() => {
          const { thread, space } = contextOf(ctx.threadId);
          const spec = specFor(thread, space, input.tool);
          const parsed = spec.input.safeParse(input.input ?? {});
          if (!parsed.success) {
            throw new ToolRefusal(`The input is not valid: ${z.prettifyError(parsed.error)}`);
          }
          if (calls.open(thread.id).length >= BACKGROUND_LIMIT) {
            throw new ToolRefusal(
              `This thread has ${BACKGROUND_LIMIT} background calls running or waiting. Wait for some to end or cancel them.`,
            );
          }
          const tools = options.tools();
          const rows = rowsOf(thread.id);
          const decision = tools.evaluate(
            rows,
            thread,
            space,
            spec.name,
            spec.risk(parsed.data, { model: ctx.model, orgId: space.orgId }),
            parsed.data,
          );
          const waits = decision.kind === "wait";
          const risk = tools.riskOf(space, spec, parsed.data, ctx.model);
          const names = tools.namesNow(space)(spec.name);
          const id = ulid();
          const record = ctx.write((append) => {
            const made = calls.create(
              {
                id,
                threadId: thread.id,
                runId: ctx.runId,
                toolId: spec.name,
                input: parsed.data,
                status: waits ? "pending" : "running",
              },
              waits ? undefined : { owner, expiresAt: expiry() },
            );
            requested(append, { id, toolId: spec.name, input: parsed.data, risk, waits, names });
            return made;
          });
          if (!waits) {
            launch(
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
      return Promise.resolve(refusing(() => summaryOf(mine(id, ctx.threadId))));
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
        refusing(() => ({
          calls: calls.inThread(ctx.threadId).map((record) => {
            const { result: _result, error: _error, output: _output, ...rest } = summaryOf(record);
            return rest;
          }),
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
        refusing(() => {
          const record = mine(id, ctx.threadId);
          if (!stop(record)) {
            throw new ToolRefusal(`Call ${id} already ${calls.find(id)?.status ?? "ended"}.`);
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

    find: (id: string) => calls.find(id),

    // Whether the thread has room for another call running or waiting.
    room: (threadId: string) => calls.open(threadId).length < BACKGROUND_LIMIT,

    // A call a person approved or denied while it waited: a denied one ends and the agent is told;
    // an approved one runs, if the approval still holds.
    proceed(threadId: string, callId: string, allow: boolean) {
      const record = calls.find(callId);
      if (!record || record.threadId !== threadId || record.status !== "pending") return;
      const { thread, space } = contextOf(threadId);
      const tools = options.tools();
      const rows = rowsOf(threadId);
      const row = rows.find((one): one is ToolRow => one.kind === "tool" && one.id === callId);
      const spec = narrow(thread, tools.offered(space)).find((one) => one.name === record.toolId);
      const parsed = spec && spec.input.safeParse(record.input);
      const holds =
        allow &&
        !!row &&
        !!spec &&
        !!parsed?.success &&
        tools.approvalHolds(
          row,
          rows,
          thread,
          space,
          tools.riskOf(space, spec, parsed.data, modelOf(record)),
        );
      if (!holds || !spec) {
        settle(
          record,
          () => calls.cancel(callId, now()),
          (append) => {
            if (allow) {
              append({
                type: "tool.denied",
                actor: ACTOR,
                data: { runId: callId, callId, reason: "stale" },
              });
            }
            notify(
              record,
              `Background call ${callId} (${record.toolId}) was ${allow ? "not allowed to run: its approval no longer held" : "denied"}.`,
            );
          },
        );
        return;
      }
      // Another instance may have taken the decision up first.
      const started = calls.start(callId, owner, expiry());
      if (!started) return;
      const runAs = spec.connection?.(record.input, space)
        ? (row.decision?.by.userId ?? null)
        : null;
      launch(started, spec, runAs, {}, row.decision?.by.userId);
    },

    // Stops a call that is running or waiting for approval, as a person asked.
    cancel(threadId: string, callId: string) {
      const record = calls.find(callId);
      if (!record || record.threadId !== threadId) throw new ServiceError(404, "Call not found");
      if (!stop(record)) throw new ServiceError(409, "This call has ended");
    },

    // Moves a call that waits for approval in a run to the background, as a call of its own that
    // waits for the same decision, and gives the run its id as the call's result. Returns the id.
    detach(
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
      calls.create({
        id,
        threadId,
        runId: call.runId,
        toolId: call.toolId,
        input: call.input,
        status: "pending",
      });
      requested(append, { ...call, id, waits: true, names: call });
      append({
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
    adopt(call: Adoption) {
      const id = ulid();
      const record = log.write(call.threadId, (append) => {
        const made = calls.create(
          {
            id,
            threadId: call.threadId,
            runId: call.runId,
            toolId: call.toolId,
            input: call.input,
            status: "running",
          },
          { owner, expiresAt: expiry() },
        );
        requested(append, { ...call, id, waits: false, names: call });
        // What it printed so far goes on with it.
        const lease = leaseOf(made);
        options.live?.move(call.callId, id, () => holds(lease));
        return made;
      }).result;
      live.set(record.id, { controller: call.controller, lease: leaseOf(record) });
      options.live?.moved(call.threadId, id);
      void call.work.then(
        (output) => end(record.id, output, call.started),
        (err: unknown) => {
          logger.warn({ err, callId: record.id, toolId: record.toolId }, "background call failed");
          end(record.id, { ok: false, error: messageOf(err) }, call.started);
        },
      );
      return id;
    },

    // Ends the calls a stopped server left running, telling their threads' agents: those whose
    // lease expired before `before`. Another instance may be running the rest.
    recover(before = now()) {
      for (const record of calls.stale(before)) {
        try {
          const interrupted = settle(
            record,
            () => calls.interrupt(record.id, before, now()),
            (append) => {
              closeRow(record, append, {
                ok: false,
                error: "The server stopped while the call ran.",
              });
              notify(
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
    },

    // Keeps the leases of the calls running here, and ends those other instances left behind, now
    // and as time goes on. A thread woken has its calls here checked at once.
    start() {
      if (timer) return;
      this.recover();
      timer = setInterval(() => {
        try {
          renew();
          this.recover();
        } catch (err) {
          logger.error({ err }, "background call leases not kept");
        }
      }, leaseMs / 3);
      timer.unref();
      unsubscribe = bus.onWake((threadId) => renew(threadId));
    },

    // Stops the calls running here and lets them go, to be ended as interrupted by whoever looks
    // next.
    stop() {
      clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      for (const [id, held] of live) {
        live.delete(id);
        held.controller.abort(new Error("shutdown"));
        calls.expire(held.lease);
      }
    },
  };
}

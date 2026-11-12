// Background calls: tool calls that run on beside the agent, started by it or moved there from a
// run that was waiting on them, each with an id the agent checks, lists and cancels it by. A call
// meets the same rules as one made directly: it runs at once, or waits as a call of its own for
// someone to approve it, with the approval the same as for any call, which a run does not wait on.
// When one ends, the thread's agent is notified with its result, cut to a cap, as the people whose
// words steered it carry it. A call that was left running by a stopped server ends as interrupted.
// Only a few of a thread's calls run or wait at once.

import { ulid } from "ulid";
import * as z from "zod";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { SpaceStore } from "@/server/spaces/service.ts";
import { type Append, eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore } from "@/server/threads/service.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import { wireToolName } from "@/shared/tools.ts";
import { BACKGROUND_LIMIT, CALLS_TOOLSET, type CallStatus, START_CALL } from "@/shared/calls.ts";
import type { Steering, ToolRisk } from "@/shared/threads/events.ts";
import { type ToolRow, transcriptOf } from "@/shared/transcript.ts";

import { createNotifier } from "./notifications.ts";
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
  // The model that replied when it started, and whose words steered it.
  model: string | null;
  steeredBy: Steering[];
  status: CallStatus;
  output: ToolOutput | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface CallStore {
  create(call: Omit<CallRecord, "createdAt" | "endedAt" | "output">): CallRecord;
  find(id: string): CallRecord | null;
  // The thread's calls, newest first.
  inThread(threadId: string): CallRecord[];
  // The thread's calls that are running or wait for approval.
  open(threadId: string): CallRecord[];
  running(): CallRecord[];
  update(id: string, fields: Partial<Pick<CallRecord, "status" | "output" | "endedAt">>): void;
}

// The longest a call's result runs in the notification that tells of it.
export const RESULT_CHARS = 20_000;

// What the agent is told about them.
export const CALLS_GUIDANCE =
  "Start a tool call with jobs.start when it is slow or independent of what you do next; you get an id at once and its result arrives as a notification. Start several, keep working, and end your turn to wait rather than polling; use jobs.check only when a decision depends on it. Cancel what you no longer need with jobs.cancel.";

export interface CallsOptions {
  calls: CallStore;
  threads: Pick<ThreadStore, "find" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "active" | "create" | "toolsOn">;
  log: ThreadLog;
  bus: EventBus;
  logger: Logger;
  // The tools; given when needed, since they include these.
  tools: () => Pick<
    Tools,
    | "offered"
    | "decide"
    | "approvalHolds"
    | "riskOf"
    | "namesNow"
    | "modelNames"
    | "fromServers"
    | "run"
  >;
  // The tools the thread's agent may call of those its space offers; all of them when not given.
  narrow?: (thread: Thread, offered: AnyToolSpec[]) => AnyToolSpec[];
  // Whether the thread's agent may be started on the notification now; always when not given.
  mayStart?: (threadId: string) => boolean;
  now?: () => Date;
}

export type Calls = ReturnType<typeof createCalls>;

// What a call that is moved to the background carries on with.
export interface Adoption {
  callId: string;
  threadId: string;
  runId: string;
  toolId: string;
  input: unknown;
  model: string | null;
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
  const { calls, threads, spaceStore, runs, log, bus, logger } = options;
  const now = options.now ?? (() => new Date());
  const narrow = options.narrow ?? ((_thread: Thread, offered: AnyToolSpec[]) => offered);
  const notifier = createNotifier({
    threads,
    runs,
    log,
    bus,
    ...(options.mayStart && { mayStart: options.mayStart }),
  });
  // The calls running here, by id, each with what stops it.
  const live = new Map<string, AbortController>();

  function contextOf(threadId: string) {
    const thread = threads.find(threadId);
    const space = thread && spaceStore.find(thread.spaceId);
    if (!thread || !space) throw new ToolRefusal("The thread is gone.");
    return { thread, space };
  }

  function rowsOf(threadId: string) {
    return transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary)).rows;
  }

  function titleOf(space: { id: string; orgId: string }, toolId: string) {
    return options.tools().namesNow(space)(toolId)?.title ?? toolId;
  }

  // Closes the call's row if it is still open, as it was left: ran with its result, or stopped.
  function closeRow(record: CallRecord, output: ToolOutput | "stopped", ms: number, extra = {}) {
    log.write(record.threadId, (append) => {
      // A stop is written whatever the row, so readers see where the call stands.
      if (output === "stopped") {
        append({
          type: "tool.denied",
          actor: ACTOR,
          data: { runId: record.runId, callId: record.id, reason: "stopped" },
        });
        return;
      }
      const row = rowsOf(record.threadId).find(
        (one): one is ToolRow => one.kind === "tool" && one.id === record.id,
      );
      if (!row || (row.state !== "pending" && row.state !== "allowed")) return;
      append({
        type: "tool.ran",
        actor: ACTOR,
        data: {
          runId: record.runId,
          callId: record.id,
          ms,
          ...(output.ok ? { ok: true, value: output.value } : { ok: false, error: output.error }),
          ...extra,
        },
      });
    });
    bus.wake(record.threadId);
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
      people: record.steeredBy,
      ...(result && { last: result }),
    });
  }

  // Ends the call with its output, unless it ended already, and tells the agent.
  function end(id: string, output: ToolOutput, started: Date, extra: object = {}) {
    live.delete(id);
    const record = calls.find(id);
    if (!record || record.status !== "running") return;
    const stored = output.ok
      ? { ok: true as const, value: output.value }
      : { ok: false as const, error: output.error };
    calls.update(id, {
      status: output.ok ? "done" : "failed",
      output: stored,
      endedAt: now(),
    });
    const ms = Math.max(0, now().getTime() - started.getTime());
    try {
      closeRow(record, output, ms, extra);
      notify(
        record,
        `Background call ${id} (${titleOf(contextOf(record.threadId).space, record.toolId)}) ${output.ok ? "finished" : "failed"}`,
        resultText(output),
      );
    } catch (err) {
      logger.warn({ err, callId: id }, "background call end not recorded");
    }
  }

  // Runs the call now, and ends it when it is done.
  function launch(
    record: CallRecord,
    spec: AnyToolSpec,
    runAs: string | null,
    extra: object = {},
    approvedBy?: string,
  ) {
    const { thread, space } = contextOf(record.threadId);
    const controller = new AbortController();
    live.set(record.id, controller);
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
          actor: ACTOR,
          model: record.model,
          runAs,
          ...(approvedBy && { approvedBy }),
          signal: controller.signal,
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
    return {
      id: record.id,
      tool: titleOf(space, record.toolId),
      toolId: record.toolId,
      status: record.status,
      ...(record.output?.ok && { result: resultText(record.output) }),
      ...(record.output && !record.output.ok && { error: record.output.error }),
      startedAt: record.createdAt.toISOString(),
      ...(record.endedAt && { endedAt: record.endedAt.toISOString() }),
      thread: thread.id,
    };
  }

  // Stops the call as the agent asked: it runs no more and tells nobody.
  function stop(record: CallRecord) {
    calls.update(record.id, { status: "cancelled", endedAt: now() });
    live.get(record.id)?.abort(new Error("cancelled"));
    live.delete(record.id);
    closeRow(record, "stopped", 0);
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
          const decision = tools.decide(
            rows,
            thread,
            space,
            spec.name,
            spec.risk(parsed.data, { model: ctx.model }),
            parsed.data,
          );
          const waits = decision.kind === "wait";
          const risk = tools.riskOf(space, spec, parsed.data, ctx.model);
          const names = tools.namesNow(space)(spec.name);
          const id = ulid();
          const record = calls.create({
            id,
            threadId: thread.id,
            runId: ctx.runId,
            toolId: spec.name,
            input: parsed.data,
            model: ctx.model,
            steeredBy: steeringIn(rows),
            status: waits ? "pending" : "running",
          });
          ctx.write((append) =>
            append({
              type: "tool.requested",
              actor: ACTOR,
              data: {
                runId: id,
                callId: id,
                messageId: "",
                toolId: spec.name,
                input: parsed.data,
                risk,
                waits,
                background: true,
                ...(names && { title: names.title }),
                ...(names?.toolset && { toolset: names.toolset }),
              },
            }),
          );
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
    description: "Where a background call stands, and its result once it ended.",
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
            const { result: _result, error: _error, ...rest } = summaryOf(record);
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
          if (record.status !== "running" && record.status !== "pending") {
            throw new ToolRefusal(`Call ${id} already ${record.status}.`);
          }
          stop(record);
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
          tools.riskOf(space, spec, parsed.data, record.model),
        );
      if (!holds || !spec) {
        calls.update(callId, { status: "cancelled", endedAt: now() });
        if (allow) {
          log.write(threadId, (append) =>
            append({
              type: "tool.denied",
              actor: ACTOR,
              data: { runId: callId, callId, reason: "stale" },
            }),
          );
        }
        notify(
          record,
          `Background call ${callId} (${record.toolId}) was ${allow ? "not allowed to run: its approval no longer held" : "denied"}.`,
        );
        return;
      }
      calls.update(callId, { status: "running" });
      const runAs = spec.connection?.(record.input, space)
        ? (row.decision?.by.userId ?? null)
        : null;
      launch({ ...record, status: "running" }, spec, runAs, {}, row.decision?.by.userId);
    },

    // Stops a call that is running or waiting for approval, as a person asked.
    cancel(threadId: string, callId: string) {
      const record = calls.find(callId);
      if (!record || record.threadId !== threadId) throw new ServiceError(404, "Call not found");
      if (record.status !== "running" && record.status !== "pending") {
        throw new ServiceError(409, "This call has ended");
      }
      stop(record);
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
      model: string | null,
      append: Append,
    ) {
      const id = ulid();
      {
        calls.create({
          id,
          threadId,
          runId: call.runId,
          toolId: call.toolId,
          input: call.input,
          model,
          steeredBy: steeringIn(rowsOf(threadId)),
          status: "pending",
        });
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
            waits: true,
            background: true,
            ...(call.title && { title: call.title }),
            ...(call.toolset && { toolset: call.toolset }),
          },
        });
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
      }
      return id;
    },

    // Takes over a call moved to the background: it goes on, and ends as any does.
    adopt(call: Adoption) {
      const record = calls.create({
        id: call.callId,
        threadId: call.threadId,
        runId: call.runId,
        toolId: call.toolId,
        input: call.input,
        model: call.model,
        steeredBy: steeringIn(rowsOf(call.threadId)),
        status: "running",
      });
      live.set(record.id, call.controller);
      void call.work.then(
        (output) => end(record.id, output, call.started),
        (err: unknown) => {
          logger.warn({ err, callId: record.id, toolId: record.toolId }, "background call failed");
          end(record.id, { ok: false, error: messageOf(err) }, call.started);
        },
      );
    },

    // Ends the calls a stopped server left running, telling their threads' agents.
    recover() {
      for (const record of calls.running()) {
        calls.update(record.id, { status: "interrupted", endedAt: now() });
        try {
          closeRow(record, { ok: false, error: "The server stopped while the call ran." }, 0);
          notify(
            record,
            `Background call ${record.id} (${record.toolId}) was interrupted: the server stopped while it ran.`,
          );
        } catch (err) {
          logger.warn({ err, callId: record.id }, "interrupted call not recorded");
        }
      }
    },
  };
}

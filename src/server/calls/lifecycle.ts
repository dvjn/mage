// The steps every tool call takes, whoever makes it, a run, a job or a script: judged under the
// tool's rule, run in a span of its own, and its result recorded as one event.

import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { contentRecorded, tracer } from "@/server/kernel/tracing.ts";
import type { Space } from "@/server/spaces/service.ts";
import type { Thread } from "@/server/threads/types.ts";
import type { Decision } from "@/server/tools/authority.ts";
import type {
  AnyToolSpec,
  CallView,
  People,
  SpaceTools,
  ToolOutput,
  Tools,
  Vouch,
} from "@/server/tools/registry.ts";
import type { Word } from "@/server/queue/queue.ts";
import type { EventDataMap } from "@/shared/threads/events.ts";

// Whether a call of the tool with this input runs now, on a standing approval, or waits, with the
// words the model had read and the vouches its branch holds, and the risk the tool declares.
export async function judge(
  tools: Pick<Tools, "evaluate">,
  ask: {
    words: readonly Word[];
    vouches: readonly Vouch[];
    thread: Thread;
    space: Space;
    spec: AnyToolSpec;
    input: unknown;
    model: string | null;
    now?: SpaceTools;
    // The people read already for calls judged together.
    people?: People;
  },
): Promise<Decision> {
  const { thread, space, spec, input, model } = ask;
  return tools.evaluate(
    ask.words,
    ask.vouches,
    thread,
    space,
    spec.name,
    await spec.risk(input, { model, orgId: space.orgId }),
    input,
    ask.now,
    ask.people,
  );
}

// How an approved call runs while its approval holds, with its approver's own login where its
// tool uses one; null once the approval lapsed.
export async function approvedNow(
  tools: Pick<Tools, "riskOf" | "approvalHolds">,
  ask: {
    call: CallView & { decision: NonNullable<CallView["decision"]> };
    words: readonly Word[];
    thread: Thread;
    space: Space;
    spec: AnyToolSpec;
    input: unknown;
    model: string | null;
    now?: SpaceTools;
  },
): Promise<{ runAs: string | null; approvedBy: string } | null> {
  const { call, thread, space, spec, input, now } = ask;
  const risk = await tools.riskOf(space, spec, input, ask.model, now);
  if (!(await tools.approvalHolds(call, ask.words, thread, space, risk, now))) return null;
  const by = call.decision.by.userId;
  return { runAs: (await spec.connection?.(input, space)) ? by : null, approvedBy: by };
}

// The span a call runs in.
export function toolSpan(toolId: string, callId: string, input: unknown) {
  return tracer.startSpan(`execute_tool ${toolId}`, {
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolId,
      "gen_ai.tool.call.id": callId,
      ...(contentRecorded() && { "gen_ai.tool.call.arguments": JSON.stringify(input) }),
    },
  });
}

// Ends the call's span with what it gave back.
export function spanEnded(span: Span, output: ToolOutput) {
  span.setAttribute("tool.outcome", output.ok ? "ok" : "error");
  if (!output.ok) span.setStatus({ code: SpanStatusCode.ERROR });
  if (contentRecorded()) {
    const result = JSON.stringify(output.ok ? output.value : output.error);
    if (result) span.setAttribute("gen_ai.tool.call.result", result);
  }
  span.end();
}

// What a tool throws once it paused its call to wait for something, as a script does at a call
// waiting for a person: its call stays open, and the run waits as for any approval.
export class CallPaused extends Error {
  constructor() {
    super("paused");
  }
}

// What the call's result event says: what it gave back or why it failed, how long it ran, whose
// login it ran with and the standing approval it ran on.
export function ranData(
  runId: string,
  callId: string,
  output: ToolOutput,
  ms: number,
  extra: { standingOn?: string } = {},
): EventDataMap["tool.ran"] {
  return {
    runId,
    callId,
    ms,
    ...(output.ok ? { ok: true, value: output.value } : { ok: false, error: output.error }),
    ...(output.ranAs && { ranAs: output.ranAs }),
    ...extra,
  };
}

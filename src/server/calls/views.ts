// Calls as authority reads them, from their rows and the two events that hold what a row does not:
// the request, with its input and what the tool was called, and the answers given, if any. Both
// are read by seq, one statement for the calls at hand.

import type { CallView } from "@/server/tools/registry.ts";
import type { ThreadStore } from "@/server/threads/types.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";
import type { ToolState } from "@/shared/transcript.ts";

import type { CallRow } from "./store.ts";

// A call as authority reads it, with the run that asked for it and what its tool was called then.
export type CallRecord = CallView & {
  runId: string;
  requestedAt: string;
  title?: string;
  toolset?: string;
  // For a call a script made, the script's call.
  within?: string;
};

// Where the call stands as the thread's fold says it: waiting for a person, ready to run until it
// ends, then how it ended.
function stateOf(row: CallRow): ToolState {
  switch (row.status) {
    case "waiting":
      return "waiting";
    case "ready":
    case "running":
      return "ready";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "denied":
      return "denied";
    case "skipped":
      return "skipped";
    case "stale":
      return "stale";
    case "cancelled":
      return "cancelled";
  }
}

// The calls with what their events hold, by id; a call whose request is not in the log is left
// out.
export async function callRecords(
  threads: Pick<ThreadStore, "eventsAt">,
  threadId: string,
  rows: readonly CallRow[],
): Promise<Map<string, CallRecord>> {
  if (rows.length === 0) return new Map();
  const seqs = rows.flatMap((row) =>
    row.decidedSeq === null ? [row.seq] : [row.seq, row.decidedSeq],
  );
  const events = new Map((await threads.eventsAt(threadId, seqs)).map((one) => [one.seq, one]));
  const records = new Map<string, CallRecord>();
  for (const row of rows) {
    const requested = events.get(row.seq);
    if (requested?.type !== "tool.requested") continue;
    const decided = row.decidedSeq === null ? undefined : events.get(row.decidedSeq);
    const answers = decided?.type === "tool.answered" ? decided.data.answers : undefined;
    const { input, waits, title, toolset, within } = requested.data;
    records.set(row.id, {
      id: row.id,
      seq: row.seq,
      runId: row.runId,
      requestedAt: requested.createdAt.toISOString(),
      toolId: row.toolId,
      input,
      risk: row.risk as ToolRisk,
      state: stateOf(row),
      waits: !!waits,
      ...(title && { title }),
      ...(toolset && { toolset }),
      ...(within && { within }),
      ...(answers && { answers }),
      decision:
        row.decidedBy && row.decidedSeq !== null
          ? {
              allow: row.status !== "denied" && row.status !== "skipped",
              scope: row.scope ?? "once",
              by: { userId: row.decidedBy },
              seq: row.decidedSeq,
            }
          : null,
    });
  }
  return records;
}

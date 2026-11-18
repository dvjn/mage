// What became of a tool call, in the one set of words every count, icon and the activity tray read
// it in: a job by where its job stands, any other call by its own state. And where a row that holds
// calls stands, for its icon.

import type { WorkStatus } from "./jobs.ts";
import type { ToolRow } from "./threads/rows.ts";

export type CallOutcome =
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "denied"
  | "stopped"
  | "skipped";

// Whether background work ended in failure: it failed, or a restart cut it off.
export function failedWork(status: WorkStatus) {
  return status === "failed" || status === "interrupted";
}

function jobOutcome(status: WorkStatus): CallOutcome {
  if (status === "waiting") return "waiting";
  if (status === "completed") return "done";
  if (status === "cancelled") return "stopped";
  if (failedWork(status)) return "failed";
  return "running";
}

export function outcomeOf(call: Pick<ToolRow, "state" | "work">): CallOutcome {
  if (call.work?.kind === "job") return jobOutcome(call.work.status);
  switch (call.state) {
    case "waiting":
      return "waiting";
    case "ready":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "denied":
    case "stale":
      return "denied";
    case "cancelled":
      return "stopped";
    case "skipped":
      return "skipped";
  }
}

// The ways a call ends without running as asked, in the order they are counted.
const MISSES = ["failed", "denied", "stopped", "skipped"] as const;

// How many calls ended each way without running as asked, in words: "2 failed", "1 skipped".
export function missesOf(outcomes: readonly CallOutcome[]) {
  return MISSES.flatMap((miss) => {
    const count = outcomes.filter((outcome) => outcome === miss).length;
    return count > 0 ? [`${count} ${miss}`] : [];
  });
}

// Where a row that holds calls stands: waiting while any call in it or under them waits for
// approval, then running while any runs; failed only once every call in it ended badly, skipped
// once every call in it was skipped or ended badly; else done.
export type Standing = "waiting" | "running" | "failed" | "skipped" | "done";

export function standingOf(
  calls: readonly CallOutcome[],
  under: readonly CallOutcome[] = [],
): Standing {
  const all = [...calls, ...under];
  if (all.includes("waiting")) return "waiting";
  if (all.includes("running")) return "running";
  const bad = (outcome: CallOutcome) =>
    outcome === "failed" || outcome === "denied" || outcome === "stopped";
  if (calls.length === 0) return "done";
  if (calls.every(bad)) return "failed";
  if (calls.every((outcome) => bad(outcome) || outcome === "skipped")) return "skipped";
  return "done";
}

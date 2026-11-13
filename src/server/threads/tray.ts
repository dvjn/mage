// The rules of the activity tray: which background items need a reader, and which are still live.
// A background job leaves when it ends, its notification in the transcript being the record of it;
// the other finished kinds stay until a reader has seen them, so a failure nobody saw is not lost.

import type { Attention, BackgroundWork, WorkStatus } from "@/shared/calls.ts";
import type { SubagentNeeds, SubagentState } from "@/shared/subagents.ts";

// How close a firing schedule must be to ask for notice.
export const SOON_MS = 5 * 60 * 1000;

export function attentionOf(work: BackgroundWork, now: Date): Attention | undefined {
  // What waits on a person asks only the readers who may decide or answer it, and keeps asking
  // whether or not its kind was opened.
  if (work.status === "pending") return work.canDecide ? "approval" : undefined;
  if (work.status === "failed" || work.status === "interrupted") return "failed";
  const next = work.schedule?.nextRunAt;
  if (work.status === "scheduled" && next) {
    const ahead = new Date(next).getTime() - now.getTime();
    if (ahead <= SOON_MS) return "soon";
  }
  return undefined;
}

// Whether the item is under way or set up, which is live whatever has been seen.
export function underway(work: BackgroundWork) {
  return ["pending", "queued", "running", "scheduled", "listening", "paused"].includes(work.status);
}

// Where a subagent stands as work: waiting on a person while its call does, stopped as cancelled.
export function subagentStatus(state: SubagentState, needs?: SubagentNeeds): WorkStatus {
  if (state === "working") return needs ? "pending" : "running";
  if (state === "stopped" || state === "archived") return "cancelled";
  return state;
}

// Whether a reader still has the item: it is underway or a subagent that is idle, or it ended after
// they last saw its kind. A job that has ended is not.
export function liveFor(work: BackgroundWork, seenAt: number | undefined) {
  if (underway(work) || work.status === "idle") return true;
  if (work.kind === "call") return false;
  if (!work.endedAt) return false;
  return seenAt === undefined || new Date(work.endedAt).getTime() > seenAt;
}

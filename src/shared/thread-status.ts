// The one status a thread shows a reader in its list, from what it holds for them, highest first:
// the agent waits for a decision they may make; its last run failed after they last looked; the
// agent is working, or waits for someone else to decide (paused); something new came from someone
// else; or nothing new.

import type { ThreadActivity } from "@/shared/threads.ts";

export type ThreadStatus = "waiting" | "failed" | "working" | "paused" | "unread" | "read";

export function statusOf(activity: ThreadActivity, me: string): ThreadStatus {
  const { run, failed, lastSeenSeq } = activity;
  if (run?.status === "waiting" && activity.canApprove) return "waiting";
  if (failed && failed.seq > lastSeenSeq) return "failed";
  if (run) return run.status === "waiting" ? "paused" : "working";
  if (activity.lastNotableSeq > lastSeenSeq && activity.lastNotableBy !== me) return "unread";
  return "read";
}

// Statuses that ask the reader to act.
export function needsYou(status: ThreadStatus) {
  return status === "waiting" || status === "failed";
}

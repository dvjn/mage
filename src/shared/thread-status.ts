// The one status a thread shows a reader in its list, from what it holds for them, highest first:
// the agent waits for a decision they may make; its last run failed after they last looked; the
// agent is working, or waits for someone else to decide (paused); something new came from someone
// else; or nothing new. A list of threads can show all of them, those that need the reader, or
// those with something new for them.

import * as z from "zod";

import { tableQuerySchema } from "@/shared/paging.ts";
import type { ThreadActivity } from "@/shared/threads/list.ts";

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

export const threadShowSchema = z.enum(["needs-you", "unread"]);

export type ThreadShow = z.infer<typeof threadShowSchema>;

// Whether a list showing `show` lists a thread with the status; all of them when unset.
export function shows(show: ThreadShow | undefined, status: ThreadStatus) {
  if (show === "needs-you") return needsYou(status);
  if (show === "unread") return status === "unread";
  return true;
}

// A table of threads' page: its text and which threads it shows.
export const threadPageQuerySchema = tableQuerySchema.extend({ show: threadShowSchema.optional() });

// A space's, which can also show one folder.
export const spaceThreadPageQuerySchema = threadPageQuerySchema.extend({
  folder: z.string().max(100).optional(),
});

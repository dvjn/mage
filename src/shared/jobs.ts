// Jobs: tool calls that run on after the agent's run goes on, or ends, and tell the thread's agent
// when they are done.

import * as z from "zod";

import { subagentNeedsSchema, subagentStateSchema } from "@/shared/subagents.ts";
import { scheduleWorkSchema } from "./schedules.ts";
import { webhookWorkSchema } from "./webhooks.ts";

// The tools the agent starts, checks and stops them with.
export const JOBS_TOOLSET = "jobs";
export const START_JOB = "jobs.start";

// How many background calls a thread has running at once; more wait their turn, and those waiting
// for approval hold no place.
export const BACKGROUND_LIMIT = 8;

// Where a job stands: waiting for approval, queued for its turn past the thread's limit, running,
// or how it ended. One a restart left running is interrupted.
export const jobStatusSchema = z.enum([
  "waiting",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

// What kinds of background work a card shows.
export const workKindSchema = z.enum(["job", "schedule", "webhook", "subagent", "decision"]);

export type WorkKind = z.infer<typeof workKindSchema>;

// Where background work stands, the one set of words every card and the tray show it in: a call's
// own; a subagent queued behind others, or idle until told more; a schedule or webhook waiting for
// its time or for a post, or paused. Waiting is waiting on a person's decision or answer.
export const workStatusSchema = z.enum([
  ...jobStatusSchema.options,
  "queued",
  "idle",
  "scheduled",
  "listening",
  "paused",
]);

export type WorkStatus = z.infer<typeof workStatusSchema>;

// A subagent as the dock shows it: its own thread and where it stands there.
export const subagentWorkSchema = z.object({
  threadId: z.string(),
  state: subagentStateSchema,
  needs: subagentNeedsSchema.optional(),
  // Of the tasks given to it, how many are done.
  tasks: z.object({ done: z.number().int(), total: z.number().int() }).optional(),
  // The row of its thread that waits, to read it there.
  waitingRow: z.string().optional(),
});

// A card for background work as a reader sees it: what kind it is, where it stands, when it started
// and ended, and whether they may stop it; for a schedule, what it is and when it fires; for a webhook, what it
// is and when it last received a post.
export const workSchema = z.object({
  kind: workKindSchema,
  status: workStatusSchema,
  schedule: scheduleWorkSchema.optional(),
  webhook: webhookWorkSchema.optional(),
  subagent: subagentWorkSchema.optional(),
  // For work that waits on a person, whether the reader may decide or answer it.
  canDecide: z.boolean().optional(),
  // Null while it has not begun, as a job waiting for its turn.
  startedAt: z.string().nullable(),
  endedAt: z.string().optional(),
  canCancel: z.boolean(),
});

export type Work = z.infer<typeof workSchema>;

// Why an item needs a reader: it waits for approval, it failed, or it fires within minutes.
export const attentionSchema = z.enum(["approval", "failed", "soon"]);

export type Attention = z.infer<typeof attentionSchema>;

// The kinds the activity tray's strip gathers background work into, in its order: calls waiting for
// a decision, calls, subagents, schedules and wake-ups, and webhooks.
export const trayKindSchema = z.enum(["approvals", "jobs", "subagents", "schedules", "webhooks"]);

export type TrayKind = z.infer<typeof trayKindSchema>;

// What a reader sends to say they have seen a kind.
export const activitySeenSchema = z.object({ kind: trayKindSchema });

export function trayKindOf(work: Pick<Work, "kind">): TrayKind {
  return {
    decision: "approvals",
    job: "jobs",
    subagent: "subagents",
    schedule: "schedules",
    webhook: "webhooks",
  }[work.kind] as TrayKind;
}

// One piece of a thread's live background work as its dock shows it: the card it has in the
// transcript, what it is called, and its own state.
export const activityItemSchema = z.object({
  // The transcript row whose card is the record of it; a subagent's thread id, which has none.
  rowId: z.string(),
  // What the call is of, as its tool is called; a schedule or webhook goes by its name.
  title: z.string(),
  work: workSchema,
  attention: attentionSchema.optional(),
  // Whose words started it, for a hover.
  by: z.string().optional(),
});

export type ActivityItem = z.infer<typeof activityItemSchema>;

// What runs, waits or is set up in a thread now, oldest first, then its subagents that are not
// retired; finished calls and idle or stopped subagents stay until a reader has seen them.
export const activityListSchema = z.object({ items: z.array(activityItemSchema) });

export type ActivityList = z.infer<typeof activityListSchema>;

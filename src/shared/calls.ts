// Background calls: tool calls that run on after the agent's run goes on, or ends, and tell the
// thread's agent when they are done.

import * as z from "zod";

import { subagentNeedsSchema, subagentStateSchema } from "@/shared/subagents.ts";
import { scheduleWorkSchema, webhookWorkSchema } from "@/shared/triggers.ts";

// The tools the agent starts, checks and stops them with.
export const CALLS_TOOLSET = "calls";
export const START_CALL = "calls.start";

// How many background calls a thread has running or waiting for approval at once.
export const BACKGROUND_LIMIT = 8;

// Where a background call stands: waiting for approval, running, or how it ended. One a restart
// left running is interrupted.
export const callStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);

export type CallStatus = z.infer<typeof callStatusSchema>;

// What kinds of background work a card shows.
export const backgroundKindSchema = z.enum(["call", "schedule", "webhook", "subagent", "approval"]);

export type BackgroundKind = z.infer<typeof backgroundKindSchema>;

// Where a schedule or webhook stands: waiting for its time or for a post, paused, or a timer that
// went off.
export const workStatusSchema = z.enum([
  ...callStatusSchema.options,
  "scheduled",
  "listening",
  "paused",
]);

export type WorkStatus = z.infer<typeof workStatusSchema>;

// A subagent as the dock shows it: its own thread and where it stands there. Its work status is the
// nearest of a call's: running when it works, waiting when queued or on someone, done when idle,
// cancelled when stopped.
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
export const backgroundWorkSchema = z.object({
  kind: backgroundKindSchema,
  status: workStatusSchema,
  schedule: scheduleWorkSchema.optional(),
  webhook: webhookWorkSchema.optional(),
  subagent: subagentWorkSchema.optional(),
  // For a call that waits for a decision, whether the reader may decide it.
  canDecide: z.boolean().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  canCancel: z.boolean(),
});

export type BackgroundWork = z.infer<typeof backgroundWorkSchema>;

// Why an item needs a reader: it waits for approval, it failed, or it fires within minutes.
export const attentionSchema = z.enum(["approval", "failed", "soon"]);

export type Attention = z.infer<typeof attentionSchema>;

// The kinds the activity tray's strip gathers background work into, in its order: calls waiting for
// a decision, calls, subagents, schedules and wake-ups, and webhooks.
export const trayKindSchema = z.enum(["approvals", "jobs", "subagents", "triggers", "webhooks"]);

export type TrayKind = z.infer<typeof trayKindSchema>;

// What a reader sends to say they have seen a kind.
export const backgroundSeenSchema = z.object({ kind: trayKindSchema });

export function trayKindOf(work: Pick<BackgroundWork, "kind">): TrayKind {
  return {
    approval: "approvals",
    call: "jobs",
    subagent: "subagents",
    schedule: "triggers",
    webhook: "webhooks",
  }[work.kind] as TrayKind;
}

// One piece of a thread's live background work as its dock shows it: the card it has in the
// transcript, what it is called, and its own state.
export const backgroundItemSchema = z.object({
  // The transcript row whose card is the record of it; a subagent's thread id, which has none.
  rowId: z.string(),
  // What the call is of, as its tool is called; a schedule or webhook goes by its name.
  title: z.string(),
  work: backgroundWorkSchema,
  attention: attentionSchema.optional(),
  // Whose words started it, for a hover.
  by: z.string().optional(),
});

export type BackgroundItem = z.infer<typeof backgroundItemSchema>;

// What runs, waits or is set up in a thread now, oldest first, then its subagents that are not
// retired; finished calls and idle or stopped subagents stay until a reader has seen them.
export const backgroundListSchema = z.object({ items: z.array(backgroundItemSchema) });

export type BackgroundList = z.infer<typeof backgroundListSchema>;

// Background calls: tool calls that run on after the agent's run goes on, or ends, and tell the
// thread's agent when they are done.

import * as z from "zod";

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
export const backgroundKindSchema = z.enum(["call", "schedule", "webhook"]);

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

// A card for background work as a reader sees it: what kind it is, where it stands, when it started
// and ended, and whether they may stop it; for a schedule, what it is and when it fires; for a webhook, what it
// is and when it last received a post.
export const backgroundWorkSchema = z.object({
  kind: backgroundKindSchema,
  status: workStatusSchema,
  schedule: scheduleWorkSchema.optional(),
  webhook: webhookWorkSchema.optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  canCancel: z.boolean(),
});

export type BackgroundWork = z.infer<typeof backgroundWorkSchema>;

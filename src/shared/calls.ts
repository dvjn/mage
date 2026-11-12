// Background calls: tool calls that run on after the agent's run goes on, or ends, and tell the
// thread's agent when they are done.

import * as z from "zod";

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
export const backgroundKindSchema = z.enum(["call"]);

export type BackgroundKind = z.infer<typeof backgroundKindSchema>;

// A card for background work as a reader sees it: what kind it is, where it stands, when it started
// and ended, and whether they may stop it.
export const backgroundWorkSchema = z.object({
  kind: backgroundKindSchema,
  status: callStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  canCancel: z.boolean(),
});

export type BackgroundWork = z.infer<typeof backgroundWorkSchema>;

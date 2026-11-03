// Subagents: agents a thread's agent starts, each working in a thread of its own under the thread
// that started it. Where one stands, and what lists and lines show of it.

import * as z from "zod";

// Where a subagent stands: waiting for a free place to run, working, done until it is sent more,
// stopped until its next run, or retired.
export const subagentStateSchema = z.enum(["queued", "working", "idle", "stopped", "archived"]);

export type SubagentState = z.infer<typeof subagentStateSchema>;

// What a working subagent waits on someone in its thread for: a decision on a call, or answers.
export const subagentNeedsSchema = z.enum(["approval", "answer"]);

export type SubagentNeeds = z.infer<typeof subagentNeedsSchema>;

// A subagent as lines and lists show it: its thread, the name it was given, where it stands and what
// it waits on.
export const subagentSummarySchema = z.object({
  threadId: z.string(),
  name: z.string(),
  state: subagentStateSchema,
  needs: subagentNeedsSchema.optional(),
});

export type SubagentSummary = z.infer<typeof subagentSummarySchema>;

// What the thread's agent is named as, where subagents send it messages and read whom theirs went
// to.
export const AGENT = "agent";

// The tools subagents have.
export const SUBAGENTS_TOOLSET = "subagents";
export const START_SUBAGENT = "subagents.start";
export const SEND_SUBAGENT_MESSAGE = "subagents.send";

// The Subagents toolset's option that lets the agent choose the model a subagent replies with.
export const CHOOSE_MODELS = "choose_models";

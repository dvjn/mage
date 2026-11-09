// A thread as its page reads it: how the reader came to it and what they may do in it, the models
// it uses, and its newest rows as the reader sees them, reaching back to the first they have not
// seen, with the messages waiting for the agent and the run under way.

import * as z from "zod";

import { subagentSummarySchema } from "@/shared/subagents.ts";
import { shownBranchSchema } from "@/shared/threads/history.ts";
import { pendingMessageSchema, shownRowSchema, shownRunSchema } from "@/shared/threads/rows.ts";
import { effortSchema, threadSchema } from "@/shared/threads/thread.ts";
import { toolDefinitionSchema } from "@/shared/tools.ts";

// How the reader came to the thread: as a member of its space with their role, or as a guest, who
// sees only the space's name.
export const threadAccessSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("space"), role: z.enum(["owner", "messager", "viewer"]) }),
  z.object({ via: z.literal("guest"), spaceName: z.string() }),
]);

export type ThreadAccessSummary = z.infer<typeof threadAccessSchema>;

// Whether a model can reply: listed and on, turned off, or gone.
const modelAvailabilitySchema = z.object({
  ref: z.string(),
  name: z.string(),
  status: z.enum(["ok", "off", "unavailable"]),
});

// The model and effort a thread follows where it has none of its own: its space's, then its org's;
// null where neither has one.
export const threadDefaultsSchema = z.object({
  model: z.string().nullable(),
  effort: effortSchema.nullable(),
  // The default that replies, with the effort that goes with it: the space's while it can, else
  // the org's; none when neither can.
  used: z
    .object({ ref: z.string(), name: z.string(), effort: effortSchema.nullable() })
    .nullable()
    .optional(),
});

export type ThreadDefaults = z.infer<typeof threadDefaultsSchema>;

// What the reader may do in the thread: post in it, and so stop and retry its runs; rename it and
// change its model; share it with guests; and move it to another space or delete it.
export const threadCanSchema = z.object({
  post: z.boolean(),
  arrange: z.boolean(),
  share: z.boolean(),
  move: z.boolean(),
  delete: z.boolean(),
});

export type ThreadCan = z.infer<typeof threadCanSchema>;

// The thread itself as the reader sees it, without its rows, which the live stream sends again when
// it is renamed, moved or set to another model. For a subagent's thread, the subagent as it is now,
// the thread whose agent started it, and whether the reader may bring it back once retired.
export const threadSubagentSchema = subagentSummarySchema.extend({
  parent: z.object({ id: z.string(), title: z.string() }),
  canUnarchive: z.boolean(),
});

export type ThreadSubagent = z.infer<typeof threadSubagentSchema>;

export const threadHeadSchema = z.object({
  thread: threadSchema,
  access: threadAccessSchema,
  // Its space is archived: it can be read, moved out and deleted, nothing more.
  archived: z.boolean(),
  can: threadCanSchema,
  // The reader's level for each tool here: whether they may run it, and so decide on its calls.
  levels: z.record(z.string(), z.enum(["run", "approve"])),
  // Every tool's definition, by which its calls show.
  tools: z.array(toolDefinitionSchema),
  defaults: threadDefaultsSchema,
  // For a subagent's thread, the subagent.
  subagent: threadSubagentSchema.nullable().optional(),
  // What the agent of its space's threads goes by.
  agentName: z.string(),
  // The model it names, its own or the default, and the one that replies: the same, or while that
  // one is turned off or gone, the space's default, then the org's; null when none can. Null with
  // no model at all.
  model: z
    .object({
      chosen: modelAvailabilitySchema,
      used: modelAvailabilitySchema.nullable(),
      // The effort that goes with the model used.
      effort: effortSchema.nullable(),
    })
    .nullable(),
});

export type ThreadHead = z.infer<typeof threadHeadSchema>;

export const threadDetailSchema = threadHeadSchema.extend({
  // The branch its rows are of.
  branch: shownBranchSchema,
  // The newest rows, in order, reaching back to `newFrom`.
  rows: z.array(shownRowSchema),
  // The place of the first row given, to read the rows before it; null when they start the thread.
  before: z.number().int().nonnegative().nullable(),
  // The first row the reader had not seen that is not their own nor a reply still being written.
  newFrom: z.string().nullable(),
  pending: z.array(pendingMessageSchema),
  run: shownRunSchema.nullable(),
});

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

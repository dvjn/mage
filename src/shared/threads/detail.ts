// A thread as its page reads it: its events, how the reader came to it, and the models it uses.

import * as z from "zod";

import { anyThreadEventSchema, toolRiskSchema } from "@/shared/threads/events.ts";
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

export const threadDetailSchema = z.object({
  thread: threadSchema,
  events: z.array(anyThreadEventSchema),
  access: threadAccessSchema,
  // How far the reader had seen it: the seq of the newest event they saw, 0 when none.
  seenSeq: z.number().int().nonnegative(),
  // The reader's level for each tool here: whether they may run it, and so decide on its calls.
  levels: z.record(z.string(), z.enum(["run", "approve"])),
  // Current policy for pending approval cards, separate from the historical request events.
  pendingTools: z
    .record(z.string(), z.object({ risk: toolRiskSchema, canDecide: z.boolean() }))
    .optional(),
  // Every tool's definition, by which its calls show.
  tools: z.array(toolDefinitionSchema),
  defaults: threadDefaultsSchema,
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

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

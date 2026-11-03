// Threads as a space's list and its sidebar show them, with what each holds for the reader.

import * as z from "zod";

import { subagentSummarySchema } from "@/shared/subagents.ts";
import { hostIdSchema } from "@/shared/hosts.ts";
import { MAKER_IDS } from "@/shared/makers.ts";
import { threadSchema } from "@/shared/threads/thread.ts";

// What a thread holds for one reader: the agent's active run (queued, replying, or waiting for a
// decision on a tool call, since when and on which tool), its newest notable event (a person's
// message, a finished reply or a failed run) and who wrote it (null for the agent), its last run's
// failure while nothing has run since, how far the reader has seen, and whether they may decide on
// the call the run waits for.
export const threadActivitySchema = z.object({
  run: z
    .object({
      status: z.enum(["queued", "running", "waiting"]),
      since: z.iso.datetime(),
      toolId: z.string().optional(),
    })
    .nullable(),
  lastNotableSeq: z.number().int().nonnegative(),
  lastNotableBy: z.string().nullable(),
  failed: z.object({ seq: z.number().int().positive(), error: z.string() }).nullable(),
  lastSeenSeq: z.number().int().nonnegative(),
  canApprove: z.boolean(),
});

export type ThreadActivity = z.infer<typeof threadActivitySchema>;

// Who has written in a thread: the few who wrote most recently, whoever wrote last first, each
// saying whether they last wrote as a guest of the thread, and how many have in all.
export const threadParticipantsSchema = z.object({
  people: z.array(z.object({ userId: z.string(), name: z.string(), guest: z.boolean() })),
  total: z.number().int().nonnegative(),
});

export type ThreadParticipants = z.infer<typeof threadParticipantsSchema>;

// The model a list shows for a thread, its own or the default it follows: its name, who makes it,
// null when no one can tell, and the host it comes through with how people know that connection,
// both null when the org has no connection for it.
export const shownModelSchema = z.object({
  ref: z.string(),
  name: z.string(),
  maker: z.enum(MAKER_IDS).nullable(),
  host: hostIdSchema.nullable(),
  connection: z.string().nullable(),
});

export type ShownModel = z.infer<typeof shownModelSchema>;

// The one status a thread shows a reader in its lists, worked out on the server from what it holds
// for them.
export const threadStatusSchema = z.enum([
  "waiting",
  "failed",
  "working",
  "paused",
  "unread",
  "read",
]);

// A subagent under the thread whose agent started it: where it stands, and as its thread's row
// shows it, its label as title, model, who has written in it, what it holds for the reader and the
// status that shows them.
export const listedSubagentSchema = subagentSummarySchema.extend({
  title: z.string(),
  untitled: z.boolean(),
  updatedAt: z.iso.datetime(),
  shownModel: shownModelSchema.nullable(),
  participants: threadParticipantsSchema,
  activity: threadActivitySchema,
  status: threadStatusSchema,
});

export type ListedSubagent = z.infer<typeof listedSubagentSchema>;

// A thread in its space's list, with the model it shows (null with none at all), who has written
// in it, what it holds for the reader and the status that shows them, which takes in the most
// pressing of its subagents', and its subagents, retired ones among them.
export const threadListItemSchema = threadSchema.extend({
  shownModel: shownModelSchema.nullable(),
  participants: threadParticipantsSchema,
  activity: threadActivitySchema,
  status: threadStatusSchema,
  subagents: z.array(listedSubagentSchema).optional(),
});

export type ThreadListItem = z.infer<typeof threadListItemSchema>;

export const threadListSchema = z.array(threadListItemSchema);

// How many threads of a space its sidebar lists.
export const SIDEBAR_LIMIT = 30;

// A space's threads as its sidebar lists them for the reader: the newest up to the limit, and
// beside them, older, those that need the reader; how many threads the space holds; and how many
// threads need the reader in all.
export const threadSidebarSchema = z.object({
  threads: z.array(threadListItemSchema),
  total: z.number().int(),
  needsYou: z.number().int(),
});

export type ThreadSidebar = z.infer<typeof threadSidebarSchema>;

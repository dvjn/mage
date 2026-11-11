// A thread's history as the API shows it: its branches, what a reader asks to do from one of its
// rows, and the side questions a reader asks about it.

import * as z from "zod";

import { effortSchema } from "@/shared/threads/thread.ts";

const messageTextSchema = z.string().trim().min(1).max(100_000);

// The branch a thread's page shows: the current one, or an older one, read-only.
export const shownBranchSchema = z.object({ id: z.string(), current: z.boolean() });

export type ShownBranch = z.infer<typeof shownBranchSchema>;

// A model and effort a reply is asked of in place of the thread's.
export const askedModelSchema = z.object({
  model: z.string().min(1),
  effort: effortSchema.nullable().optional(),
});

export type AskedModel = z.infer<typeof askedModelSchema>;

// What a reader asks to do from a row of a branch, the current one when none is named: write a
// reply again, with the thread's model or another; send their own message again
// changed; or make a new current branch ending at the row. `confirm` goes ahead past tool calls that
// changed something, which are not undone.
export const branchActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    rowId: z.string().min(1),
    with: askedModelSchema.optional(),
    confirm: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("edit"),
    rowId: z.string().min(1),
    text: messageTextSchema,
    confirm: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("restore"),
    rowId: z.string().min(1),
    branchId: z.string().min(1).optional(),
    confirm: z.boolean().optional(),
  }),
]);

export type BranchAction = z.infer<typeof branchActionSchema>;

// A tool call that changed something, as a confirmation lists it.
export const undoneCallSchema = z.object({ title: z.string(), toolset: z.string().nullable() });

// What an action did: the branch it made current; or, before it goes past tool calls that changed
// something, those calls to confirm.
export const branchActionResultSchema = z.union([
  z.object({ branchId: z.string() }),
  z.object({ confirm: z.array(undoneCallSchema) }),
]);

export type BranchActionResult = z.infer<typeof branchActionResultSchema>;

// Where a new thread forks from: a row of a branch, the current one when none is named.
export const forkSchema = z.object({
  rowId: z.string().min(1),
  branchId: z.string().min(1).optional(),
});

// A side question about a row: what was asked and answered, in order, the answer still being
// written last while it is. An answer that failed has no text: it was stopped, or failed with
// what the model or provider said, where it said anything.
export const asideTurnSchema = z.object({
  id: z.string(),
  role: z.enum(["question", "answer"]),
  text: z.string(),
  at: z.string(),
  model: z.string().nullable().optional(),
  failure: z.enum(["stopped", "error"]).optional(),
  error: z.string().optional(),
});

export const asideSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  rowId: z.string(),
  createdAt: z.string(),
  turns: z.array(asideTurnSchema),
});

export type Aside = z.infer<typeof asideSchema>;

export const asideListSchema = z.array(asideSchema);

// A side question about a row of a branch, the current one when none is named.
export const newAsideSchema = z.object({
  rowId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  text: messageTextSchema,
});

export const asideFollowUpSchema = z.object({ text: messageTextSchema });

// What asking aside sends back as the answer is written, one JSON line each: the side question as
// it stands, first with the question and last once answered, and between them each piece of the
// answer.
export const asideStreamItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aside"), aside: asideSchema }),
  z.object({ type: z.literal("delta"), text: z.string() }),
]);

export type AsideStreamItem = z.infer<typeof asideStreamItemSchema>;

// What a person's inbox stream says.

import * as z from "zod";

import { threadListItemSchema } from "@/shared/threads/list.ts";

// What a person's inbox stream says: a thread they can read changed, as it now reads for them and
// whether they are its guest; they saw a thread up to a seq, here or on another device; or a thread
// is gone for them, deleted or no longer theirs to read.
export const inboxItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: threadListItemSchema, shared: z.boolean() }),
  z.object({ kind: z.literal("read"), threadId: z.string(), seq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("gone"), threadId: z.string() }),
]);

export type InboxItem = z.infer<typeof inboxItemSchema>;

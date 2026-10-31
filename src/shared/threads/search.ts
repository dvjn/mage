// Searching threads by title.

import * as z from "zod";

import { shownModelSchema, threadActivitySchema } from "@/shared/threads/list.ts";
import { threadSchema } from "@/shared/threads/thread.ts";

// Text to find in thread titles, every thread without any, and the folder to look in, if one.
export const threadSearchSchema = z.object({
  q: z.string().trim().max(200).default(""),
  folder: z.string().max(100).optional(),
});

// A thread found by title, with the space it is in, whether it is one shared with the reader from
// outside their spaces, the model it shows, and what it holds for the reader.
export const threadSearchResultSchema = threadSchema.extend({
  spaceName: z.string(),
  shared: z.boolean(),
  shownModel: shownModelSchema.nullable(),
  activity: threadActivitySchema,
});

export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;

export const threadSearchListSchema = z.array(threadSearchResultSchema);

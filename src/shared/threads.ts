// Threads and their events as the API shows them, the bodies that make and change them, and
// searching them by title, shared by the server and the web client.

import * as z from "zod";

export const threadSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  // The folder it is in, or null at the top of the space.
  folderId: z.string().nullable(),
  title: z.string(),
  // A model ref, or null when the thread has none yet.
  model: z.string().nullable(),
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ThreadSummary = z.infer<typeof threadSchema>;

export const threadListSchema = z.array(threadSchema);

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

export const messageDataSchema = z.object({ parts: z.array(textPartSchema) });

export type MessageData = z.infer<typeof messageDataSchema>;

// Who an event is from. `name` is "(former member)" once the user is gone.
export const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("agent") }),
]);

export type ActorSummary = z.infer<typeof actorSchema>;

const eventFields = {
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int().positive(),
  actor: actorSchema,
  createdAt: z.iso.datetime(),
};

export const threadEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventFields, type: z.literal("message"), data: messageDataSchema }),
]);

export type ThreadEventSummary = z.infer<typeof threadEventSchema>;

// Any event, including types this client does not know yet.
export const anyThreadEventSchema = z.object({
  ...eventFields,
  type: z.string(),
  data: z.unknown(),
});

export type AnyThreadEvent = z.infer<typeof anyThreadEventSchema>;

export const threadDetailSchema = z.object({
  thread: threadSchema,
  events: z.array(anyThreadEventSchema),
});

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const messageInputSchema = z.object({ text: z.string().trim().min(1).max(100_000) });

export const newThreadSchema = z.object({
  text: messageInputSchema.shape.text.optional(),
  folderId: z.string().min(1).nullable().optional(),
});

export const threadUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().min(1).optional(),
  // Null moves the thread to the top of its space.
  folderId: z.string().min(1).nullable().optional(),
});

// Text to find in thread titles.
export const threadSearchSchema = z.object({ q: z.string().trim().min(1).max(200) });

// A thread found by title, with the space it is in.
export const threadSearchResultSchema = threadSchema.extend({ spaceName: z.string() });

export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;

export const threadSearchListSchema = z.array(threadSearchResultSchema);

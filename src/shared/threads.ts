// Threads and their events as the API shows them, the bodies that make and change them, and
// searching them by title, shared by the server and the web client. A thread's events are its
// messages, when the agent took each one in, the agent's runs and the replies each run wrote.

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

// A message starting with this is an aside between people: the agent sees it in later runs, but it
// never wakes the agent.
export const QUIET_PREFIX = "//";

export const messageDataSchema = z.object({
  parts: z.array(textPartSchema),
  // Starts with the quiet prefix.
  quiet: z.boolean(),
});

export type MessageData = z.infer<typeof messageDataSchema>;

// Why a run follows an earlier one: someone interrupted it, input waited for it to end, or it is
// tried again after the server stopped during it.
export const runReasonSchema = z.enum(["interrupt", "queued_input", "retry"]);

export type RunReason = z.infer<typeof runReasonSchema>;

// How a reply ended: in full, cut short by someone, or cut short by a failure.
export const replyStatusSchema = z.enum(["completed", "interrupted", "failed"]);

export type ReplyStatus = z.infer<typeof replyStatusSchema>;

// Each event type's data.
export const eventDataSchemas = {
  // A person's message.
  message: messageDataSchema,
  // The agent took these messages in, in this order, during the run.
  "message.admitted": z.object({ runId: z.string(), messageIds: z.array(z.string()).min(1) }),
  // The agent began a reply; its place in the thread is this event's seq.
  "message.started": z.object({ messageId: z.string(), runId: z.string() }),
  // The reply begun as messageId ended with this content.
  "message.completed": z.object({
    messageId: z.string(),
    runId: z.string(),
    parts: z.array(textPartSchema),
    status: replyStatusSchema,
  }),
  // Someone's message woke the agent.
  "run.created": z.object({
    runId: z.string(),
    reason: runReasonSchema.nullable(),
    continuesRunId: z.string().nullable(),
  }),
  "run.completed": z.object({ runId: z.string() }),
  "run.failed": z.object({ runId: z.string(), error: z.string() }),
};

export type EventDataMap = {
  [Type in keyof typeof eventDataSchemas]: z.infer<(typeof eventDataSchemas)[Type]>;
};

export type EventType = keyof EventDataMap;

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

function eventSchema<Type extends EventType>(type: Type) {
  return z.object({ ...eventFields, type: z.literal(type), data: eventDataSchemas[type] });
}

export const threadEventSchema = z.discriminatedUnion("type", [
  eventSchema("message"),
  eventSchema("message.admitted"),
  eventSchema("message.started"),
  eventSchema("message.completed"),
  eventSchema("run.created"),
  eventSchema("run.completed"),
  eventSchema("run.failed"),
]);

export type ThreadEventSummary = z.infer<typeof threadEventSchema>;

// Any event, including types this client does not know yet.
export const anyThreadEventSchema = z.object({
  ...eventFields,
  type: z.string(),
  data: z.unknown(),
});

export type AnyThreadEvent = z.infer<typeof anyThreadEventSchema>;

// Pieces of an agent reply in progress: `texts[0]` is its piece number `index`, the rest follow.
export const deltaBatchSchema = z.object({
  messageId: z.string(),
  index: z.number().int().nonnegative(),
  texts: z.array(z.string()),
});

export type DeltaBatch = z.infer<typeof deltaBatchSchema>;

// What a thread's followers are told: each event appended, and each batch of reply pieces stored.
export type ThreadFeedItem =
  | { kind: "event"; event: ThreadEventSummary }
  | { kind: "delta"; delta: DeltaBatch };

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

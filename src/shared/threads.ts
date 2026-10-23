// Threads and their events as the API shows them, the bodies that make and change them, and
// searching them by title, shared by the server and the web client. A thread's events are its
// messages, when the agent took each one in, the agent's runs and the replies each run wrote.

import * as z from "zod";

// How hard a model that can think does so before it answers.
export const effortSchema = z.enum(["low", "medium", "high"]);

export type Effort = z.infer<typeof effortSchema>;

export const threadSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  // The folder it is in, or null at the top of the space.
  folderId: z.string().nullable(),
  title: z.string(),
  // Nobody and nothing has named it yet; its title is then "Untitled".
  untitled: z.boolean(),
  // A model ref, or null to follow its space's default, then its org's.
  model: z.string().nullable(),
  // The reasoning effort its model is asked for, or null to follow its space's default, then its
  // org's, then the model's usual one.
  effort: effortSchema.nullable(),
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ThreadSummary = z.infer<typeof threadSchema>;

// A thread in its space's list, with the start of its newest message or reply and who wrote it.
export const threadListItemSchema = threadSchema.extend({
  preview: z.object({ author: z.string(), text: z.string() }).nullable(),
});

export type ThreadListItem = z.infer<typeof threadListItemSchema>;

export const threadListSchema = z.array(threadListItemSchema);

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

// What a model thought before it answered, or the provider's summary of it, and for how long.
export const reasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const replyPartSchema = z.discriminatedUnion("type", [textPartSchema, reasoningPartSchema]);

export type ReplyPart = z.infer<typeof replyPartSchema>;

// A message starting with this is an aside between people: the agent sees it in later runs, but it
// never wakes the agent.
export const QUIET_PREFIX = "//";

// What a message posted while the agent is busy asks for: to steer the run under way at its next
// step boundary, to wait in the queue for the next run, or to stop the run and start the next one
// with it at once.
export const deliverySchema = z.enum(["steer", "queue", "interrupt"]);

export type Delivery = z.infer<typeof deliverySchema>;

export const messageDataSchema = z.object({
  parts: z.array(textPartSchema),
  // Starts with the quiet prefix.
  quiet: z.boolean(),
  // Messages from before there were deliveries steer.
  mode: deliverySchema.default("steer"),
  // Written by a guest of the thread rather than a member of its space.
  guest: z.boolean().optional(),
});

export type MessageData = z.infer<typeof messageDataSchema>;

// Why a run follows an earlier one: someone interrupted it, input waited for it to end, or it is
// tried again after the server stopped during it.
export const runReasonSchema = z.enum(["interrupt", "queued_input", "retry"]);

export type RunReason = z.infer<typeof runReasonSchema>;

// How a reply ended: in full, cut short by someone, or cut short by a failure.
export const replyStatusSchema = z.enum(["completed", "interrupted", "failed"]);

export type ReplyStatus = z.infer<typeof replyStatusSchema>;

// Why a run failed, sorted by what people can do about it: sign in to the provider again, wait for
// a limit to reset, pick another model, or try again once the provider can be reached.
export const failureKindSchema = z.enum(["auth", "limit", "model", "network"]);

export type FailureKind = z.infer<typeof failureKindSchema>;

// Tokens a model call read and wrote.
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export type Usage = z.infer<typeof usageSchema>;

// Each event type's data.
export const eventDataSchemas = {
  // A person's message.
  message: messageDataSchema,
  // The author changed a message the agent has not taken in yet.
  "message.changed": z.object({
    messageId: z.string(),
    parts: z.array(textPartSchema).optional(),
    mode: deliverySchema.optional(),
  }),
  // The author took back a message the agent has not taken in yet.
  "message.withdrawn": z.object({ messageId: z.string() }),
  // The agent took these messages in, in this order, during the run.
  "message.admitted": z.object({ runId: z.string(), messageIds: z.array(z.string()).min(1) }),
  // The agent began a reply with the model ref; its place in the thread is this event's seq.
  "message.started": z.object({
    messageId: z.string(),
    runId: z.string(),
    model: z.string().optional(),
  }),
  // The reply begun as messageId ended with this content, and the tokens the model step that
  // wrote it used when it finished.
  "message.completed": z.object({
    messageId: z.string(),
    runId: z.string(),
    parts: z.array(replyPartSchema),
    status: replyStatusSchema,
    usage: usageSchema.optional(),
  }),
  // Someone's message woke the agent.
  "run.created": z.object({
    runId: z.string(),
    reason: runReasonSchema.nullable(),
    continuesRunId: z.string().nullable(),
  }),
  "run.completed": z.object({ runId: z.string() }),
  // The agent named the thread after its first message, with the tokens that took.
  "thread.renamed": z.object({ title: z.string(), usage: usageSchema.optional() }),
  // `error` says what happened; when the failure has a kind, `connection` is the kind of connection
  // the model is reached through, `detail` what the provider said and `resetsAt` when a limit
  // resets.
  "run.failed": z.object({
    runId: z.string(),
    error: z.string(),
    kind: failureKindSchema.optional(),
    connection: z.enum(["codex", "claude"]).optional(),
    detail: z.string().optional(),
    resetsAt: z.iso.datetime().optional(),
  }),
  // The actor stopped the run.
  "run.cancelled": z.object({ runId: z.string() }),
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
  eventSchema("message.changed"),
  eventSchema("message.withdrawn"),
  eventSchema("message.admitted"),
  eventSchema("message.started"),
  eventSchema("message.completed"),
  eventSchema("run.created"),
  eventSchema("run.completed"),
  eventSchema("run.failed"),
  eventSchema("run.cancelled"),
  eventSchema("thread.renamed"),
]);

export type ThreadEventSummary = z.infer<typeof threadEventSchema>;

// Any event, including types this client does not know yet.
export const anyThreadEventSchema = z.object({
  ...eventFields,
  type: z.string(),
  data: z.unknown(),
});

export type AnyThreadEvent = z.infer<typeof anyThreadEventSchema>;

// Pieces of an agent reply in progress: `texts[0]` is its piece number `index`, the rest follow,
// all of its answer or, with `part`, all of its reasoning.
export const deltaBatchSchema = z.object({
  messageId: z.string(),
  index: z.number().int().nonnegative(),
  texts: z.array(z.string()),
  part: z.literal("reasoning").optional(),
});

export type DeltaBatch = z.infer<typeof deltaBatchSchema>;

// What a thread's followers are told: each event appended, and each batch of reply pieces stored.
export type ThreadFeedItem =
  | { kind: "event"; event: ThreadEventSummary }
  | { kind: "delta"; delta: DeltaBatch };

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
  // The default that replies: the space's while it can, else the org's; none when neither can.
  used: z.object({ ref: z.string(), name: z.string() }).nullable().optional(),
});

export type ThreadDefaults = z.infer<typeof threadDefaultsSchema>;

export const threadDetailSchema = z.object({
  thread: threadSchema,
  events: z.array(anyThreadEventSchema),
  access: threadAccessSchema,
  defaults: threadDefaultsSchema,
  // The model it names, its own or the default, and the one that replies: the same, or while that
  // one is turned off or gone, the space's default, then the org's; null when none can. Null with
  // no model at all.
  model: z
    .object({ chosen: modelAvailabilitySchema, used: modelAvailabilitySchema.nullable() })
    .nullable(),
});

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

const messageTextSchema = z.string().trim().min(1).max(100_000);

export const messageInputSchema = z.object({
  text: messageTextSchema,
  mode: deliverySchema.default("steer"),
});

// A change to a message still waiting: its text, or steering instead of queueing or back.
export const pendingChangeSchema = z
  .object({
    text: messageTextSchema.optional(),
    mode: z.enum(["steer", "queue"]).optional(),
  })
  .refine((change) => change.text !== undefined || change.mode !== undefined);

// A new thread: its first message, its folder, and the model and effort it starts with instead of
// its space's defaults.
export const newThreadSchema = z.object({
  text: messageTextSchema.optional(),
  folderId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
});

export const threadUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  // Null follows the space's default model.
  model: z.string().min(1).nullable().optional(),
  // Null follows the space's default effort.
  effort: effortSchema.nullable().optional(),
  // Null moves the thread to the top of its space.
  folderId: z.string().min(1).nullable().optional(),
});

// The run whose reply to try again.
export const retrySchema = z.object({ runId: z.string().min(1) });

// Text to find in thread titles.
export const threadSearchSchema = z.object({ q: z.string().trim().min(1).max(200) });

// A thread found by title, with the space it is in, and whether it is one shared with the reader
// from outside their spaces.
export const threadSearchResultSchema = threadSchema.extend({
  spaceName: z.string(),
  shared: z.boolean(),
});

export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;

export const threadSearchListSchema = z.array(threadSearchResultSchema);

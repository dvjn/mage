// Threads and their events as the API shows them, the bodies that make and change them, and
// searching them by title, shared by the server and the web client. A thread's events are its
// messages, when the agent took each one in, the agent's runs and the replies each run wrote.

import * as z from "zod";

import { askAnswersSchema } from "@/shared/ask.ts";
import { hostIdSchema } from "@/shared/hosts.ts";
import { MAKER_IDS } from "@/shared/makers.ts";
import { toolDefinitionSchema } from "@/shared/tools.ts";

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

// A thread in its space's list, with the model it shows (null with none at all), who has written
// in it, and what it holds for the reader.
export const threadListItemSchema = threadSchema.extend({
  shownModel: shownModelSchema.nullable(),
  participants: threadParticipantsSchema,
  activity: threadActivitySchema,
});

export type ThreadListItem = z.infer<typeof threadListItemSchema>;

export const threadListSchema = z.array(threadListItemSchema);

// How many threads of each folder, and of the top of a space, its sidebar lists.
export const SIDEBAR_LIMIT = 30;

// A space's threads as its sidebar lists them for the reader: the newest of each folder and of the
// top of the space, up to the limit, and beside them, older, those that say what a closed folder
// holds and those that need the reader; how many threads the top of the space and each folder hold,
// by id; and how many threads need the reader in all.
export const threadSidebarSchema = z.object({
  threads: z.array(threadListItemSchema),
  loose: z.number().int(),
  folders: z.record(z.string(), z.number().int()),
  needsYou: z.number().int(),
});

export type ThreadSidebar = z.infer<typeof threadSidebarSchema>;

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

// What a model thought before it answered, or the provider's summary of it, and for how long.
export const reasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const replyPartSchema = z.discriminatedUnion("type", [textPartSchema, reasoningPartSchema]);

export type ReplyPart = z.infer<typeof replyPartSchema>;

// What an untitled thread is called, and found by.
export const UNTITLED = "Untitled";

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

// How much a tool call can do: run when everyone the agent read may run it, or ask a person who may
// every time. Reviews by someone outside the thread come later.
export const toolRiskSchema = z.enum(["normal", "ask", "review"]);

export type ToolRisk = z.infer<typeof toolRiskSchema>;

// Why a tool call did not run: someone denied it, the approval no longer held when it was to run,
// the run ended first, or someone skipped the questions it asked.
export const toolDenialSchema = z.enum(["denied", "stale", "stopped", "skipped"]);

// An approval for this call alone, or for later calls of the tool in the thread until input that
// needs approval arrives.
export const toolScopeSchema = z.enum(["once", "for_now"]);

export type ToolScope = z.infer<typeof toolScopeSchema>;

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
  // A message the agent had not taken in yet was dropped: its author can no longer post.
  "message.dropped": z.object({ messageId: z.string() }),
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
  // resets. Older events can name the Claude sign-in, since removed.
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
  // The agent asked to call a tool in the reply begun as messageId; `waits` when it needs a
  // person's approval first.
  "tool.requested": z.object({
    runId: z.string(),
    callId: z.string(),
    messageId: z.string(),
    toolId: z.string(),
    input: z.unknown(),
    risk: toolRiskSchema,
    waits: z.boolean(),
  }),
  // The actor approved the call.
  "tool.approved": z.object({ runId: z.string(), callId: z.string(), scope: toolScopeSchema }),
  // The actor answered the questions the call asks; the first answer wins.
  "tool.answered": z.object({ runId: z.string(), callId: z.string(), answers: askAnswersSchema }),
  // The call will not run, and why.
  "tool.denied": z.object({ runId: z.string(), callId: z.string(), reason: toolDenialSchema }),
  // The call ran, with what it gave back or why it failed, in milliseconds.
  "tool.ran": z.object({
    runId: z.string(),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
    ms: z.number().int().nonnegative(),
  }),
};

export type EventDataMap = {
  [Type in keyof typeof eventDataSchemas]: z.infer<(typeof eventDataSchemas)[Type]>;
};

export type EventType = keyof EventDataMap;

// Who an event is from. `name` is "(former member)" once the user is gone; `former` marks someone
// removed from the thread's org.
export const actorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userId: z.string(),
    name: z.string(),
    former: z.boolean().optional(),
  }),
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
  eventSchema("message.dropped"),
  eventSchema("message.admitted"),
  eventSchema("message.started"),
  eventSchema("message.completed"),
  eventSchema("run.created"),
  eventSchema("run.completed"),
  eventSchema("run.failed"),
  eventSchema("run.cancelled"),
  eventSchema("thread.renamed"),
  eventSchema("tool.requested"),
  eventSchema("tool.approved"),
  eventSchema("tool.answered"),
  eventSchema("tool.denied"),
  eventSchema("tool.ran"),
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

// A person's decision on a tool call waiting for one.
export const toolDecisionSchema = z.object({
  allow: z.boolean(),
  scope: toolScopeSchema.default("once"),
});

// How far into the thread the reader has seen.
export const threadReadSchema = z.object({ seq: z.number().int().nonnegative() });

// What a person's inbox stream says: a thread they can read changed, as it now reads for them and
// whether they are its guest; they saw a thread up to a seq, here or on another device; or a thread
// is gone for them, deleted or no longer theirs to read.
export const inboxItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: threadListItemSchema, shared: z.boolean() }),
  z.object({ kind: z.literal("read"), threadId: z.string(), seq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("gone"), threadId: z.string() }),
]);

export type InboxItem = z.infer<typeof inboxItemSchema>;

// The run whose reply to try again.
export const retrySchema = z.object({ runId: z.string().min(1) });

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

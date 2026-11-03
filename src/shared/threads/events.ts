// A thread's events as the API shows them: people's messages and the notifications its agent is
// sent, when the agent took each one in, the agent's runs and the replies each run wrote, its tool
// calls, its compactions, and the pieces of a reply in progress.

import * as z from "zod";

import { askAnswersSchema } from "@/shared/ask.ts";

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
  // Sent as a command: its name and what followed it, and what the agent reads in its place.
  command: z.object({ name: z.string(), args: z.string(), text: z.string().optional() }).optional(),
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

// A person whose words steered an agent's message, and the agents those words came through on the
// way, nearest the person first; none when they wrote in the sending agent's own thread.
export const steeringSchema = z.object({
  userId: z.string(),
  name: z.string(),
  via: z.array(z.string()),
});

export type Steering = z.infer<typeof steeringSchema>;

// The agent that sent a message: a subagent, by the name it was given, or the agent of the thread
// that started the subagents, named as that thread was.
export const senderSchema = z.object({
  threadId: z.string(),
  name: z.string(),
  main: z.boolean(),
});

export type Sender = z.infer<typeof senderSchema>;

// What a subagent was set to do when it was started, beside its task: its instructions, and for one
// started from a copy of its starter's conversation, the call that started it and the newest event
// of that conversation it was copied up to.
export const subagentTaskSchema = z.object({
  instructions: z.string().optional(),
  fork: z.object({ callId: z.string(), seq: z.number().int().nonnegative() }).optional(),
});

export type SubagentTask = z.infer<typeof subagentTaskSchema>;

// The tool call that made an event in another thread: the thread it was made in, and its id.
export const causeSchema = z.object({ threadId: z.string(), callId: z.string() });

export type Cause = z.infer<typeof causeSchema>;

// What a notification tells the agent it reaches: another agent's message; that a subagent ended
// a run without sending its starter anything, failed, or was stopped; or that the subagents a
// watch was set on went idle.
export const notificationKindSchema = z.enum([
  "message",
  "agent.ended",
  "agent.failed",
  "agent.stopped",
  "agent.idle",
]);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

// What made a notification: the agent whose thread it came from, and the call or the row there it
// came of, where there is one.
export const notificationSourceSchema = senderSchema.extend({
  callId: z.string().optional(),
  rowId: z.string().optional(),
});

export type NotificationSource = z.infer<typeof notificationSourceSchema>;

// Where a subagent stands once its run ended: waiting for more, stopped, or failed.
export const subagentEndSchema = z.enum(["idle", "stopped", "failed"]);

export type SubagentEnd = z.infer<typeof subagentEndSchema>;

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
  // No longer written: another agent's message to this thread's agent, with the people whose words
  // steered it, now a notification. The first one in a subagent's thread is its task.
  "agent.message": z.object({
    parts: z.array(textPartSchema),
    from: senderSchema,
    // Whom it was sent to, as the sender named them.
    to: z.string(),
    steeredBy: z.array(steeringSchema),
    task: subagentTaskSchema.optional(),
    // The call that sent it; older messages do not say.
    call: causeSchema.optional(),
  }),
  // Something the thread's agent is told, with everyone whose words it carries, who count as
  // steering what the agent does with it. It waits like a person's message until the agent takes
  // it in. A message names whom it was sent to, and the first in a subagent's thread is its task.
  notification: z.object({
    kind: notificationKindSchema,
    source: notificationSourceSchema,
    text: z.string(),
    people: z.array(steeringSchema),
    to: z.string().optional(),
    task: subagentTaskSchema.optional(),
  }),
  // No longer written: one of the thread's subagents ended a run with nothing more to do, and the
  // last thing it said.
  "subagent.ended": z.object({
    threadId: z.string(),
    name: z.string(),
    state: subagentEndSchema,
    last: z.string(),
  }),
  // The thread's subagents sent each other as many messages as they may; more are refused. With
  // the call first refused, in its subagent's thread.
  "subagent.limited": z.object({
    limit: z.number().int().positive(),
    call: causeSchema.optional(),
  }),
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
  // The thread was compacted, by the person who asked or by the agent: from here the agent reads
  // the summary in place of the rows before the one at `firstKeptSeq`, then those from it on.
  // With the focus it was asked to keep, about how many tokens the agent read before and after,
  // and the tokens the summary took.
  "thread.compacted": z.object({
    summary: z.string(),
    firstKeptSeq: z.number().int().positive(),
    focus: z.string().optional(),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative().optional(),
    usage: usageSchema.optional(),
  }),
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
    // What the tool and its toolset were called when it was asked for, for a tool that was there.
    title: z.string().optional(),
    toolset: z.string().optional(),
  }),
  // The actor approved the call.
  "tool.approved": z.object({ runId: z.string(), callId: z.string(), scope: toolScopeSchema }),
  // The actor answered the questions the call asks; the first answer wins.
  "tool.answered": z.object({ runId: z.string(), callId: z.string(), answers: askAnswersSchema }),
  // The call will not run, and why.
  "tool.denied": z.object({ runId: z.string(), callId: z.string(), reason: toolDenialSchema }),
  // No longer written: older threads paused a call here for the person it would run as to connect
  // their own login. Read as the call waiting for approval.
  "tool.blocked": z.object({ runId: z.string(), callId: z.string(), userId: z.string() }),
  // The call ran, with what it gave back or why it failed, in milliseconds; for a tool that runs
  // with each person's own login, whose it ran with; and for a call that ran on a standing
  // approval, the call that approval was given on.
  "tool.ran": z.object({
    runId: z.string(),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
    ms: z.number().int().nonnegative(),
    ranAs: z.string().optional(),
    standingOn: z.string().optional(),
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
  eventSchema("agent.message"),
  eventSchema("notification"),
  eventSchema("subagent.ended"),
  eventSchema("subagent.limited"),
  eventSchema("message.admitted"),
  eventSchema("message.started"),
  eventSchema("message.completed"),
  eventSchema("run.created"),
  eventSchema("run.completed"),
  eventSchema("run.failed"),
  eventSchema("run.cancelled"),
  eventSchema("thread.renamed"),
  eventSchema("thread.compacted"),
  eventSchema("tool.requested"),
  eventSchema("tool.approved"),
  eventSchema("tool.answered"),
  eventSchema("tool.denied"),
  eventSchema("tool.blocked"),
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

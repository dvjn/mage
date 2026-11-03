// A thread's transcript as the server sends it to one reader: its rows, each with its place, the
// last event that changed it, where it sits in the agent's turn and what this reader may do from
// it; the messages the agent has not taken in, the run under way, and a page of earlier rows.

import * as z from "zod";

import { askAnswersSchema } from "@/shared/ask.ts";
import {
  deliverySchema,
  failureKindSchema,
  replyStatusSchema,
  toolRiskSchema,
  toolScopeSchema,
  usageSchema,
} from "@/shared/threads/events.ts";
import { toolConnectionSchema } from "@/shared/tools.ts";

// How many rows a page of a thread holds.
export const ROWS_PAGE = 100;

const personSchema = z.object({
  kind: z.literal("user"),
  userId: z.string(),
  name: z.string(),
  former: z.boolean().optional(),
});

// Where a row of the agent's sits in its turn: whether it follows another of the agent's rows, and
// the model the turn's reply was written with.
export const agentTurnSchema = z.object({
  continued: z.boolean(),
  model: z.string().nullable(),
});

// What every row has: its id, its place in the transcript, which never changes, the seq of the
// last event that changed it, and for the agent's rows that show, their turn.
const rowFields = {
  id: z.string(),
  order: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  turn: agentTurnSchema.nullable(),
};

// The command a message was sent as, as the person typed it: its name and what followed it.
const sentCommandSchema = z.object({ name: z.string(), args: z.string() });

const humanRowSchema = z.object({
  ...rowFields,
  kind: z.literal("human"),
  author: personSchema,
  postedAt: z.string(),
  text: z.string(),
  quiet: z.boolean(),
  // Written by a guest of the thread.
  guest: z.literal(true).optional(),
  command: sentCommandSchema.optional(),
});

const agentRowSchema = z.object({
  ...rowFields,
  kind: z.literal("agent"),
  runId: z.string(),
  model: z.string().nullable(),
  startedAt: z.string(),
  // Empty while it is being written; its pieces come live.
  text: z.string(),
  reasoning: z.string(),
  thoughtMs: z.number().nullable(),
  status: z.union([z.literal("streaming"), replyStatusSchema]),
  usage: usageSchema.nullable(),
  retried: z.boolean(),
});

// What the reader may do with a call that waits for a decision.
export const toolActionSchema = z.enum(["allow", "allow_for_now", "deny"]);

export type ToolAction = z.infer<typeof toolActionSchema>;

const toolRowSchema = z.object({
  ...rowFields,
  kind: z.literal("tool"),
  runId: z.string(),
  messageId: z.string(),
  toolId: z.string(),
  // What the tool is called, and the toolset or MCP server it comes in, where it has one.
  title: z.string(),
  toolset: z.string().nullable(),
  input: z.unknown(),
  // For a call that waits, the risk its tool's policy gives it now.
  risk: toolRiskSchema,
  waits: z.boolean(),
  requestedAt: z.string(),
  state: z.enum(["pending", "allowed", "denied", "ran", "failed", "stale", "stopped", "skipped"]),
  decision: z
    .object({
      allow: z.boolean(),
      scope: toolScopeSchema,
      by: personSchema,
      seq: z.number().int().nonnegative(),
    })
    .nullable(),
  answers: askAnswersSchema.optional(),
  output: z
    .union([
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .nullable(),
  ms: z.number().nullable(),
  ranAs: personSchema.optional(),
  standingOn: z.string().optional(),
  // For a call waiting for a decision, what the reader may decide; none while it waits on others.
  actions: z.array(toolActionSchema).optional(),
  // For a call waiting for answers, whether the reader may answer or skip them.
  canAnswer: z.boolean().optional(),
  // For a waiting call that would run with the reader's own credentials, their connection.
  connection: toolConnectionSchema.optional(),
});

// Whether the reader may try the run again, on the last row of one that failed or was stopped
// while nothing has run since.
const canRetry = z.boolean().optional();

const failureRowSchema = z.object({
  ...rowFields,
  kind: z.literal("failure"),
  runId: z.string(),
  error: z.string(),
  failure: failureKindSchema.optional(),
  connection: z.enum(["codex", "claude"]).optional(),
  detail: z.string().optional(),
  resetsAt: z.string().optional(),
  canRetry,
});

const stopRowSchema = z.object({
  ...rowFields,
  kind: z.literal("stop"),
  runId: z.string(),
  by: z.string().nullable(),
  canRetry,
});

// The thread compacted for the agent: by whom, null for the agent itself, the summary it reads from
// then on in place of what came before, the focus it was asked to keep, and about how many tokens
// it read before and after.
const compactionRowSchema = z.object({
  ...rowFields,
  kind: z.literal("compaction"),
  by: personSchema.nullable(),
  summary: z.string(),
  firstKeptSeq: z.number().int().nonnegative(),
  focus: z.string().optional(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative().nullable(),
});

// An event this client does not know how to show.
const unknownRowSchema = z.object({ ...rowFields, kind: z.literal("unknown"), type: z.string() });

export const shownRowSchema = z.discriminatedUnion("kind", [
  humanRowSchema,
  agentRowSchema,
  toolRowSchema,
  failureRowSchema,
  stopRowSchema,
  compactionRowSchema,
  unknownRowSchema,
]);

export type ShownRow = z.infer<typeof shownRowSchema>;
export type HumanRow = z.infer<typeof humanRowSchema>;
export type AgentRow = z.infer<typeof agentRowSchema>;
export type ToolRow = z.infer<typeof toolRowSchema>;
export type FailureRow = z.infer<typeof failureRowSchema>;
export type CompactionRow = z.infer<typeof compactionRowSchema>;
export type AgentTurn = z.infer<typeof agentTurnSchema>;

// A message posted while the agent was busy, waiting to be taken in.
export const pendingMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  author: personSchema,
  postedAt: z.string(),
  text: z.string(),
  mode: deliverySchema,
  guest: z.literal(true).optional(),
  command: sentCommandSchema.optional(),
});

export type PendingMessage = z.infer<typeof pendingMessageSchema>;

// The run under way: since when, whether it waits for answers to the agent's questions or for a
// decision on a call, and whether it compacts the thread.
export const shownRunSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  waiting: z.enum(["answer", "decision"]).nullable(),
  compacting: z.literal(true).optional(),
});

export type ShownRun = z.infer<typeof shownRunSchema>;

// What the live stream sends as the thread's log grows, up to the event `seq`: the rows that
// changed, whole, and the waiting messages and the run as they now are.
export const rowsUpdateSchema = z.object({
  seq: z.number().int().nonnegative(),
  rows: z.array(shownRowSchema),
  pending: z.array(pendingMessageSchema),
  run: shownRunSchema.nullable(),
});

export type RowsUpdate = z.infer<typeof rowsUpdateSchema>;

// What a page of earlier rows is asked for: the rows before a place, and at most how many.
export const rowsQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().min(1).max(ROWS_PAGE).optional(),
});

// The rows before a place, and the place of the first of them, or null once they reach the start.
export const rowsPageSchema = z.object({
  rows: z.array(shownRowSchema),
  before: z.number().int().nonnegative().nullable(),
});

export type RowsPage = z.infer<typeof rowsPageSchema>;

import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

import { user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";

// A conversation in a space; its content is its event log, in branches of which one is current.
export const thread = sqliteTable(
  "thread",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    // Null until the first message names it or someone sets it.
    title: text("title"),
    // Who named it: its first message, the agent after it, or a person; null while untitled.
    titleSource: text("title_source", { enum: ["message", "agent", "person"] }),
    // A model ref such as `codex/gpt-5`; null follows its space's default, then its org's.
    model: text("model"),
    // The reasoning effort its model is asked for; null follows the defaults, then the usual one.
    effort: text("effort", { enum: ["low", "medium", "high"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // For a subagent's thread, the thread its subagents descend from; its subagent row names the
    // thread that started it.
    rootThreadId: text("root_thread_id").references((): AnySQLiteColumn => thread.id, {
      onDelete: "cascade",
    }),
    // The branch people see and the agent reads: its root at first, which takes the thread's id.
    // A thread and its root branch name each other, so the two are written in one transaction
    // that checks their links only at its end.
    currentBranchId: text("current_branch_id")
      .notNull()
      .references((): AnySQLiteColumn => threadBranch.id),
    // What the members of its org outside its space may do in it: nothing, read it, or read and post.
    orgAccess: text("org_access", { enum: ["none", "view", "message"] })
      .default("none")
      .notNull(),
    // The seq of the thread's newest event in any branch; 0 before the first.
    lastEventSeq: integer("last_event_seq").default(0).notNull(),
    // The text of its newest message or reply without markdown, on one line, which lists find it by;
    // null before the first.
    lastMessageText: text("last_message_text"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("thread_space_idx").on(table.spaceId, table.updatedAt)],
);

// What happened in a thread, numbered 1, 2, 3… per thread with no gaps across its branches.
export const threadEvent = sqliteTable(
  "thread_event",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The branch it happened in.
    branchId: text("branch_id")
      .notNull()
      .references((): AnySQLiteColumn => threadBranch.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actorKind: text("actor_kind", { enum: ["user", "agent"] }).notNull(),
    // Kept after the user is gone, so their events still say who wrote them.
    actorUserId: text("actor_user_id"),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("thread_event_thread_seq_idx").on(table.threadId, table.seq),
    index("thread_event_thread_type_idx").on(table.threadId, table.type, table.seq),
    index("thread_event_branch_idx").on(table.branchId, table.seq),
  ],
);

// What a tool call gave back, where it is too large for its `tool.ran` event: kept apart, so the
// log stays light to read through, and read by the event's id where the result itself is needed.
export const toolResult = sqliteTable("tool_result", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => threadEvent.id, { onDelete: "cascade" }),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

// A line of a thread's conversation. The root holds what came before any other; every other
// branch starts from its parent as it was up to the event `forkSeq`, then goes on with events of
// its own. One that writes a row again, a person's message or a reply, names that row and the
// first row of the versions it joins; one restored from a row names that row.
export const threadBranch = sqliteTable(
  "thread_branch",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    parentBranchId: text("parent_branch_id").references((): AnySQLiteColumn => threadBranch.id, {
      onDelete: "cascade",
    }),
    forkSeq: integer("fork_seq"),
    kind: text("kind", { enum: ["root", "retry", "edit", "restore"] }).notNull(),
    rowId: text("row_id"),
    groupRowId: text("group_row_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("thread_branch_thread_idx").on(table.threadId, table.createdAt)],
);

// Where a branch's events come from: each branch it descends from, itself included, with the
// newest event it takes of that one, none for no limit. Written with the branch, never changed.
export const threadBranchSource = sqliteTable(
  "thread_branch_source",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => threadBranch.id, { onDelete: "cascade" }),
    sourceBranchId: text("source_branch_id")
      .notNull()
      .references(() => threadBranch.id, { onDelete: "cascade" }),
    untilSeq: integer("until_seq"),
  },
  (table) => [primaryKey({ columns: [table.branchId, table.sourceBranchId] })],
);

// How far into a thread a person has seen: the seq of the newest event they saw there, and when.
export const threadRead = sqliteTable(
  "thread_read",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    lastSeenSeq: integer("last_seen_seq").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);

// When a person last saw a kind of a thread's background work, so what ended before then no longer
// shows to them.
export const threadBackgroundSeen = sqliteTable(
  "thread_background_seen",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId, table.kind] })],
);

// The text an agent reply has streamed so far, of its answer and its reasoning, one row per piece
// the model sent, kept until the reply completes.
export const messageDelta = sqliteTable(
  "message_delta",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    // 0, 1, 2… per message, in the order the model sent them.
    index: integer("idx").notNull(),
    text: text("text").notNull(),
    // Whether the piece is of the answer or of the reasoning before it.
    part: text("part", { enum: ["text", "reasoning"] })
      .default("text")
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.index] }),
    index("message_delta_thread_idx").on(table.threadId),
  ],
);

// A side question someone asked about a row of a thread's branch: seen by them alone, and never
// read by the thread's agent.
export const aside = sqliteTable(
  "aside",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => threadBranch.id, { onDelete: "cascade" }),
    rowId: text("row_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("aside_thread_user_idx").on(table.threadId, table.userId)],
);

// What was asked and answered in a side question, in order: with the model each answer was
// written with, and whether writing it failed, its text then saying why.
export const asideTurn = sqliteTable(
  "aside_turn",
  {
    id: text("id").primaryKey(),
    asideId: text("aside_id")
      .notNull()
      .references(() => aside.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["question", "answer"] }).notNull(),
    text: text("text").notNull(),
    model: text("model"),
    failed: integer("failed", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("aside_turn_aside_idx").on(table.asideId, table.createdAt)],
);

import { sql } from "drizzle-orm";
import {
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
    parentThreadId: text("parent_thread_id"),
    rootThreadId: text("root_thread_id"),
    // The branch people see and the agent reads; set for every thread, its root's id being its own.
    currentBranchId: text("current_branch_id"),
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
    // The branch it happened in; set for every event.
    branchId: text("branch_id"),
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
    parentBranchId: text("parent_branch_id"),
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
    sourceBranchId: text("source_branch_id").notNull(),
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
    branchId: text("branch_id").notNull(),
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

// The subagents a thread's agent started, and the watches agents keep on subagents or tasks.

import { pgTable, text, index, primaryKey } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { thread } from "@/server/threads/schema.ts";

// A subagent a thread's agent started: the thread it works in, the thread whose agent started it,
// the name it was given, its instructions, and once it is retired, when.
export const subagent = pgTable(
  "subagent",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => thread.id, { onDelete: "cascade" }),
    parentThreadId: text("parent_thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The call in its starter's thread that started it.
    callId: text("call_id"),
    instructions: text("instructions"),
    archivedAt: at("archived_at"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [index("subagent_parent_idx").on(table.parentThreadId, table.createdAt)],
);

// An agent waiting to be told once about subjects: tasks of a list, until one is done or on any
// change, or subagents, until all or any of them are idle. `owner_id` is whose they are: the
// thread that owns the list, or the one that started the subagents. It ends once it has told.
export const threadWatch = pgTable(
  "thread_watch",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["tasks", "subagents"] }).notNull(),
    until: text("until", { enum: ["done", "changed", "all_idle", "any_idle"] }).notNull(),
    // The call that set it, which its notice answers.
    callId: text("call_id"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    index("thread_watch_thread_idx").on(table.threadId),
    index("thread_watch_owner_idx").on(table.ownerId, table.kind),
  ],
);

// What a watch waits on: a task's id, or a subagent's thread id.
export const threadWatchSubject = pgTable(
  "thread_watch_subject",
  {
    watchId: text("watch_id")
      .notNull()
      .references(() => threadWatch.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.watchId, table.subjectId] })],
);

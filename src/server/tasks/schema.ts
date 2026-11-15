// Threads' task lists, and the threads that work on another's list.

import { pgTable, text, integer, index, json } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import type { TaskActor, TaskAssignee, TaskStatus } from "@/shared/tasks.ts";
import { thread } from "@/server/threads/schema.ts";

// A task in a thread's list: its title, where it stands, whom it is for, its place in the list, and
// who made and last changed it, by the names they went by, and when it was archived.
export const threadTask = pgTable(
  "thread_task",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: ["todo", "doing", "done"] })
      .$type<TaskStatus>()
      .notNull(),
    assignee: json("assignee").$type<TaskAssignee | null>(),
    position: integer("position").notNull(),
    createdBy: json("created_by").$type<TaskActor>().notNull(),
    updatedBy: json("updated_by").$type<TaskActor>().notNull(),
    updatedAt: at("updated_at").default(NOW).notNull(),
    // Set once the task is archived: it leaves the list and stays as history.
    archivedAt: at("archived_at"),
  },
  (table) => [index("thread_task_thread_idx").on(table.threadId, table.position)],
);

// A thread whose agent works on another thread's task list in place of keeping its own: a
// subagent on its starter's.
export const taskShare = pgTable("task_share", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => thread.id, { onDelete: "cascade" }),
  ownerThreadId: text("owner_thread_id")
    .notNull()
    .references(() => thread.id, { onDelete: "cascade" }),
});

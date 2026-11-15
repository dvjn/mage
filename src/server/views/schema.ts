// The tables of what people have seen: how far into each thread, and when they last saw each kind
// of a thread's activity.

import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";

import { at } from "@/server/db/columns.ts";
import { user } from "@/server/orgs/schema.ts";
import { thread } from "@/server/threads/schema.ts";

// How far into a thread a person has seen: the seq of the newest event they saw there, and when.
export const threadRead = pgTable(
  "thread_read",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    lastSeenSeq: integer("last_seen_seq").notNull(),
    seenAt: at("seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);

// When a person last saw a kind of a thread's activity, so what ended before then no longer shows to
// them.
export const threadActivitySeen = pgTable(
  "thread_activity_seen",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    seenAt: at("seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId, table.kind] })],
);

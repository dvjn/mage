// Space memory entries: what the agent saved for the space, of a type and under a topic, with the
// call that saved it, whose words steered that call and who approved it. Entries are never
// changed: a newer one replaces an older one, which is retired and kept, and an owner forgetting
// one retires it too.

import { type SQL, sql } from "drizzle-orm";
import { customType, index, json, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";
import { MEMORY_TYPES } from "@/shared/memory.ts";
import type { Influencer } from "@/shared/threads/events.ts";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const memoryEntry = pgTable(
  "memory_entry",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    type: text("type", { enum: MEMORY_TYPES }).notNull(),
    topic: text("topic").notNull(),
    text: text("text").notNull(),
    // Its topic and text for full-text search, in English; searches parse queries the same way.
    search: tsvector("search").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${memoryEntry.topic} || ' ' || ${memoryEntry.text})`,
    ),
    // The thread and call that saved it.
    threadId: text("thread_id").references(() => thread.id, { onDelete: "set null" }),
    callId: text("call_id"),
    // Whose words the model had read when it asked to save it.
    influence: json("influence").$type<Influencer[]>().notNull(),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    // The entry it replaced.
    supersedesId: text("supersedes_id"),
    retiredAt: at("retired_at"),
    // Who forgot it; none when a newer entry replaced it.
    retiredBy: text("retired_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    index("memory_entry_space_idx").on(table.spaceId, table.retiredAt, table.createdAt),
    index("memory_entry_search_idx").using("gin", table.search),
    uniqueIndex("memory_entry_call_idx")
      .on(table.threadId, table.callId)
      .where(sql`${table.callId} is not null`),
  ],
);

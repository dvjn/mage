import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

import { thread } from "@/server/threads/schema.ts";
import { user } from "@/server/orgs/schema.ts";

// Someone outside the thread's space let into that one thread, until their access runs out or is
// revoked. One row per person and thread; inviting them again renews it.
export const threadGuest = sqliteTable(
  "thread_guest",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Whoever's invite last granted the access.
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // Null for access that does not run out.
    accessUntil: integer("access_until", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.userId] }),
    index("thread_guest_user_idx").on(table.userId),
  ],
);

// A single-use link that makes whoever opens it a guest of the thread. Only the hash of its token
// is kept.
export const threadInvite = sqliteTable(
  "thread_invite",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // The link works until then.
    linkExpiresAt: integer("link_expires_at", { mode: "timestamp_ms" }).notNull(),
    // How long the guest's access lasts from accepting.
    accessFor: text("access_for", { enum: ["1h", "1d", "7d", "never"] }).notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("thread_invite_thread_idx").on(table.threadId)],
);

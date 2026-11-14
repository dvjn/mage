import { pgTable, text, index, primaryKey } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";

import { thread } from "@/server/threads/schema.ts";
import { scimGroup, user } from "@/server/orgs/schema.ts";

// Someone outside the thread's space let into that one thread, until their access runs out or is
// revoked. One row per person and thread; inviting them again renews it.
export const threadGuest = pgTable(
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
    createdAt: at("created_at").default(NOW).notNull(),
    // Whether they may only read it or post in it too.
    role: text("role", { enum: ["view", "message"] })
      .default("message")
      .notNull(),
    // Null for access that does not run out.
    accessUntil: at("access_until"),
    revokedAt: at("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.userId] }),
    index("thread_guest_user_idx").on(table.userId),
  ],
);

// A directory group let into one thread as guests, for as long as the grant lasts: whoever is in the
// group while it does has the access, so people who join gain it and leavers lose it.
export const threadGroupGuest = pgTable(
  "thread_group_guest",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    role: text("role", { enum: ["view", "message"] })
      .default("message")
      .notNull(),
    // Null for access that does not run out.
    accessUntil: at("access_until"),
    revokedAt: at("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.groupId] }),
    index("thread_group_guest_group_idx").on(table.groupId),
  ],
);

// A single-use link that makes whoever opens it a guest of the thread. Only the hash of its token
// is kept.
export const threadInvite = pgTable(
  "thread_invite",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    // The link works until then.
    linkExpiresAt: at("link_expires_at").notNull(),
    // How long the guest's access lasts from accepting.
    accessFor: text("access_for", { enum: ["1h", "1d", "7d", "never"] }).notNull(),
    // What the guest may do, when it is used.
    role: text("role", { enum: ["view", "message"] })
      .default("message")
      .notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: at("accepted_at"),
    revokedAt: at("revoked_at"),
  },
  (table) => [index("thread_invite_thread_idx").on(table.threadId)],
);

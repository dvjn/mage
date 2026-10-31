import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, blob, primaryKey } from "drizzle-orm/sqlite-core";

import { AUTH_KINDS } from "@/shared/hosts.ts";
import { user, organization } from "@/server/orgs/schema.ts";

// A provider account an org reaches models through.
export const connection = sqliteTable(
  "connection",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user who connected it; null once that user is gone.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // Who serves its models, as the host registry names it.
    host: text("host").notNull(),
    // A subscription sign-in, a key, cloud credentials or a server's address.
    authKind: text("auth_kind", { enum: AUTH_KINDS }).notNull(),
    // The account, as shown to people; for a key, its masked hint.
    account: text("account").notNull(),
    // A name people gave it; null for sign-ins.
    label: text("label"),
    // What is not secret about how it connects, as JSON; null where it says nothing.
    settings: text("settings", { mode: "json" }).$type<Record<string, string>>(),
    // Whether models the provider adds are turned on when first seen.
    autoEnableModels: integer("auto_enable_models", { mode: "boolean" }).default(true).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  // One sign-in of each host per org; the rest as many as people add.
  (table) => [
    uniqueIndex("connection_org_sign_in_idx")
      .on(table.organizationId, table.host)
      .where(sql`${table.authKind} = 'oauth'`),
  ],
);

// Each model a connection's list has shown, whether people can pick it, and when it first showed.
export const connectionModel = sqliteTable(
  "connection_model",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.modelId] })],
);

// A connection's secrets, sealed with the credential key of the recorded version.
export const credential = sqliteTable("credential", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connection.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull(),
  sealed: blob("sealed", { mode: "buffer" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

// A browser sign-in a user started and had not finished, from when Mage offered them; nothing
// writes it now.
export const signInAttempt = sqliteTable("sign_in_attempt", {
  state: text("state").primaryKey(),
  kind: text("kind", { enum: ["codex"] }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

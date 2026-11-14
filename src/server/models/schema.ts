import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  uniqueIndex,
  primaryKey,
  boolean,
  json,
} from "drizzle-orm/pg-core";

import { at, bytes, NOW } from "@/server/db/columns.ts";
import { leaseColumns } from "@/server/sync/lease.ts";

import { AUTH_KINDS } from "@/shared/hosts.ts";
import { user, organization } from "@/server/orgs/schema.ts";

// A provider account an org reaches models through.
export const connection = pgTable(
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
    settings: json("settings").$type<Record<string, string>>(),
    // Whether models the provider adds are turned on when first seen.
    autoEnableModels: boolean("auto_enable_models").default(true).notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
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
export const connectionModel = pgTable(
  "connection_model",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    enabled: boolean("enabled").notNull(),
    firstSeenAt: at("first_seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.modelId] })],
);

// A connection's secrets, sealed with the credential key of the recorded version.
export const credential = pgTable("credential", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connection.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull(),
  sealed: bytes("sealed").notNull(),
  createdAt: at("created_at").default(NOW).notNull(),
  updatedAt: at("updated_at")
    .default(NOW)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  // Held by the instance renewing the tokens, so a rotating refresh token is spent once.
  ...leaseColumns(),
});

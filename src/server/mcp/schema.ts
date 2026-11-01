import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, blob, primaryKey } from "drizzle-orm/sqlite-core";

import { space } from "@/server/spaces/schema.ts";
import { user, organization } from "@/server/orgs/schema.ts";

// An MCP server an org's owners added for all its spaces, or a space's managers for that space
// alone, with the tools it last listed. One turned off keeps everything but offers no tools.
export const mcpServer = sqliteTable(
  "mcp_server",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The space it was added for; null for the whole org.
    spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // What the agent calls it, unique among the servers a space has; null until given one.
    slug: text("slug"),
    url: text("url").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    // How it is authorized: not at all, by headers, or by OAuth.
    authKind: text("auth_kind", { enum: ["none", "headers", "oauth"] }).notNull(),
    // Whose credentials its tools are called with: the one set everyone shares, or each person's
    // own, the shared set then only reading its tools.
    credentials: text("credentials", { enum: ["shared", "personal"] })
      .default("shared")
      .notNull(),
    // What is not secret about its authorization, as JSON: header names with hints, the OAuth
    // client and authorization server.
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // The transport it last answered on; null until it has.
    transport: text("transport", { enum: ["streamable-http", "sse"] }),
    // The protocol revision it last answered with; null until it has.
    protocolVersion: text("protocol_version"),
    // Whether it answered when last reached, needs authorizing again, or failed, and why.
    status: text("status", { enum: ["ok", "needs_auth", "error"] }).notNull(),
    error: text("error"),
    // The name and version it gave, and the tools it listed, as JSON.
    serverInfo: text("server_info", { mode: "json" }).$type<{ name: string; version: string }>(),
    tools: text("tools", { mode: "json" }).$type<unknown[]>().notNull(),
    toolsReadAt: integer("tools_read_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("mcp_server_org_idx").on(table.organizationId),
    index("mcp_server_space_idx").on(table.spaceId),
  ],
);

// An MCP server's secrets sealed by the cipher: its headers or OAuth client and tokens, shared by
// everyone who uses the server, or one person's own.
export const mcpCredential = sqliteTable(
  "mcp_credential",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    holderKind: text("holder_kind", { enum: ["shared", "user"] }).notNull(),
    // The user whose they are; empty when shared.
    holderId: text("holder_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    sealed: blob("sealed", { mode: "buffer" }).notNull(),
    // Whether the server last took them, or refused them and they need connecting again.
    status: text("status", { enum: ["ok", "needs_auth"] })
      .default("ok")
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.holderKind, table.holderId] })],
);

// Whether a space uses one of the org's MCP servers, once it set so; one the org turned off is off
// in every space whatever the space set.
export const spaceMcpServerSetting = sqliteTable(
  "space_mcp_server_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.serverId] })],
);

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

import { POLICY_COLORS } from "@/shared/tools.ts";
import { user, organization } from "@/server/orgs/schema.ts";
import { thread } from "@/server/threads/schema.ts";
import { space } from "@/server/spaces/schema.ts";

// An access policy: the org's when spaceId is null, usable in every space, or one space's. Who
// can use its tools without approval and who approves are kept as JSON lists of keys.
export const toolPolicy = sqliteTable(
  "tool_policy",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color", {
      enum: POLICY_COLORS,
    }).notNull(),
    use: text("use", { enum: ["everyone", "some", "none"] }).notNull(),
    users: text("users", { mode: "json" }).$type<string[]>().notNull(),
    approvers: text("approvers", { mode: "json" }).$type<string[]>().notNull(),
    independent: integer("independent", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("tool_policy_organization_idx").on(table.organizationId)],
);

// The policy an org set a tool to, for all its spaces; a null policy turns the tool off.
export const orgToolSetting = sqliteTable(
  "org_tool_setting",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    policyId: text("policy_id").references(() => toolPolicy.id),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.toolId] })],
);

// The policy a space set a tool to: on the org's tools a rule added to the org's, on its own the
// one that applies. A null policy turns the tool off there.
export const spaceToolSetting = sqliteTable(
  "space_tool_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    policyId: text("policy_id").references(() => toolPolicy.id),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolId] })],
);

export const orgToolsetSetting = sqliteTable(
  "org_toolset_setting",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    toolsetId: text("toolset_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.toolsetId] })],
);

export const spaceToolsetSetting = sqliteTable(
  "space_toolset_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    toolsetId: text("toolset_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolsetId] })],
);

// An option of a built-in toolset an org turned on or off for its spaces; one not set is off.
export const orgToolsetOption = sqliteTable(
  "org_toolset_option",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    toolsetId: text("toolset_id").notNull(),
    option: text("option").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.toolsetId, table.option] })],
);

// An option a space turned off for itself, or back on while the org has it on.
export const spaceToolsetOption = sqliteTable(
  "space_toolset_option",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    toolsetId: text("toolset_id").notNull(),
    option: text("option").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolsetId, table.option] })],
);

// A wake-up of the agent in a thread. At most one run per thread is queued, running or waiting.
export const run = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "waiting", "completed", "failed", "cancelled"],
    }).notNull(),
    // The seq of the message that woke the agent.
    triggerSeq: integer("trigger_seq").notNull(),
    // The model ref it replied with, once it started.
    model: text("model"),
    // The run this one follows, and why.
    continuesRunId: text("continues_run_id"),
    reason: text("reason", { enum: ["interrupt", "queued_input", "retry"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // How many times this input has been tried, counting this run.
    attempt: integer("attempt").default(1).notNull(),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    cancelRequestedBy: text("cancel_requested_by"),
    // The worker holding the run, until when, and how many times it has been claimed.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    error: text("error"),
    // Why it failed, as a failure kind, and what the provider said.
    errorKind: text("error_kind", { enum: ["auth", "limit", "model", "network"] }),
    errorDetail: text("error_detail"),
    // The MCP tools the model turned on by searching for them, by id, offered from then on.
    toolsOn: text("tools_on", { mode: "json" }).$type<string[]>().default([]).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("run_thread_idx").on(table.threadId),
    index("run_status_idx").on(table.status),
    uniqueIndex("run_active_idx")
      .on(table.threadId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting')`),
  ],
);

// A subagent a thread's agent started: the thread it works in, the thread whose agent started it,
// the name it was given, its instructions, and once it is retired, when.
export const subagent = sqliteTable(
  "subagent",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => thread.id, { onDelete: "cascade" }),
    parentThreadId: text("parent_thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instructions: text("instructions"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("subagent_parent_idx").on(table.parentThreadId, table.createdAt)],
);

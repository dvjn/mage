// Tool policies and settings, by org and by space, and the MCP tools a thread's agent turned on.

import { pgTable, text, integer, index, primaryKey, boolean } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { POLICY_COLORS } from "@/shared/tools.ts";
import { organization } from "@/server/orgs/schema.ts";
import { thread } from "@/server/threads/schema.ts";
import { scopeColumns, scopeIndexes } from "@/server/spaces/scope.ts";
import { space } from "@/server/spaces/schema.ts";

// An access policy: the org's when spaceId is null, usable in every space, or one space's. Who
// can use its tools without approval and who approves are its members.
export const toolPolicy = pgTable(
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
    independent: boolean("independent").default(false).notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [index("tool_policy_organization_idx").on(table.organizationId)],
);

// Whom a policy names, in the order they were set: those who may use its tools without approval,
// and those who approve. Each is a key that names a person, a group, or a role such as editors.
export const toolPolicyMember = pgTable(
  "tool_policy_member",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => toolPolicy.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "approver"] }).notNull(),
    key: text("key").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.policyId, table.role, table.key] })],
);

// The policy a tool is set to: by an org for all its spaces, or by a space, where on the org's
// tools it is a rule added to the org's, and on its own the one that applies. A null policy turns
// the tool off there. A setting goes with its policy.
export const toolSetting = pgTable(
  "tool_setting",
  {
    ...scopeColumns(),
    toolId: text("tool_id").notNull(),
    policyId: text("policy_id").references(() => toolPolicy.id, { onDelete: "cascade" }),
  },
  (table) => scopeIndexes("tool_setting", table, table.toolId),
);

// Whether a toolset is on: for an org's spaces, or in a space.
export const toolsetSetting = pgTable(
  "toolset_setting",
  {
    ...scopeColumns(),
    toolsetId: text("toolset_id").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => scopeIndexes("toolset_setting", table, table.toolsetId),
);

// An option of a built-in toolset an org turned on or off for its spaces, one not set being off;
// or one a space turned off for itself, or back on while the org has it on.
export const toolsetOption = pgTable(
  "toolset_option",
  {
    ...scopeColumns(),
    toolsetId: text("toolset_id").notNull(),
    option: text("option").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => scopeIndexes("toolset_option", table, table.toolsetId, table.option),
);

// An MCP tool a thread's agent turned on by searching for it, offered in the thread from then on:
// the call that turned it on, and its place among the thread's tools turned on.
export const threadTool = pgTable(
  "thread_tool",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    callId: text("call_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.toolId] })],
);

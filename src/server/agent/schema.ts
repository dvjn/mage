import { sql } from "drizzle-orm";
import {
  sqliteTable,
  blob,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

import type { FailureKind, Steering } from "@/shared/threads/events.ts";
import type { TaskActor, TaskAssignee, TaskStatus } from "@/shared/tasks.ts";
import type { TriggerKind, TriggerStatus } from "@/shared/triggers.ts";
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

// A wake-up of the agent in a branch of a thread. At most one run per branch is queued, running or
// waiting.
export const run = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The branch it writes in; set for every run.
    branchId: text("branch_id"),
    status: text("status", {
      enum: ["queued", "running", "waiting", "completed", "failed", "cancelled"],
    }).notNull(),
    // The seq of the message that woke the agent.
    triggerSeq: integer("trigger_seq").notNull(),
    // The model ref it replied with, once it started.
    model: text("model"),
    // The model and effort it was asked to reply with in place of the thread's, if any.
    askedModel: text("asked_model"),
    askedEffort: text("asked_effort", { enum: ["low", "medium", "high"] }),
    // The run this one follows, and why.
    continuesRunId: text("continues_run_id"),
    reason: text("reason", { enum: ["interrupt", "queued_input", "retry", "rewrite"] }),
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
    errorKind: text("error_kind").$type<FailureKind>(),
    errorDetail: text("error_detail"),
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
      .on(table.branchId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting')`),
  ],
);

// An MCP tool a thread's agent turned on by searching for it, offered in the thread from then on:
// the call that turned it on, and its place among the thread's tools turned on.
export const threadTool = sqliteTable(
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
    // Whether it reads and updates its starter's task list in place of keeping its own.
    shareTasks: integer("share_tasks", { mode: "boolean" }).notNull().default(false),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("subagent_parent_idx").on(table.parentThreadId, table.createdAt)],
);

// A tool call that runs in the background: the thread it belongs to, the run that started it, the
// tool and its input, where it stands, and what it gave back or why it failed once it ended.
export const backgroundCall = sqliteTable(
  "background_call",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    toolId: text("tool_id").notNull(),
    input: text("input", { mode: "json" }).$type<unknown>(),
    // The model that replied when it was started, and whose words steered the call.
    model: text("model"),
    steeredBy: text("steered_by", { mode: "json" }).$type<Steering[]>().notNull(),
    status: text("status", {
      enum: ["pending", "running", "done", "failed", "cancelled", "interrupted"],
    }).notNull(),
    output: text("output", { mode: "json" }).$type<
      { ok: true; value: unknown } | { ok: false; error: string } | null
    >(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("background_call_thread_idx").on(table.threadId, table.createdAt)],
);

// A task in a thread's list: its title, where it stands, whom it is for, its place in the list, and
// who made and last changed it, by the names they went by, and when it was archived.
export const threadTask = sqliteTable(
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
    assignee: text("assignee", { mode: "json" }).$type<TaskAssignee | null>(),
    position: integer("position").notNull(),
    createdBy: text("created_by", { mode: "json" }).$type<TaskActor>().notNull(),
    updatedBy: text("updated_by", { mode: "json" }).$type<TaskActor>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // Set once the task is archived: it leaves the list and stays as history.
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("thread_task_thread_idx").on(table.threadId, table.position)],
);

// A thread's agent waiting on tasks of a list: the ones it named, and whether it wants to hear when
// one is done or on any change. It ends once it has told the agent.
export const threadTaskWatch = sqliteTable(
  "thread_task_watch",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    taskIds: text("task_ids", { mode: "json" }).$type<string[]>().notNull(),
    until: text("until", { enum: ["done", "changed"] })
      .$type<"done" | "changed">()
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("thread_task_watch_thread_idx").on(table.threadId),
    index("thread_task_watch_owner_idx").on(table.ownerId),
  ],
);

// What wakes a thread's agent later: a wake-up timer (once) or a schedule (cron), with when it next
// goes off and what it tells the agent. The claim columns are how several server instances share
// the work: one that takes a due row notes its time to fire in `pending_fire_at` and holds it until
// `claimed_until`; if it dies before it finishes, another takes the row once the lease runs out.
export const threadTrigger = sqliteTable(
  "thread_trigger",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["once", "cron", "webhook"] })
      .$type<TriggerKind>()
      .notNull(),
    name: text("name").notNull(),
    cron: text("cron"),
    timezone: text("timezone"),
    // The note or prompt the agent is told when it fires.
    prompt: text("prompt").notNull(),
    // Whose words steered the call that set it, and the name the agent set it by.
    steeredBy: text("steered_by", { mode: "json" }).$type<Steering[]>().notNull(),
    createdBy: text("created_by").notNull(),
    status: text("status", { enum: ["active", "paused", "done", "deleted"] })
      .$type<TriggerStatus>()
      .notNull(),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    pendingFireAt: integer("pending_fire_at", { mode: "timestamp_ms" }),
    claimedBy: text("claimed_by"),
    claimedUntil: integer("claimed_until", { mode: "timestamp_ms" }),
    lastFiredAt: integer("last_fired_at", { mode: "timestamp_ms" }),
    // A webhook's unguessable address token, and its signing secret sealed by the cipher, when a
    // person set one.
    hookToken: text("hook_token"),
    secretKeyVersion: integer("secret_key_version"),
    secret: blob("secret", { mode: "buffer" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("thread_trigger_hook_token_idx").on(table.hookToken),
    index("thread_trigger_thread_idx").on(table.threadId, table.createdAt),
    index("thread_trigger_due_idx").on(table.status, table.nextRunAt),
  ],
);

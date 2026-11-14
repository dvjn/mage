import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  boolean,
  json,
} from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";

import { leaseColumns } from "@/server/sync/lease.ts";
import { machine } from "@/server/sync/machine.ts";
import type { LiveProgress } from "@/shared/threads/events.ts";
import type { TaskActor, TaskAssignee, TaskStatus } from "@/shared/tasks.ts";
import { POLICY_COLORS } from "@/shared/tools.ts";
import { user, organization } from "@/server/orgs/schema.ts";
import { thread, threadBranch } from "@/server/threads/schema.ts";
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

const RUN_STATES = ["queued", "running", "waiting", "completed", "failed", "cancelled"] as const;

// Where a run stands, and what moves it: a worker claims a queued run, or takes over one whose
// holder's lease ran out; the holder lets it wait for a decision, ends it, or a decision queues it
// again.
export const runMachine = machine({
  states: RUN_STATES,
  transitions: {
    claim: { from: ["queued"], to: "running" },
    takeOver: { from: ["running"], to: "running" },
    wait: { from: ["running"], to: "waiting" },
    resume: { from: ["waiting"], to: "queued" },
    complete: { from: ["running"], to: "completed" },
    fail: { from: ["running"], to: "failed" },
    cancel: { from: ["running"], to: "cancelled" },
  },
});

// A wake-up of the agent in a branch of a thread. At most one run per branch is queued, running or
// waiting.
export const run = pgTable(
  "run",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The branch it writes in.
    branchId: text("branch_id")
      .notNull()
      .references(() => threadBranch.id, { onDelete: "cascade" }),
    status: text("status", { enum: RUN_STATES }).notNull(),
    // The seq of the message that woke the agent.
    triggerSeq: integer("trigger_seq").notNull(),
    // The model ref it replied with, once it started.
    model: text("model"),
    // The model and effort it was asked to reply with in place of the thread's, if any.
    askedModel: text("asked_model"),
    askedEffort: text("asked_effort", { enum: ["low", "medium", "high"] }),
    // The run this one follows, and why.
    continuesRunId: text("continues_run_id").references((): AnyPgColumn => run.id, {
      onDelete: "set null",
    }),
    reason: text("reason", { enum: ["interrupt", "queued_input", "retry", "rewrite"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // How many times this input has been tried, counting this run.
    attempt: integer("attempt").default(1).notNull(),
    cancelRequestedAt: at("cancel_requested_at"),
    cancelRequestedBy: text("cancel_requested_by"),
    // Asked to stop with the run that started its thread, whose agent is not told of it.
    cancelSilent: boolean("cancel_silent").default(false).notNull(),
    ...leaseColumns(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
    startedAt: at("started_at"),
    endedAt: at("ended_at"),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("run_thread_idx").on(table.threadId),
    index("run_status_idx").on(table.status),
    runMachine.check("run_status_check", table.status),
    uniqueIndex("run_active_idx")
      .on(table.branchId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting')`),
  ],
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

// A subagent a thread's agent started: the thread it works in, the thread whose agent started it,
// the name it was given, its instructions, and once it is retired, when.
export const subagent = pgTable(
  "subagent",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => thread.id, { onDelete: "cascade" }),
    parentThreadId: text("parent_thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The call in its starter's thread that started it.
    callId: text("call_id"),
    instructions: text("instructions"),
    archivedAt: at("archived_at"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [index("subagent_parent_idx").on(table.parentThreadId, table.createdAt)],
);

// What a running tool call has printed so far, kept while it runs for whoever watches it, on any
// instance: how many characters in all, and how far it says it has come. Dropped in the write that
// records the call's result.
export const callOutput = pgTable(
  "call_output",
  {
    callId: text("call_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    total: integer("total").default(0).notNull(),
    progress: json("progress").$type<LiveProgress>(),
  },
  (table) => [index("call_output_thread_idx").on(table.threadId)],
);

// The end of a running call's output, in the pieces it was stored in, each at the offset of its
// first character in everything the call printed.
export const callOutputChunk = pgTable(
  "call_output_chunk",
  {
    callId: text("call_id")
      .notNull()
      .references(() => callOutput.callId, { onDelete: "cascade", onUpdate: "cascade" }),
    offset: integer("offset").notNull(),
    text: text("text").notNull(),
  },
  (table) => [primaryKey({ columns: [table.callId, table.offset] })],
);

// A task in a thread's list: its title, where it stands, whom it is for, its place in the list, and
// who made and last changed it, by the names they went by, and when it was archived.
export const threadTask = pgTable(
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
    assignee: json("assignee").$type<TaskAssignee | null>(),
    position: integer("position").notNull(),
    createdBy: json("created_by").$type<TaskActor>().notNull(),
    updatedBy: json("updated_by").$type<TaskActor>().notNull(),
    updatedAt: at("updated_at").default(NOW).notNull(),
    // Set once the task is archived: it leaves the list and stays as history.
    archivedAt: at("archived_at"),
  },
  (table) => [index("thread_task_thread_idx").on(table.threadId, table.position)],
);

// A thread whose agent works on another thread's task list in place of keeping its own: a
// subagent on its starter's.
export const taskShare = pgTable("task_share", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => thread.id, { onDelete: "cascade" }),
  ownerThreadId: text("owner_thread_id")
    .notNull()
    .references(() => thread.id, { onDelete: "cascade" }),
});

// An agent waiting to be told once about subjects: tasks of a list, until one is done or on any
// change, or subagents, until all or any of them are idle. `owner_id` is whose they are: the
// thread that owns the list, or the one that started the subagents. It ends once it has told.
export const threadWatch = pgTable(
  "thread_watch",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["tasks", "subagents"] }).notNull(),
    until: text("until", { enum: ["done", "changed", "all_idle", "any_idle"] }).notNull(),
    // The call that set it, which its notice answers.
    callId: text("call_id"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    index("thread_watch_thread_idx").on(table.threadId),
    index("thread_watch_owner_idx").on(table.ownerId, table.kind),
  ],
);

// What a watch waits on: a task's id, or a subagent's thread id.
export const threadWatchSubject = pgTable(
  "thread_watch_subject",
  {
    watchId: text("watch_id")
      .notNull()
      .references(() => threadWatch.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.watchId, table.subjectId] })],
);

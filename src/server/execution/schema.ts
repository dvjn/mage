// Runs: each wake-up of the agent in a branch of a thread, and where it stands.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  text,
  integer,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { leaseColumns } from "@/server/sync/lease.ts";
import { machine } from "@/server/sync/machine.ts";
import { user } from "@/server/orgs/schema.ts";
import { thread, threadBranch } from "@/server/threads/schema.ts";

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
    wokenBySeq: integer("woken_by_seq").notNull(),
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

// What a thread's agent reads besides the thread: its instructions and tools as they were when
// taken, stored once under the hash of its JSON however many threads read it.
export const agentView = pgTable("agent_view", {
  hash: text("hash").primaryKey(),
  body: text("body").notNull(),
  createdAt: at("created_at").notNull().default(NOW),
});

// Where each tool call stands, from asked for to ended: one a run makes and waits on, and one that
// runs beside the runs as a job. What it was asked and gave back, and who decided it, stay in its
// events in the thread's log. What a running call prints is kept for whoever watches it.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  json,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { leaseColumns } from "@/server/sync/lease.ts";
import { machine } from "@/server/sync/machine.ts";
import { thread } from "@/server/threads/schema.ts";
import type { LiveProgress } from "@/shared/threads/events.ts";

export const CALL_STATES = [
  "ready",
  "waiting",
  "running",
  "completed",
  "failed",
  "denied",
  "skipped",
  "stale",
  "interrupted",
  "cancelled",
] as const;

export type CallStatus = (typeof CALL_STATES)[number];

export const callMachine = machine({
  states: CALL_STATES,
  transitions: {
    // Approved or answered.
    allow: { from: ["waiting"], to: "ready" },
    deny: { from: ["waiting"], to: "denied" },
    skip: { from: ["waiting"], to: "skipped" },
    start: { from: ["ready"], to: "running" },
    goStale: { from: ["ready", "waiting"], to: "stale" },
    complete: { from: ["running"], to: "completed" },
    fail: { from: ["running"], to: "failed" },
    interrupt: { from: ["running"], to: "interrupted" },
    cancel: { from: ["ready", "waiting", "running"], to: "cancelled" },
  },
});

// A call that has not ended.
export const OPEN_CALL_STATES = ["ready", "waiting", "running"] as const;

export const call = pgTable(
  "call",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The model's id for it, which a copied log and the test models repeat across threads.
    id: text("id").notNull(),
    branchId: text("branch_id").notNull(),
    // Where its request is in the thread's log.
    seq: integer("seq").notNull(),
    // The run that asked for it; not a reference, as a copied log names runs that are not there.
    runId: text("run_id").notNull(),
    toolId: text("tool_id").notNull(),
    risk: text("risk").notNull(),
    status: text("status", { enum: CALL_STATES }).notNull(),
    // What a waiting call waits for.
    waitsFor: text("waits_for", { enum: ["decision", "answer"] }),
    // A job, which runs beside the runs.
    background: boolean("background").notNull(),
    // The model it is judged under: the one the run that asked for it replied with.
    model: text("model"),
    // The instance running a job, while it runs.
    ...leaseColumns(),
    // A person asked to move the running call to the background; its holder acts on it.
    moveRequestedAt: at("move_requested_at"),
    // For a job an older log made of a call moved to the background, that call's id; a call moved
    // now keeps its own.
    movedFrom: text("moved_from"),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    // Where the decision or the answer is in the thread's log.
    decidedSeq: integer("decided_seq"),
    scope: text("scope", { enum: ["once", "for_now"] }),
    createdAt: at("created_at").default(NOW).notNull(),
    startedAt: at("started_at"),
    endedAt: at("ended_at"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.id] }),
    index("call_waiting_idx")
      .on(table.threadId)
      .where(sql`${table.status} = 'waiting'`),
    index("call_running_job_idx")
      .on(table.status, table.leaseExpiresAt)
      .where(sql`${table.background} and ${table.status} = 'running'`),
    index("call_open_idx")
      .on(table.threadId, table.runId)
      .where(sql`${table.status} in ('ready', 'waiting', 'running')`),
    callMachine.check("call_status_check", table.status),
    check("call_waits_for_check", sql`${table.waitsFor} is null or ${table.status} = 'waiting'`),
  ],
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

// Where each input to a thread's agent stands on a branch: a person's message or a notice, waiting
// to be taken in, taken in by a run, taken back, or dropped. A message has one row; a notice has
// one on each branch that reads it and must still account for it. What it says stays in its event
// in the thread's log, whose id it shares.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import type { Influencer } from "@/shared/threads/events.ts";
import { machine } from "@/server/sync/machine.ts";
import { thread, threadBranch } from "@/server/threads/schema.ts";

export const INPUT_STATES = ["waiting", "admitted", "withdrawn", "dropped"] as const;

export const inputMachine = machine({
  states: INPUT_STATES,
  transitions: {
    admit: { from: ["waiting"], to: "admitted" },
    withdraw: { from: ["waiting"], to: "withdrawn" },
    drop: { from: ["waiting"], to: "dropped" },
  },
});

export const ORIGIN_KINDS = [
  "person",
  "schedule",
  "webhook",
  "job",
  "subagent",
  "task",
  "system",
] as const;

export const threadInput = pgTable(
  "thread_input",
  {
    // The id of the event that brought it.
    id: text("id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The branch it waits in, or was taken in on.
    branchId: text("branch_id")
      .notNull()
      .references(() => threadBranch.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: ["message", "notice"] }).notNull(),
    status: text("status", { enum: INPUT_STATES }).notNull(),
    // False for a notice left for the agent to read without starting it.
    wake: boolean("wake").notNull(),
    // How a person's message reaches a run under way.
    delivery: text("delivery", { enum: ["steer", "queue", "interrupt"] }),
    authorId: text("author_id"),
    originKind: text("origin_kind", { enum: ORIGIN_KINDS }).notNull(),
    originId: text("origin_id").notNull(),
    // Makes a second delivery of the same thing to the thread a no-op.
    key: text("key"),
    // The run that took it in; not a reference, as a copied log names runs that are not there.
    admittedRunId: text("admitted_run_id"),
    // For a notice told again on a new branch, the one it repeats.
    copyOf: text("copy_of"),
    // The call that made what sent the notice, which a new branch must hold to be told it.
    sourceCallId: text("source_call_id"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.branchId] }),
    uniqueIndex("thread_input_key_idx")
      .on(table.threadId, table.branchId, table.key)
      .where(sql`${table.key} is not null`),
    index("thread_input_thread_key_idx")
      .on(table.threadId, table.key)
      .where(sql`${table.key} is not null`),
    index("thread_input_waiting_idx")
      .on(table.threadId, table.branchId, table.seq)
      .where(sql`${table.status} = 'waiting'`),
    index("thread_input_origin_idx").on(table.originKind, table.originId, table.seq),
    inputMachine.check("thread_input_status_check", table.status),
    check("thread_input_kind_check", sql`${table.kind} in ('message', 'notice')`),
    check(
      "thread_input_origin_check",
      sql`${table.originKind} in ('person', 'schedule', 'webhook', 'job', 'subagent', 'task', 'system')`,
    ),
    check(
      "thread_input_message_check",
      sql`(${table.kind} = 'message') = (${table.delivery} is not null and ${table.authorId} is not null)`,
    ),
    check(
      "thread_input_admitted_check",
      sql`(${table.status} = 'admitted') = (${table.admittedRunId} is not null)`,
    ),
  ],
);

// Whose words a thread's agent read, one row per person per thing it read of theirs, where the
// thread's log put it before the model: a message or a notice where a run took it in, an aside
// where it was sent, an answer where it was given. A notice's people come with the agents their
// words passed through; a person's own words with none, and their name as it is now.
export const threadWord = pgTable(
  "thread_word",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    branchId: text("branch_id").notNull(),
    seq: integer("seq").notNull(),
    // The order of the words within that event, as the model read them.
    ord: integer("ord").notNull(),
    userId: text("user_id").notNull(),
    name: text("name"),
    via: jsonb("via").$type<Influencer["via"]>().notNull(),
    // For an answer, where the call it answers was asked for.
    callSeq: integer("call_seq"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.seq, table.ord] }),
    index("thread_word_branch_idx").on(table.threadId, table.branchId, table.seq),
  ],
);

// Wake-up timers and schedules a thread's agent set: when each next comes due, where it stands, and
// whose words it carries to the agent when it fires.

import { sql } from "drizzle-orm";
import { check, index, json, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";
import { machine } from "@/server/sync/machine.ts";
import { thread } from "@/server/threads/schema.ts";
import type { Influencer } from "@/shared/threads/events.ts";

export const SCHEDULE_STATES = ["active", "paused", "completed", "deleted"] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATES)[number];

export const scheduleMachine = machine({
  states: SCHEDULE_STATES,
  transitions: {
    pause: { from: ["active"], to: "paused" },
    resume: { from: ["paused"], to: "active" },
    // Moved on to its next time, guarded on the time it had as read.
    fire: { from: ["active"], to: "active" },
    // A timer that went off, or a schedule with no next time.
    finish: { from: ["active"], to: "completed" },
    remove: { from: ["active", "paused"], to: "deleted" },
  },
});

export const schedule = pgTable(
  "schedule",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The call that set it.
    callId: text("call_id"),
    kind: text("kind", { enum: ["once", "cron"] }).notNull(),
    name: text("name").notNull(),
    cron: text("cron"),
    timezone: text("timezone"),
    // The note or prompt the agent is told when it fires.
    prompt: text("prompt").notNull(),
    // Whose words the model had read when it set it.
    influence: json("influence").$type<Influencer[]>().notNull(),
    status: text("status", { enum: SCHEDULE_STATES }).notNull(),
    // When it next comes due: kept while paused, so a paused timer remembers its time.
    nextRunAt: at("next_run_at"),
    lastFiredAt: at("last_fired_at"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    uniqueIndex("schedule_call_idx")
      .on(table.threadId, table.callId)
      .where(sql`${table.callId} is not null`),
    index("schedule_due_idx")
      .on(table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
    index("schedule_thread_idx").on(table.threadId, table.createdAt),
    scheduleMachine.check("schedule_status_check", table.status),
    check(
      "schedule_kind_check",
      sql`(${table.kind} = 'cron') = (${table.cron} is not null and ${table.timezone} is not null)`,
    ),
    check(
      "schedule_next_check",
      sql`(${table.status} <> 'active' or ${table.nextRunAt} is not null)
          and (${table.status} not in ('completed', 'deleted') or ${table.nextRunAt} is null)`,
    ),
  ],
);

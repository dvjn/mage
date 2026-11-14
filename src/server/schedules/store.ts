// Rows of timers and schedules. Each change of where one stands is one guarded statement through
// the schedule machine, answering the row it moved or nothing when it had moved already.

import { and, asc, eq, inArray, isNull, lte, notInArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";

import { schedule, scheduleMachine } from "./schema.ts";

export type ScheduleRow = typeof schedule.$inferSelect;
export type NewSchedule = Omit<ScheduleRow, "status" | "lastFiredAt" | "createdAt">;

// A column holds the value, null included.
function holds<T>(column: PgColumn, value: T | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

export function createScheduleStore(db: Db) {
  async function move(
    id: string,
    event: Parameters<typeof scheduleMachine.to>[0],
    set: Partial<ScheduleRow> = {},
    where?: SQL,
  ) {
    return (
      (
        await db
          .update(schedule)
          .set({ ...scheduleMachine.to(event), ...set })
          .where(and(eq(schedule.id, id), scheduleMachine.from(event, schedule.status), where))
          .returning()
      )[0] ?? null
    );
  }

  return {
    async create(row: NewSchedule) {
      return (
        await db
          .insert(schedule)
          .values({ ...row, status: "active" })
          .returning()
      )[0]!;
    },

    async find(id: string) {
      return (await db.select().from(schedule).where(eq(schedule.id, id)).limit(1))[0] ?? null;
    },

    // The thread's that are active or paused, oldest first.
    async inThread(threadId: string) {
      return await db
        .select()
        .from(schedule)
        .where(and(eq(schedule.threadId, threadId), inArray(schedule.status, ["active", "paused"])))
        .orderBy(asc(schedule.createdAt), asc(schedule.id));
    },

    // The thread's that the calls set, whatever they stand at.
    async ofCalls(threadId: string, callIds: readonly string[]) {
      if (callIds.length === 0) return [];
      return await db
        .select()
        .from(schedule)
        .where(and(eq(schedule.threadId, threadId), inArray(schedule.callId, [...callIds])));
    },

    pause: async (id: string) => move(id, "pause"),

    // Its time is worked out again for a recurring one; a timer keeps the time it had.
    resume: async (id: string, next: Date | null) =>
      move(id, "resume", next ? { nextRunAt: next } : {}),

    remove: async (id: string) => move(id, "remove", { nextRunAt: null }),

    // Moves the row as it was read on to its next time, noting it fired.
    fire: async (seen: ScheduleRow, next: Date, at: Date) =>
      move(
        seen.id,
        "fire",
        { nextRunAt: next, lastFiredAt: at },
        holds(schedule.nextRunAt, seen.nextRunAt),
      ),

    // Ends the row as it was read, having fired for the last time.
    finish: async (seen: ScheduleRow, at: Date) =>
      move(
        seen.id,
        "finish",
        { nextRunAt: null, lastFiredAt: at },
        holds(schedule.nextRunAt, seen.nextRunAt),
      ),

    async userName(userId: string) {
      return (
        (await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0]
          ?.name ?? null
      );
    },
  };
}

// The rows due by now, leaving out those named.
export const dueWhere = (now: Date, skip: readonly string[]) =>
  and(
    eq(schedule.status, "active"),
    lte(schedule.nextRunAt, now),
    skip.length > 0 ? notInArray(schedule.id, [...skip]) : undefined,
  )!;

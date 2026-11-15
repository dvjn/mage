// Wake-up timers and schedules: what wakes a thread's agent at a time. A timer goes off once; a
// schedule repeats on a cron expression in a time zone. Each firing tells the thread's agent, as
// the people whose words it had read when it set it. The database is the only record of them,
// shared by every server instance: each tick takes each due row and fires it in one transaction,
// the move a guarded statement on the row as it was read, so of several instances one fires it, and
// a server stopping midway fires nothing and leaves the row due. Firings missed while the server
// was down happen once, and the next time is worked out from then. A person pauses, resumes or
// deletes one in one guarded statement, and the agent is told of it, quietly, in the same write.

import { Cron } from "croner";
import { ulid } from "ulid";
import * as z from "zod";

import type { Reader } from "@/server/access/access.ts";
import type { CallPresentation, Toolset, ToolSpec } from "@/server/tools/registry.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { type Notice, silentChange } from "@/server/queue/notices.ts";
import type { Queue } from "@/server/queue/queue.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { Sync } from "@/server/sync/sync.ts";
import type { Work } from "@/shared/jobs.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import type { Change } from "@/shared/threads/events.ts";
import {
  ADD_SCHEDULE,
  describeCron,
  SCHEDULES_TOOLSET,
  WAKE_AT,
  WAKE_HORIZON,
} from "@/shared/schedules.ts";
import { HISTORY_PAGE, type FiredHistory } from "@/shared/schedules-and-webhooks.ts";

import { schedule } from "./schema.ts";
import { dueWhere, type ScheduleRow, type ScheduleStore } from "./store.ts";

export type Schedule = ScheduleRow;

// How many due rows one tick takes at most, and how often it looks.
const TICK_BATCH = 50;
const TICK_MS = 5_000;

// A call the tool refuses, with what the model is told.
class ToolRefusal extends Error {}

// Refuses the call with the reason, when there is one.
async function refuseIf(reason: Promise<string | null>) {
  const why = await reason;
  if (why) throw new ToolRefusal(why);
}

// What the tool gives back, or the refusal it throws.
async function refusing(work: () => unknown) {
  try {
    return { ok: true as const, value: await work() };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false as const, error: err.message };
    throw err;
  }
}

// What the agent is told about them.
export const SCHEDULES_GUIDANCE =
  "Set a wake-up timer with schedules.wake_at to carry on later, or a recurring schedule with schedules.add (a five-field cron expression and a time zone). When one fires you get a notification with its note or prompt. Remove one with schedules.delete; see them with schedules.list.";

// What setting one must pass first: room in the thread, and for a named one, a name of its own;
// each answers why not, or null.
export interface SetChecks {
  room(threadId: string): Promise<string | null>;
  unique(threadId: string, name: string): Promise<string | null>;
}

// The next time a cron expression goes off after `from`.
function nextRun(cron: string, timezone: string, from: Date): Date | null {
  return new Cron(cron, { timezone }).nextRun(from);
}

function checkCron(cron: string, timezone: string, from: Date) {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new ToolRefusal("The cron expression needs five fields: minute hour day month weekday.");
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ToolRefusal(`${timezone} is not a time zone. Use one like Europe/Paris or UTC.`);
  }
  let next: Date | null;
  try {
    next = nextRun(cron, timezone, from);
  } catch (err) {
    throw new ToolRefusal(`The cron expression is not valid: ${(err as Error).message}`);
  }
  if (!next) throw new ToolRefusal("The cron expression never goes off.");
  return next;
}

// What a person did to one, as the agent is told it.
const DID = {
  pause: ["paused", "pause"],
  resume: ["resumed", "resume"],
  remove: ["deleted", "delete"],
} as const satisfies Record<string, readonly [string, Change["action"]]>;

export interface SchedulesOptions {
  store: ScheduleStore;
  queue: Pick<Queue, "enqueue" | "history" | "counts">;
  signals: Pick<Signals, "changed">;
  sync: Pick<Sync, "transact" | "claimDue" | "ticker">;
  logger: Logger;
  tickMs?: number;
  now?: () => Date;
}

export type Schedules = ReturnType<typeof createSchedules>;

export function createSchedules(options: SchedulesOptions) {
  const { store, queue, signals, logger } = options;
  const { transact } = options.sync;
  const now = options.now ?? (() => new Date());

  function changed(threadId: string) {
    signals.changed({ threadId, rows: true });
  }

  // The name a card and the agent's changes go by: a timer's note, a schedule's name.
  const nameOf = (row: ScheduleRow) => (row.kind === "once" ? row.prompt : row.name);

  // Tells the thread's agent the row went off for the time it was due, once.
  async function fire(row: ScheduleRow, due: Date | null) {
    const once = row.kind === "once";
    const notice: Notice = {
      kind: "schedule.fired",
      scheduleId: row.id,
      source: { threadId: row.threadId, name: row.name, main: true },
      actor: {
        kind: "source",
        label: once ? "Wake-up timer" : row.name,
        type: once ? "wakeup" : "schedule",
      },
      text: once ? "Wake-up timer went off" : `Schedule "${row.name}" fired`,
      influence: row.influence,
      last: row.prompt,
      ...(!once && row.cron && { schedule: describeCron(row.cron) }),
    };
    await queue.enqueue(
      row.threadId,
      { kind: "notice", notice },
      {
        origin: { kind: "schedule", id: row.id },
        key: `schedule:${row.id}:${due?.toISOString() ?? "now"}`,
        ...(row.callId && { source: { callId: row.callId } }),
      },
    );
  }

  // Takes the due rows one at a time, each in a transaction of its own that locks it, so instances
  // ticking together share them out; answers how many fired here. One that fails is left for the
  // next tick.
  async function tick() {
    const start = now();
    let fired = 0;
    const failed: string[] = [];
    for (let taken = 0; taken < TICK_BATCH; taken += 1) {
      let seen: ScheduleRow | undefined;
      try {
        const done = await transact(async () => {
          [seen] = await options.sync.claimDue(schedule, {
            where: dueWhere(start, failed),
            orderBy: schedule.nextRunAt,
            limit: 1,
          });
          if (!seen) return null;
          // The next time is worked out from now, so firings missed while down happen once.
          let next: Date | null = null;
          try {
            if (seen.kind === "cron") next = nextRun(seen.cron!, seen.timezone!, start);
          } catch (err) {
            logger.warn({ err, scheduleId: seen.id }, "schedule has no next time");
          }
          const moved = next
            ? await store.fire(seen, next, start)
            : await store.finish(seen, start);
          if (!moved) return false;
          await fire(moved, seen.nextRunAt);
          return true;
        });
        if (done === null) break;
        if (!done) continue;
        fired += 1;
        changed(seen!.threadId);
      } catch (err) {
        // Rolled back: the row is still due, and the next tick tries again.
        logger.warn({ err, scheduleId: seen?.id }, "schedule did not fire");
        if (!seen) break;
        failed.push(seen.id);
      }
    }
    return fired;
  }

  const ticker = options.sync.ticker("schedules", tick, options.tickMs ?? TICK_MS);

  // Tells the thread's agent, without waking it, that a person did something to one, inside the
  // write that did it.
  async function told(reader: Reader, row: ScheduleRow, did: keyof typeof DID) {
    const userId = reader.principal.userId;
    const who = (await store.userName(userId)) ?? "Someone";
    const kind = row.kind === "once" ? "wake-up" : "schedule";
    const name = nameOf(row);
    const [verb, action] = DID[did];
    await queue.enqueue(
      row.threadId,
      {
        kind: "notice",
        notice: silentChange(
          row.threadId,
          who,
          `${who} ${verb} ${kind} ${name}`,
          "schedules",
          { kind: "person", userId, name: who },
          { subject: { kind: "schedule", name }, action },
        ),
      },
      { origin: { kind: "person", id: userId } },
    );
  }

  // The thread's one, as a person may change it: not found when it is another thread's or
  // deleted, refused once it has gone off.
  async function changeable(reader: Reader, id: string) {
    const row = await store.find(id);
    if (!row || row.threadId !== reader.thread.id || row.status === "deleted") return null;
    return row;
  }

  // A person's change in one guarded statement and its notice, in one write. Unchanged, it reads
  // the row again: already where it was asked to go changes nothing, gone is not found, gone off
  // is refused.
  async function change(
    reader: Reader,
    id: string,
    did: keyof typeof DID,
    apply: (row: ScheduleRow) => Promise<ScheduleRow | null>,
  ) {
    const found = await changeable(reader, id);
    if (!found) throw new ServiceError(404, "Schedule not found");
    await transact(async () => {
      const moved = await apply(found);
      if (moved) {
        await told(reader, moved, did);
        return;
      }
      const current = await store.find(id);
      if (!current || current.status === "deleted")
        throw new ServiceError(404, "Schedule not found");
      if (current.status === "completed") throw new ServiceError(409, "This timer has gone off");
    });
    changed(reader.thread.id);
  }

  // One as the agent reads it in a list.
  function brief(row: ScheduleRow) {
    return {
      id: row.id,
      kind: row.kind === "once" ? "wake_at" : "schedule",
      name: row.name,
      status: row.status,
      ...(row.cron && { cron: row.cron, timezone: row.timezone }),
      ...(row.nextRunAt && { next: row.nextRunAt.toISOString() }),
      ...(row.lastFiredAt && { lastFired: row.lastFiredAt.toISOString() }),
      prompt: row.prompt,
    };
  }

  // Deletes the thread's one, as its agent asked; false when it is not there. One that went off
  // stays as it is.
  async function removeFor(threadId: string, id: string) {
    const row = await store.find(id);
    if (!row || row.threadId !== threadId || row.status === "deleted") return false;
    if (row.status !== "completed") await store.remove(id);
    changed(threadId);
    return true;
  }

  return {
    // Whether the thread has this one, live.
    find: async (threadId: string, id: string) => {
      const row = await store.find(id);
      return row && row.threadId === threadId && row.status !== "deleted" ? row : null;
    },

    inThread: async (threadId: string) => store.inThread(threadId),

    // The agent's tools: a timer and a schedule, set after the checks given, and their list and
    // delete; with the cards of what the calls set.
    toolset(checks: SetChecks): Toolset {
      const wakeAt: ToolSpec<{ in_seconds?: number; at?: string; note: string }> = {
        name: WAKE_AT,
        modelName: WAKE_AT,
        title: "Wake at",
        annotations: { readOnlyHint: false },
        description:
          "Wake yourself once, after in_seconds or at an ISO time with its offset (give one of them), with the note. Returns at once.",
        input: z.object({
          in_seconds: z
            .number()
            .int()
            .min(1)
            .max(WAKE_HORIZON)
            .optional()
            .meta({ title: "In seconds" }),
          at: z.string().min(1).optional().meta({ title: "At" }),
          note: z.string().trim().min(1).max(2000).meta({ title: "Note" }),
        }),
        risk: () => "normal",
        run(input, ctx) {
          return refusing(async () => {
            if ((input.in_seconds === undefined) === (input.at === undefined)) {
              throw new ToolRefusal("Give in_seconds or at, not both and not neither.");
            }
            const start = now();
            const when =
              input.in_seconds !== undefined
                ? new Date(start.getTime() + input.in_seconds * 1000)
                : new Date(input.at!);
            if (Number.isNaN(when.getTime())) {
              throw new ToolRefusal(`${input.at} is not a time. Use ISO 8601 with an offset.`);
            }
            if (when.getTime() <= start.getTime()) throw new ToolRefusal("That time has passed.");
            if (when.getTime() - start.getTime() > WAKE_HORIZON * 1000) {
              throw new ToolRefusal("That is more than a year ahead.");
            }
            await refuseIf(checks.room(ctx.threadId));
            const row = await store.create({
              id: ulid(),
              threadId: ctx.threadId,
              callId: ctx.callId,
              kind: "once",
              name: "Wake-up",
              cron: null,
              timezone: null,
              prompt: input.note,
              influence: ctx.influence,
              nextRunAt: when,
            });
            changed(ctx.threadId);
            return { id: row.id, at: when.toISOString() };
          });
        },
      };

      const recurring: ToolSpec<{ name: string; cron: string; timezone?: string; prompt: string }> =
        {
          name: ADD_SCHEDULE,
          modelName: ADD_SCHEDULE,
          title: "Schedule",
          annotations: { readOnlyHint: false },
          description:
            "Wake yourself on a recurring schedule: a five-field cron expression in a time zone (IANA name, default UTC). Each time, you are told the prompt.",
          input: z.object({
            name: z.string().trim().min(1).max(80).meta({ title: "Name" }),
            cron: z.string().trim().min(1).max(100).meta({ title: "Cron" }),
            timezone: z.string().min(1).max(64).optional().meta({ title: "Time zone" }),
            prompt: z.string().trim().min(1).max(4000).meta({ title: "Prompt" }),
          }),
          risk: () => "normal",
          run(input, ctx) {
            return refusing(async () => {
              const timezone = input.timezone ?? "UTC";
              const next = checkCron(input.cron, timezone, now());
              await refuseIf(checks.room(ctx.threadId));
              await refuseIf(checks.unique(ctx.threadId, input.name));
              const row = await store.create({
                id: ulid(),
                threadId: ctx.threadId,
                callId: ctx.callId,
                kind: "cron",
                name: input.name,
                cron: input.cron,
                timezone,
                prompt: input.prompt,
                influence: ctx.influence,
                nextRunAt: next,
              });
              changed(ctx.threadId);
              return { id: row.id, next: next.toISOString() };
            });
          },
        };
      const list: ToolSpec<Record<string, never>> = {
        name: "schedules.list",
        title: "List",
        annotations: { readOnlyHint: true },
        description: "This thread's wake-up timers and schedules, with when each goes off next.",
        input: z.object({}).strict() as z.ZodType<Record<string, never>>,
        risk: () => "normal",
        run(_input, ctx) {
          return refusing(async () => ({
            schedules: (await store.inThread(ctx.threadId)).map(brief),
          }));
        },
      };
      const remove: ToolSpec<{ id: string }> = {
        name: "schedules.delete",
        title: "Delete",
        annotations: { readOnlyHint: false },
        description: "Delete a wake-up timer or schedule by its id.",
        input: z.object({ id: z.string().min(1).meta({ title: "Id" }) }),
        risk: () => "normal",
        run({ id }, ctx) {
          return refusing(async () => {
            if (!(await removeFor(ctx.threadId, id))) {
              throw new ToolRefusal(`No schedule has the id ${id}.`);
            }
            return { deleted: id };
          });
        },
      };
      return {
        id: SCHEDULES_TOOLSET,
        title: "Schedules",
        source: "builtin",
        description: "What wakes the agent at a time: wake-up timers and schedules",
        guidance: SCHEDULES_GUIDANCE,
        tools: [wakeAt, recurring, list, remove],
        present: async (reader, rows) => present(reader, rows),
      };
    },

    brief,
    removeFor,

    tick,

    // Starts looking for due rows, now and then every few seconds.
    async start() {
      await ticker.start();
    },

    async stop() {
      await ticker.stop();
    },

    pause: async (reader: Reader, id: string) =>
      change(reader, id, "pause", async (row) => store.pause(row.id)),

    // Resuming works out a schedule's next time from now; what passed while paused does not fire.
    resume: async (reader: Reader, id: string) =>
      change(reader, id, "resume", async (row) =>
        store.resume(row.id, row.kind === "cron" ? nextRun(row.cron!, row.timezone!, now()) : null),
      ),

    remove: async (reader: Reader, id: string) =>
      change(reader, id, "remove", async (row) => store.remove(row.id)),

    // A page of what it fired, newest first, for anyone who may read the thread.
    async history(reader: Reader, id: string, offset: number): Promise<FiredHistory> {
      const row = await changeable(reader, id);
      if (!row) throw new ServiceError(404, "Schedule not found");
      const { total, entries } = await queue.history(
        row.threadId,
        { kind: "schedule", id: row.id },
        { offset, limit: HISTORY_PAGE },
      );
      return {
        entries: entries.map((entry) => ({ id: entry.id, at: entry.at.toISOString() })),
        total,
        offset,
      };
    },

    present,
  };

  // The cards of the timers and schedules the page's calls set, as the reader sees them.
  async function present(reader: Reader, rows: readonly ToolRow[]) {
    const callIds = rows.map((row) => row.id);
    const found = await store.ofCalls(reader.thread.id, callIds);
    const fired =
      found.length > 0
        ? await queue.counts(reader.thread.id, ["schedule"])
        : new Map<string, number>();
    const byCall = new Map(found.map((row) => [row.callId, row]));
    const canChange = reader.can("post");
    return (row: ToolRow): CallPresentation | undefined => {
      const made = byCall.get(row.id);
      return made
        ? { work: cardOf(made, fired.get(made.id) ?? 0, canChange), live: true }
        : undefined;
    };
  }
}

// The card of a timer or schedule, as the reader sees it.
function cardOf(row: ScheduleRow, fired: number, canChange: boolean): Work {
  const status =
    row.status === "active"
      ? ("scheduled" as const)
      : row.status === "paused"
        ? ("paused" as const)
        : row.status === "completed"
          ? ("completed" as const)
          : ("cancelled" as const);
  return {
    kind: "schedule",
    status,
    startedAt: row.createdAt.toISOString(),
    ...(row.lastFiredAt &&
      row.status === "completed" && { endedAt: row.lastFiredAt.toISOString() }),
    canCancel: false,
    schedule: {
      id: row.id,
      kind: row.kind,
      name: row.kind === "once" ? row.prompt : row.name,
      ...(row.cron && {
        cron: row.cron,
        words: describeCron(row.cron),
        timezone: row.timezone ?? "UTC",
      }),
      ...(row.nextRunAt && row.status === "active" && { nextRunAt: row.nextRunAt.toISOString() }),
      ...(row.lastFiredAt && { lastFiredAt: row.lastFiredAt.toISOString() }),
      fired,
      canChange: canChange && (row.status === "active" || row.status === "paused"),
    },
  };
}

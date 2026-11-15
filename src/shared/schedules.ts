// Wake-up timers and schedules: what wakes a thread's agent at a time. A wake-up timer goes off
// once; a schedule repeats on a cron expression. Both are kept per thread and tell the agent when
// they fire.

import * as z from "zod";

// The toolset and the tools the agent sets them with.
export const SCHEDULES_TOOLSET = "schedules";
export const WAKE_AT = "schedules.wake_at";
export const ADD_SCHEDULE = "schedules.add";

// The furthest ahead a wake-up timer may be set, in seconds.
export const WAKE_HORIZON = 366 * 24 * 60 * 60;

export const scheduleKindSchema = z.enum(["once", "cron"]);

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

// Where one stands: waiting for its time, paused, gone off for good (a timer that fired), or
// deleted.
export const scheduleStatusSchema = z.enum(["active", "paused", "completed", "deleted"]);

export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

// A schedule as its card shows it.
export const scheduleWorkSchema = z.object({
  id: z.string(),
  kind: scheduleKindSchema,
  name: z.string(),
  // For a recurring one, the cron expression, in words, and the zone it runs in.
  cron: z.string().optional(),
  words: z.string().optional(),
  timezone: z.string().optional(),
  nextRunAt: z.string().optional(),
  lastFiredAt: z.string().optional(),
  // How many times it has fired, which its history lists.
  fired: z.number().int().nonnegative(),
  // Whether the reader may pause, resume and delete it.
  canChange: z.boolean(),
});

export type ScheduleWork = z.infer<typeof scheduleWorkSchema>;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// A cron expression, in words, for the common shapes; any other is shown as written.
export function describeCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, day, month, week] = parts as [string, string, string, string, string];
  const number = (field: string) => (/^\d+$/.test(field) ? Number(field) : null);
  const every = /^\*\/(\d+)$/.exec(minute);
  const rest = day === "*" && month === "*";
  if (minute === "*" && hour === "*" && rest && week === "*") return "Every minute";
  if (every && hour === "*" && rest && week === "*") return `Every ${every[1]} minutes`;
  const at = number(minute);
  if (at === null) return cron;
  if (hour === "*" && rest && week === "*") return `Every hour at :${String(at).padStart(2, "0")}`;
  const hours = number(hour);
  if (hours === null) return cron;
  const time = clock(hours, at);
  if (rest && week === "*") return `Every day at ${time}`;
  if (rest && week === "1-5") return `Weekdays at ${time}`;
  const weekday = number(week);
  if (rest && weekday !== null && weekday <= 7) return `Every ${DAYS[weekday % 7]} at ${time}`;
  const date = number(day);
  if (month === "*" && week === "*" && date !== null)
    return `Day ${date} of every month at ${time}`;
  return cron;
}

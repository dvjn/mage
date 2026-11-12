// Triggers: what wakes a thread's agent later. A wake-up timer goes off once at a time; a schedule
// repeats on a cron expression; a webhook goes off whenever something posts to its address. All are
// kept per thread and tell the agent when they fire.

import * as z from "zod";

// The tools the agent sets and removes them with.
export const TRIGGERS_TOOLSET = "triggers";
export const WAKE_AT = "triggers.wake_at";
export const SCHEDULE = "triggers.schedule";
export const ADD_WEBHOOK = "triggers.add_webhook";

// Where a webhook receives posts, under the API but outside what needs a login; the token after it
// is the whole of the address's secrecy.
export const HOOK_PATH = "/api/hooks/";

// The most a webhook takes in one post, in bytes, and the most of it the agent is shown, in characters.
export const HOOK_BODY_LIMIT = 256 * 1024;
export const HOOK_PAYLOAD_SHOWN = 20_000;

// The header a post's signature comes in when the webhook has a signing secret: "sha256=" and the
// hex HMAC-SHA256 of the body, as GitHub sends it.
export const HOOK_SIGNATURE_HEADER = "X-Hub-Signature-256";

// How many a thread has active or paused at once.
export const TRIGGER_LIMIT = 20;

// The furthest ahead a wake-up timer may be set, in seconds.
export const WAKE_HORIZON = 366 * 24 * 60 * 60;

export const triggerKindSchema = z.enum(["once", "cron", "webhook"]);

export type TriggerKind = z.infer<typeof triggerKindSchema>;

// Where a trigger stands: waiting for its time, paused, fired for good (a timer that went off), or
// deleted.
export const triggerStatusSchema = z.enum(["active", "paused", "done", "deleted"]);

export type TriggerStatus = z.infer<typeof triggerStatusSchema>;

// A schedule as its card shows it.
export const scheduleWorkSchema = z.object({
  id: z.string(),
  kind: triggerKindSchema,
  name: z.string(),
  // For a recurring one, the cron expression, in words, and the zone it runs in.
  cron: z.string().optional(),
  words: z.string().optional(),
  timezone: z.string().optional(),
  nextRunAt: z.string().optional(),
  lastFiredAt: z.string().optional(),
  // Whether the reader may pause, resume and delete it.
  canChange: z.boolean(),
});

export type ScheduleWork = z.infer<typeof scheduleWorkSchema>;

// A webhook as its card shows it. The signing secret itself is never sent, only whether there is one.
export const webhookWorkSchema = z.object({
  id: z.string(),
  name: z.string(),
  // The address's path, for those who may change it; the card adds the origin it is opened from.
  path: z.string().optional(),
  signed: z.boolean(),
  lastFiredAt: z.string().optional(),
  canChange: z.boolean(),
});

export type WebhookWork = z.infer<typeof webhookWorkSchema>;

// What a person sends to set or clear a webhook's signing secret.
export const hookSecretInputSchema = z.object({ secret: z.string().max(200).nullable() });

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

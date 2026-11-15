// Whether a call set up a schedule, a wake-up or a webhook, which are ordinary tool rows.

import type { ToolRow } from "@/shared/threads/rows.ts";

export function isScheduleOrWebhook(row: Pick<ToolRow, "work">) {
  return row.work?.kind === "schedule" || row.work?.kind === "webhook";
}

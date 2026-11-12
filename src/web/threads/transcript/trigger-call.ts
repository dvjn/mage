// Whether a call set up a schedule, a wake-up or a webhook, which are ordinary tool rows.

import type { ToolRow } from "@/shared/threads/rows.ts";

export function isTrigger(row: Pick<ToolRow, "background">) {
  return row.background?.kind === "schedule" || row.background?.kind === "webhook";
}

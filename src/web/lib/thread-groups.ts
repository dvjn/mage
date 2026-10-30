// Threads grouped as their lists show them: those that need the reader, those the agent is working
// on, those with something new, then the rest by when they were last active.

import { needsYou, type ThreadStatus } from "@/shared/thread-status.ts";
import { type Section, SECTIONS, sectionOf } from "@/web/lib/time-sections";

export type ThreadGroup = "Needs you" | "Working" | "Unread" | Section;

export const GROUPS: ThreadGroup[] = ["Needs you", "Working", "Unread", ...SECTIONS];

export function groupOf(status: ThreadStatus, iso: string, now: Date): ThreadGroup {
  if (needsYou(status)) return "Needs you";
  if (status === "working" || status === "paused") return "Working";
  if (status === "unread") return "Unread";
  return sectionOf(iso, now);
}

// The items in each group, in the order given, leaving out empty groups.
export function grouped<T>(items: T[], group: (item: T) => ThreadGroup) {
  return GROUPS.map((name) => [name, items.filter((item) => group(item) === name)] as const).filter(
    ([, list]) => list.length > 0,
  );
}

// Threads by when they were last active: today, the previous 7 days, or before.

export type Section = "Today" | "Previous 7 days" | "Older";

export const SECTIONS: Section[] = ["Today", "Previous 7 days", "Older"];

const DAY_MS = 24 * 60 * 60 * 1000;

export function sectionOf(iso: string, now: Date): Section {
  const at = new Date(iso).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= startOfToday) return "Today";
  if (at >= startOfToday - 7 * DAY_MS) return "Previous 7 days";
  return "Older";
}

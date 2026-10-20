// When something happened, the way people say it: "just now", "5 minutes ago", "yesterday", and
// the date alone once it is a week old; and the full date and time, for a tooltip.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateAndTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const ago = Math.abs(seconds);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return relative.format(Math.trunc(seconds / MINUTE), "minute");
  if (ago < DAY) return relative.format(Math.trunc(seconds / HOUR), "hour");
  if (ago < WEEK) return relative.format(Math.trunc(seconds / DAY), "day");
  return dateOnly.format(new Date(iso));
}

export function fullTime(iso: string) {
  return dateAndTime.format(new Date(iso));
}

// When something happened, the way people say it: "just now", "5 minutes ago", "yesterday", and
// the date alone once it is a week old, or in a few characters where there is room for no more;
// how long until something happens, as "in 3 hours"; and the full date and time, for a tooltip.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

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

// "now", "4m", "3h", "2d", "3w", "5mo", "2y".
export function shortTimeAgo(iso: string, now = Date.now()) {
  const ago = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (ago < MINUTE) return "now";
  if (ago < HOUR) return `${Math.trunc(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.trunc(ago / HOUR)}h`;
  if (ago < WEEK) return `${Math.trunc(ago / DAY)}d`;
  if (ago < MONTH) return `${Math.trunc(ago / WEEK)}w`;
  if (ago < YEAR) return `${Math.trunc(ago / MONTH)}mo`;
  return `${Math.trunc(ago / YEAR)}y`;
}

// Null once the moment has passed.
export function timeUntil(iso: string, now = Date.now()) {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  if (seconds <= 0) return null;
  if (seconds < MINUTE) return "in less than a minute";
  if (seconds < HOUR) return relative.format(Math.ceil(seconds / MINUTE), "minute");
  if (seconds < DAY) return relative.format(Math.round(seconds / HOUR), "hour");
  return relative.format(Math.round(seconds / DAY), "day");
}

export function fullTime(iso: string) {
  return dateAndTime.format(new Date(iso));
}

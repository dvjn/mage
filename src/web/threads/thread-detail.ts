// Merges events into a thread's detail: each event once, in seq order, with the thread's last seq
// following. Live events join the detail already shown, and a fresh read of the thread keeps the
// live events that arrived after the server answered it.

import type { AnyThreadEvent, ThreadDetail } from "@/shared/threads.ts";

// The detail with the events it did not have yet.
export function withEvents(detail: ThreadDetail, events: AnyThreadEvent[]): ThreadDetail {
  const known = new Set(detail.events.map((event) => event.seq));
  const added = events.filter((event) => !known.has(event.seq));
  if (added.length === 0) return detail;
  const merged = [...detail.events, ...added].toSorted((a, b) => a.seq - b.seq);
  const lastEventSeq = Math.max(detail.thread.lastEventSeq, merged.at(-1)?.seq ?? 0);
  return { ...detail, events: merged, thread: { ...detail.thread, lastEventSeq } };
}

// The fresh read, plus the events shown so far that are newer than it. Everything else on the
// server's side wins, so a thread renamed or an event list cut there shows as the server has it.
export function withLiveEvents(fetched: ThreadDetail, shown: ThreadDetail): ThreadDetail {
  const last = fetched.events.at(-1)?.seq ?? 0;
  return withEvents(
    fetched,
    shown.events.filter((event) => event.seq > last),
  );
}

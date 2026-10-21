// A count that goes up once a minute, for what shows a time relative to now. Every component that
// uses it shares one interval, which runs only while any of them is shown.

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let minutes = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    minutes += 1;
    for (const notify of listeners) notify();
  }, MINUTE_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

function snapshot() {
  return minutes;
}

// Renders the component again each minute.
export function useMinute() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

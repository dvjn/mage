// Whether the browser is online, as the query client follows it: queries wait while it is not, and
// pages say so. It starts from what the browser says, so a page opened offline knows at once.

import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

onlineManager.setOnline(typeof navigator === "undefined" || navigator.onLine !== false);

export function useOnline() {
  return useSyncExternalStore(
    (changed) => onlineManager.subscribe(changed),
    () => onlineManager.isOnline(),
  );
}

// What a write says while the browser is offline, or when the server cannot be reached.
export const OFFLINE_ERROR = "You are offline. Try again once you are back online.";

function offlineAnswer() {
  return Response.json({ error: OFFLINE_ERROR }, { status: 503 });
}

// Fetches as `fetcher` does; a write while offline, or one that gets no answer, is answered here
// with what to say, as the server answers a failed one. Reads fail as they would, and wait.
export function writesSayOffline(fetcher: typeof fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method === "GET" || method === "HEAD") return fetcher(input, init);
    if (!onlineManager.isOnline()) return offlineAnswer();
    try {
      return await fetcher(input, init);
    } catch (error) {
      if (error instanceof TypeError) return offlineAnswer();
      throw error;
    }
  };
}

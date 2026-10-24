// Whether the app is online, as the query client follows it: queries wait while it is not, and
// pages say so. It is offline while the browser has no network, and while the server cannot be
// reached: a request to it got no answer, or a live stream could not connect and a check got none.
// Until the server answers again it is asked, less often each time, whether it is back. It starts
// from what the browser says, so a page opened offline knows at once.

import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

// How long the first check for an unreachable server waits, and the longest any waits.
export const FIRST_CHECK_MS = 2000;
export const LONGEST_CHECK_MS = 30_000;

// A request that got no answer; one the server answered, even with an error, did not.
function noAnswer(error: unknown) {
  return error instanceof TypeError;
}

// Whether the server can be reached, from how requests to it fare. Once one gets no answer, `ask`
// is called, after a wait that doubles from the first to the longest, until the server answers.
export function serverReachability(
  ask: () => Promise<unknown>,
  changed: (reachable: boolean) => void,
) {
  let reachable = true;
  let wait = FIRST_CHECK_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking: Promise<boolean> | undefined;

  function answered() {
    clearTimeout(timer);
    timer = undefined;
    wait = FIRST_CHECK_MS;
    if (reachable) return;
    reachable = true;
    changed(true);
  }

  function unanswered() {
    if (reachable) {
      reachable = false;
      changed(false);
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      wait = Math.min(wait * 2, LONGEST_CHECK_MS);
      void check();
    }, wait);
  }

  // Asks the server now, once however many want to know; whether it answered.
  function check() {
    asking ??= ask()
      .then(
        () => {
          answered();
          return true;
        },
        (error: unknown) => {
          if (!noAnswer(error)) {
            answered();
            return true;
          }
          unanswered();
          return false;
        },
      )
      .finally(() => {
        asking = undefined;
      });
    return asking;
  }

  // Asks at once while the server cannot be reached, as when the network comes back.
  function checkAgain() {
    if (reachable) return;
    clearTimeout(timer);
    timer = undefined;
    wait = FIRST_CHECK_MS;
    void check();
  }

  // Fetches as `fetcher` does, noting whether the server answered.
  function follow(fetcher: typeof fetch) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const res = await fetcher(input, init);
        answered();
        return res;
      } catch (error) {
        if (noAnswer(error)) unanswered();
        throw error;
      }
    };
  }

  return { reachable: () => reachable, check, checkAgain, follow };
}

// Why the app is offline, or null while it is online.
export type OfflineReason = "network" | "server" | null;

let network = typeof navigator === "undefined" || navigator.onLine !== false;
const listeners = new Set<() => void>();

// The ways to sign in: the cheapest thing the server answers.
const server = serverReachability(
  () => fetch("/api/sign-in-options", { cache: "no-store" }),
  update,
);

function reason(): OfflineReason {
  if (!network) return "network";
  return server.reachable() ? null : "server";
}

function update() {
  onlineManager.setOnline(reason() === null);
  for (const listener of listeners) listener();
}

onlineManager.setEventListener(() => {
  if (typeof window === "undefined") return;
  function up() {
    network = true;
    update();
    server.checkAgain();
  }
  function down() {
    network = false;
    update();
  }
  window.addEventListener("online", up);
  window.addEventListener("offline", down);
  return () => {
    window.removeEventListener("online", up);
    window.removeEventListener("offline", down);
  };
});
update();

function subscribe(changed: () => void) {
  listeners.add(changed);
  return () => listeners.delete(changed);
}

export function useOfflineReason() {
  return useSyncExternalStore(subscribe, reason);
}

export function useOnline() {
  return useOfflineReason() === null;
}

// Fetches as `fetcher` does; a request that gets no answer takes the app offline until the server
// answers again.
export const followServer = server.follow;

// Asks the server now, as when a live stream was lost; whether it answered.
export const checkServer = server.check;

// What a write says while the app is offline.
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

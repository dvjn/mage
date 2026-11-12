// The typed API client; every call names the tab's org, one that gets no answer takes the app
// offline, a write offline says so, and an answer that the session is gone is passed on. The org is named by the fetch rather than by the client's
// headers option, which the client awaits: so each call's request starts in the same tick, and a
// traced action is its request's parent.

import { hc } from "hono/client";

import type { Api } from "@/server/app.ts";
import { followServer, writesSayOffline } from "@/web/lib/online";
import { orgFetch } from "@/web/lib/org-tab";

let sessionLost = () => {};

// Called when the server answers a call that nobody is signed in, so the session is asked about.
export function onSessionLost(handler: () => void) {
  sessionLost = handler;
}

function noticeSessionLost(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await fetcher(input, init);
    if (res.status === 401) sessionLost();
    return res;
  };
}

export const apiClient = hc<Api>("/api", {
  fetch: writesSayOffline(noticeSessionLost(followServer(orgFetch as typeof fetch))),
});

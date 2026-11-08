// The typed API client; every call names the tab's org, one that gets no answer takes the app
// offline, and a write offline says so. The org is named by the fetch rather than by the client's
// headers option, which the client awaits: so each call's request starts in the same tick, and a
// traced action is its request's parent.

import { hc } from "hono/client";

import type { Api } from "@/server/app.ts";
import { followServer, writesSayOffline } from "@/web/lib/online";
import { orgFetch } from "@/web/lib/org-tab";

export const apiClient = hc<Api>("/api", {
  fetch: writesSayOffline(followServer(orgFetch as typeof fetch)),
});

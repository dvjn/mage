// The typed API client; every call names the tab's org, one that gets no answer takes the app
// offline, and a write offline says so.

import { hc } from "hono/client";

import type { Api } from "@/server/app.ts";
import { followServer, writesSayOffline } from "@/web/lib/online";
import { orgFetch, orgHeaders } from "@/web/lib/org-tab";

export const apiClient = hc<Api>("/api", {
  headers: orgHeaders,
  fetch: writesSayOffline(followServer(orgFetch as typeof fetch)),
});

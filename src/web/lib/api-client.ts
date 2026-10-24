// The typed API client; every call names the tab's org, and a write offline says so.

import { hc } from "hono/client";

import type { Api } from "@/http/app.ts";
import { writesSayOffline } from "@/web/lib/online";
import { orgFetch, orgHeaders } from "@/web/lib/org-tab";

export const apiClient = hc<Api>("/api", {
  headers: orgHeaders,
  fetch: writesSayOffline(orgFetch as typeof fetch),
});

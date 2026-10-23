// The typed API client; every call names the tab's org.

import { hc } from "hono/client";

import type { Api } from "@/http/app.ts";
import { orgFetch, orgHeaders } from "@/web/lib/org-tab";

export const apiClient = hc<Api>("/api", { headers: orgHeaders, fetch: orgFetch });

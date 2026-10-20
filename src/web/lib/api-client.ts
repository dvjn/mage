import { hc } from "hono/client";

import type { Api } from "@/http/app.ts";

export const apiClient = hc<Api>("/api");

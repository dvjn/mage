// Server state the web client reads: API health and the current session.

import { queryOptions } from "@tanstack/react-query";

import { healthSchema } from "@/shared/health.ts";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: async () => healthSchema.parse(await (await apiClient.health.$get()).json()),
});

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async () => {
    const { data, error } = await authClient.getSession();
    if (error) throw new Error(error.message ?? "could not read the session");
    return data;
  },
});

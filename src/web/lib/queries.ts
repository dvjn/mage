// Server state the web client reads: the current session, who is signed in and their connections.

import { queryOptions } from "@tanstack/react-query";

import { connectionListSchema } from "@/shared/connections.ts";
import { meSchema } from "@/shared/me.ts";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async () => {
    const { data, error } = await authClient.getSession();
    if (error) throw new Error(error.message ?? "could not read the session");
    return data;
  },
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const res = await apiClient.v1.me.$get();
    if (!res.ok) throw new Error("could not read the signed-in user");
    return meSchema.parse(await res.json());
  },
});

export const connectionsQuery = queryOptions({
  queryKey: ["connections"],
  queryFn: async () => {
    const res = await apiClient.v1.connections.$get();
    if (!res.ok) throw new Error("could not read your connections");
    return connectionListSchema.parse(await res.json());
  },
});

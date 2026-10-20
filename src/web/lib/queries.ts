// Server state the web client reads: the current session, who is signed in, their connections, the
// models the org can use and its default model.

import { queryOptions } from "@tanstack/react-query";

import { connectionListSchema } from "@/shared/connections.ts";
import { meSchema } from "@/shared/me.ts";
import { defaultModelSchema, modelListSchema } from "@/shared/models.ts";
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

// Refreshing reads every connection's list from its provider again.
export async function fetchModels(refresh = false) {
  const res = await apiClient.v1.models.$get({ query: { refresh: refresh ? "1" : "0" } });
  if (!res.ok) throw new Error("could not read the models");
  return modelListSchema.parse(await res.json());
}

export const modelsQuery = queryOptions({
  queryKey: ["models"],
  queryFn: () => fetchModels(),
});

export const defaultModelQuery = queryOptions({
  queryKey: ["default-model"],
  queryFn: async () => {
    const res = await apiClient.v1.settings["default-model"].$get();
    if (!res.ok) throw new Error("could not read the default model");
    return defaultModelSchema.parse(await res.json());
  },
});

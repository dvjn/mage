import { queryOptions } from "@tanstack/react-query";

import { connectionListSchema } from "@/shared/connections.ts";
import {
  defaultEffortSchema,
  defaultModelSchema,
  modelListSchema,
  titleModelSchema,
} from "@/shared/models.ts";
import { apiClient } from "@/web/api/api-client";
import { connectionModelsSchema } from "@/shared/models.ts";
import { errorOf } from "@/web/api/api-errors";

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

export const defaultEffortQuery = queryOptions({
  queryKey: ["default-effort"],
  queryFn: async () => {
    const res = await apiClient.v1.settings["default-effort"].$get();
    if (!res.ok) throw new Error("could not read the default effort");
    return defaultEffortSchema.parse(await res.json());
  },
});

export const titleModelQuery = queryOptions({
  queryKey: ["title-model"],
  queryFn: async () => {
    const res = await apiClient.v1.settings["title-model"].$get();
    if (!res.ok) throw new Error("could not read the title model");
    return titleModelSchema.parse(await res.json());
  },
});

// A connection's models; a list the server could not read says why at once rather than being
// asked for again.
export function connectionModelsQuery(connectionId: string) {
  return {
    queryKey: ["connection-models", connectionId],
    retry: false,
    queryFn: async () => {
      const res = await apiClient.v1.connections[":id"].models.$get({
        param: { id: connectionId },
        query: { refresh: "0" },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return connectionModelsSchema.parse(await res.json());
    },
  };
}

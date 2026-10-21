// Server state the web client reads: the current session, who is signed in, their connections, the
// models the org can use, its default model and title model, and their spaces with their folders and threads.

import { queryOptions } from "@tanstack/react-query";

import { connectionListSchema } from "@/shared/connections.ts";
import { folderListSchema } from "@/shared/folders.ts";
import { meSchema } from "@/shared/me.ts";
import { defaultModelSchema, modelListSchema, titleModelSchema } from "@/shared/models.ts";
import { spaceListSchema } from "@/shared/spaces.ts";
import { type ThreadDetail, threadDetailSchema, threadListSchema } from "@/shared/threads.ts";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";
import { withLiveEvents } from "@/web/lib/thread-detail";

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

export const titleModelQuery = queryOptions({
  queryKey: ["title-model"],
  queryFn: async () => {
    const res = await apiClient.v1.settings["title-model"].$get();
    if (!res.ok) throw new Error("could not read the title model");
    return titleModelSchema.parse(await res.json());
  },
});

export const spacesQuery = queryOptions({
  queryKey: ["spaces"],
  queryFn: async () => {
    const res = await apiClient.v1.spaces.$get();
    if (!res.ok) throw new Error("could not read your spaces");
    return spaceListSchema.parse(await res.json());
  },
});

export function spaceFoldersQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["spaces", spaceId, "folders"],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].folders.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's folders");
      return folderListSchema.parse(await res.json());
    },
  });
}

export function spaceThreadsQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["spaces", spaceId, "threads"],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].threads.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's threads");
      return threadListSchema.parse(await res.json());
    },
  });
}

// A thread with its events so far; live events are merged in as they arrive, and a read keeps
// the ones that arrived while it was on its way.
export function threadQuery(threadId: string) {
  const queryKey = ["threads", threadId] as const;
  return queryOptions({
    queryKey,
    queryFn: async ({ client }) => {
      const res = await apiClient.v1.threads[":id"].$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read the thread");
      const fetched = threadDetailSchema.parse(await res.json());
      const shown = client.getQueryData<ThreadDetail>(queryKey);
      return shown ? withLiveEvents(fetched, shown) : fetched;
    },
  });
}

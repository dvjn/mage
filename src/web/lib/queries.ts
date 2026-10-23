// Server state the web client reads: the current session, who is signed in, the orgs they are in,
// the tab org's members, groups and settings, their connections, the models the org can use, its
// default model and effort and title model, their spaces with who is in them, their folders and
// threads, the threads shared with them, and who is in a thread.

import { queryOptions } from "@tanstack/react-query";

import { connectionListSchema } from "@/shared/connections.ts";
import { folderListSchema } from "@/shared/folders.ts";
import { sharedThreadListSchema, threadPeopleSchema } from "@/shared/guests.ts";
import { meSchema } from "@/shared/me.ts";
import { orgListSchema, teamSettingsSchema } from "@/shared/orgs.ts";
import {
  defaultEffortSchema,
  defaultModelSchema,
  modelListSchema,
  titleModelSchema,
} from "@/shared/models.ts";
import { spaceListSchema } from "@/shared/spaces.ts";
import { type ThreadDetail, threadDetailSchema, threadListSchema } from "@/shared/threads.ts";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";
import { adoptOrg } from "@/web/lib/org-tab";
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
    const me = meSchema.parse(await res.json());
    // A tab that named no org acts from now on in the one the server chose.
    adoptOrg(me.org.id);
    return me;
  },
});

// The orgs the signed-in user is in, and whether they may create a team org.
export const orgsQuery = queryOptions({
  queryKey: ["orgs"],
  queryFn: async () => {
    const res = await apiClient.v1.orgs.$get();
    if (!res.ok) throw new Error("could not read your organizations");
    return orgListSchema.parse(await res.json());
  },
});

export const teamSettingsQuery = queryOptions({
  queryKey: ["team-settings"],
  queryFn: async () => {
    const res = await apiClient.v1.org.settings.$get();
    if (!res.ok) throw new Error("could not read the organization's settings");
    return teamSettingsSchema.parse(await res.json());
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

// The threads the signed-in user is a guest in.
export const sharedThreadsQuery = queryOptions({
  queryKey: ["shared-threads"],
  queryFn: async () => {
    const res = await apiClient.v1["shared-threads"].$get();
    if (!res.ok) throw new Error("could not read the threads shared with you");
    return sharedThreadListSchema.parse(await res.json());
  },
});

// The thread's members who wrote in it, its guests and its invite links not yet used.
export function threadPeopleQuery(threadId: string) {
  return queryOptions({
    queryKey: ["thread-people", threadId],
    queryFn: async () => {
      const res = await apiClient.v1.threads[":id"].people.$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read who is in the thread");
      return threadPeopleSchema.parse(await res.json());
    },
  });
}

// The server says the thread does not exist, or is not the reader's to see.
export class ThreadNotFound extends Error {}

// The reader was a guest of the thread and their access has ended.
export class ThreadAccessEnded extends Error {}

// A thread with its events so far; live events are merged in as they arrive, and a read keeps
// the ones that arrived while it was on its way. A thread that is not found, or whose guest access
// has ended, is not asked for again; a read that fails otherwise, as when the server cannot be
// reached, is tried again until it succeeds, waiting longer each time up to ten seconds.
export function threadQuery(threadId: string) {
  const queryKey = ["threads", threadId] as const;
  return queryOptions({
    queryKey,
    retry: (_count, error) =>
      !(error instanceof ThreadNotFound || error instanceof ThreadAccessEnded),
    retryDelay: (count) => Math.min(1000 * 2 ** count, 10_000),
    queryFn: async ({ client }) => {
      const res = await apiClient.v1.threads[":id"].$get({ param: { id: threadId } });
      if ((res.status as number) === 404) throw new ThreadNotFound("Thread not found");
      if ((res.status as number) === 410) throw new ThreadAccessEnded("Access ended");
      if (!res.ok) throw new Error("could not read the thread");
      const fetched = threadDetailSchema.parse(await res.json());
      const shown = client.getQueryData<ThreadDetail>(queryKey);
      return shown ? withLiveEvents(fetched, shown) : fetched;
    },
  });
}

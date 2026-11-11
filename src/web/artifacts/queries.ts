import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import {
  artifactDetailSchema,
  artifactPageSchema,
  artifactSchema,
  artifactSettingsSchema,
  artifactViewSchema,
  type ArtifactTheme,
} from "@/shared/artifacts.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

export function artifactQuery(id: string) {
  return queryOptions({
    queryKey: ["artifacts", "one", id],
    queryFn: async () => {
      const res = await apiClient.v1.artifacts[":id"].$get({ param: { id } });
      if (!res.ok) throw new Error("could not read the artifact");
      return artifactDetailSchema.parse(await res.json());
    },
    retry: false,
  });
}

// The artifacts a thread used.
export function threadArtifactsQuery(threadId: string) {
  return queryOptions({
    queryKey: ["artifacts", "thread", threadId],
    queryFn: async () => {
      const res = await apiClient.v1.threads[":id"].artifacts.$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read the thread's artifacts");
      return artifactSchema.array().parse(await res.json());
    },
  });
}

// A link to the page on its own origin, for this reader and theme; it lasts about an hour.
export function artifactViewQuery(id: string, version: number | undefined, theme: ArtifactTheme) {
  return queryOptions({
    queryKey: ["artifacts", "view", id, version ?? "latest", theme],
    queryFn: async () => {
      const res = await apiClient.v1.artifacts[":id"].view.$post({
        param: { id },
        json: { ...(version && { version }), theme },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return artifactViewSchema.parse(await res.json());
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

export const orgArtifactSettingsQuery = queryOptions({
  queryKey: ["artifacts", "settings", "org"],
  queryFn: async () => {
    const res = await apiClient.v1.org.artifacts.settings.$get();
    if (!res.ok) throw new Error("could not read the artifact settings");
    return artifactSettingsSchema.parse(await res.json());
  },
});

export function spaceArtifactSettingsQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["artifacts", "settings", "space", spaceId],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].artifacts.settings.$get({
        param: { id: spaceId },
      });
      if (!res.ok) throw new Error("could not read the artifact settings");
      return artifactSettingsSchema.parse(await res.json());
    },
  });
}

// The gallery, a page after another.
export const artifactPages = infiniteQueryOptions({
  queryKey: ["artifacts", "gallery"],
  initialPageParam: null as string | null,
  queryFn: async ({ pageParam }) => {
    const res = await apiClient.v1.artifacts.$get({
      query: { ...(pageParam && { cursor: pageParam }) },
    });
    if (!res.ok) throw new Error("could not read the artifacts");
    return artifactPageSchema.parse(await res.json());
  },
  getNextPageParam: (last) => last.nextCursor,
});

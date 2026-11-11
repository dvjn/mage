// Changes to artifacts: who may view one, which threads' guests and which people may, deleting one, and whether public ones are allowed.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { ArtifactRole, ArtifactSharing } from "@/shared/artifacts.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

export function useSetSharing(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { sharing: ArtifactSharing; orgRole?: ArtifactRole }) => {
      const res = await apiClient.v1.artifacts[":id"].sharing.$put({
        param: { id },
        json: change,
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
}

// Shares the artifact with the guests of a thread that used it, or stops.
export function useShareWithGuests(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { threadId: string; shared: boolean }) => {
      const res = await apiClient.v1.artifacts[":id"].guests.$put({ param: { id }, json: change });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
}

// Gives a person access to the artifact to view or to edit, changes it, or takes it back.
export function useSharePerson(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { userId: string; shared: boolean; role?: ArtifactRole }) => {
      const param = { id, userId: change.userId };
      const res = change.shared
        ? await apiClient.v1.artifacts[":id"].people[":userId"].$put({
            param,
            json: { role: change.role ?? "view" },
          })
        : await apiClient.v1.artifacts[":id"].people[":userId"].$delete({ param });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
}

// Gives a group access to the artifact to view or to edit, changes it, or takes it back.
export function useShareGroup(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { groupId: string; shared: boolean; role?: ArtifactRole }) => {
      const param = { id, groupId: change.groupId };
      const res = change.shared
        ? await apiClient.v1.artifacts[":id"].groups[":groupId"].$put({
            param,
            json: { role: change.role ?? "view" },
          })
        : await apiClient.v1.artifacts[":id"].groups[":groupId"].$delete({ param });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
}

// Deletes the artifact and goes to the gallery, even if its page was already closed by the event.
export function useDeleteArtifact(id: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.artifacts[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: async () => {
      await navigate({ to: "/artifacts" });
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
}

// Allows or refuses public artifacts for the org, or for a space.
export function useAllowPublic(spaceId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (publicAllowed: boolean) => {
      const res = spaceId
        ? await apiClient.v1.spaces[":id"].artifacts.settings.$put({
            param: { id: spaceId },
            json: { publicAllowed },
          })
        : await apiClient.v1.org.artifacts.settings.$put({ json: { publicAllowed } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
}

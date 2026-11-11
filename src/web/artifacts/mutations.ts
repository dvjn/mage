// Changes to artifacts: who may view one, deleting one, and whether public ones are allowed.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { ArtifactSharing } from "@/shared/artifacts.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

export function useSetSharing(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sharing: ArtifactSharing) => {
      const res = await apiClient.v1.artifacts[":id"].sharing.$put({
        param: { id },
        json: { sharing },
      });
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

// Changes to a space's folders: making, renaming and deleting one. Each reads the space again.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { folderSchema } from "@/shared/folders.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

// Makes a folder, answering it.
export function useCreateFolder(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.v1.spaces[":id"].folders.$post({
        param: { id: spaceId },
        json: { name },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return folderSchema.parse(await res.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] }),
  });
}

export function useRenameFolder(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiClient.v1.folders[":id"].$patch({ param: { id }, json: { name } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] }),
  });
}

// Deletes a folder; its threads move to the top of the space.
export function useDeleteFolder(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.v1.folders[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] }),
  });
}

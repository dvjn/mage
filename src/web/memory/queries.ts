// A space's memory as its settings read it, and forgetting an entry.

import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { spaceMemorySchema } from "@/shared/memory.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

export function spaceMemoryQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["spaces", spaceId, "memory"],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].memory.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's memory");
      return spaceMemorySchema.parse(await res.json());
    },
  });
}

export function useForgetMemory(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiClient.v1.spaces[":id"].memory[":entryId"].$delete({
        param: { id: spaceId, entryId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries(spaceMemoryQuery(spaceId)),
  });
}

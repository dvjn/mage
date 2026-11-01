import { queryOptions } from "@tanstack/react-query";

import { spaceListSchema, trashedSpaceListSchema } from "@/shared/spaces.ts";
import { apiClient } from "@/web/api/api-client";

export const spacesQuery = queryOptions({
  queryKey: ["spaces"],
  queryFn: async () => {
    const res = await apiClient.v1.spaces.$get();
    if (!res.ok) throw new Error("could not read your spaces");
    return spaceListSchema.parse(await res.json());
  },
});

// The org's spaces in trash the person may see: those they deleted, or all of them for its owners.
export const spaceTrashQuery = queryOptions({
  queryKey: ["space-trash"],
  queryFn: async () => {
    const res = await apiClient.v1.spaces.trash.$get();
    if (!res.ok) throw new Error("could not read the trash");
    return trashedSpaceListSchema.parse(await res.json());
  },
});

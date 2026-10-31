import { queryOptions } from "@tanstack/react-query";

import { spaceListSchema } from "@/shared/spaces.ts";
import { apiClient } from "@/web/api/api-client";

export const spacesQuery = queryOptions({
  queryKey: ["spaces"],
  queryFn: async () => {
    const res = await apiClient.v1.spaces.$get();
    if (!res.ok) throw new Error("could not read your spaces");
    return spaceListSchema.parse(await res.json());
  },
});

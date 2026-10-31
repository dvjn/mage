import { queryOptions } from "@tanstack/react-query";

import { instructionsSchema, spaceInstructionsSchema } from "@/shared/instructions.ts";
import { apiClient } from "@/web/api/api-client";

export const orgInstructionsQuery = queryOptions({
  queryKey: ["instructions", "org"],
  queryFn: async () => {
    const res = await apiClient.v1.org.instructions.$get();
    if (!res.ok) throw new Error("could not read the instructions");
    return instructionsSchema.parse(await res.json());
  },
});

export function spaceInstructionsQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["instructions", "space", spaceId],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].instructions.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's instructions");
      return spaceInstructionsSchema.parse(await res.json());
    },
  });
}

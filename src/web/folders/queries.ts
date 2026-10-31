import { queryOptions } from "@tanstack/react-query";

import { folderListSchema } from "@/shared/folders.ts";
import { apiClient } from "@/web/api/api-client";

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

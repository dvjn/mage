import { queryOptions } from "@tanstack/react-query";

import { toolsetSettingListSchema } from "@/shared/tools.ts";
import { apiClient } from "@/web/api/api-client";
import type { Scope } from "@/web/shell/scope";

// The org's or a space's toolsets, with each tool's policy.
export function toolsQuery(scope: Scope) {
  return queryOptions({
    queryKey: scope.kind === "org" ? ["org-tools"] : ["spaces", scope.spaceId, "tools"],
    queryFn: async () => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.tools.$get()
          : await apiClient.v1.spaces[":id"].tools.$get({ param: { id: scope.spaceId } });
      if (!res.ok) throw new Error("could not read the tools");
      return toolsetSettingListSchema.parse(await res.json());
    },
  });
}

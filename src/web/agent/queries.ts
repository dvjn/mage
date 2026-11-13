import { queryOptions } from "@tanstack/react-query";

import * as z from "zod";

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

// What a tool call gave back, where its row left it out for its size: it never changes.
export function toolResultQuery(id: string) {
  return queryOptions({
    queryKey: ["tool-results", id],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await apiClient.v1["tool-results"][":id"].$get({ param: { id } });
      if (!res.ok) throw new Error("could not read the result");
      return z.object({ value: z.unknown() }).parse(await res.json());
    },
  });
}

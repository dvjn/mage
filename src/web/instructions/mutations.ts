import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import type { Scope } from "@/web/shell/scope";

export function useSaveInstructions(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.instructions.$put({ json: { text } })
          : await apiClient.v1.spaces[":id"].instructions.$put({
              param: { id: scope.spaceId },
              json: { text },
            });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["instructions"] }),
  });
}

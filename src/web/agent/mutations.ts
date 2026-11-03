// Changes to the org's or a space's tools: setting tools to a policy, switching a built-in toolset
// or one of its options on or off, and making, changing and removing policies.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type ToolPolicy,
  type ToolPolicyInput,
  toolPolicySchema,
  toolsetSettingListSchema,
} from "@/shared/tools.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { policiesKey } from "@/web/agent/policies/model";
import { toolsQuery } from "@/web/agent/queries";
import type { Scope } from "@/web/shell/scope";

// Sets tools to a policy, off, or nothing.
export function useToolsChange(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolIds, policy }: { toolIds: string[]; policy: string | null }) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.tools.$patch({ json: { toolIds, policy } })
          : await apiClient.v1.spaces[":id"].tools.$patch({
              param: { id: scope.spaceId },
              json: { toolIds, policy },
            });
      if (!res.ok) throw new Error(await errorOf(res));
      return toolsetSettingListSchema.parse(await res.json());
    },
    onSuccess: async (toolsets) => {
      queryClient.setQueryData(toolsQuery(scope).queryKey, toolsets);
      await queryClient.invalidateQueries({ queryKey: ["threads"] });
      if (scope.kind === "org") await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });
}

export function useToolsetSwitch(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolsetId, enabled }: { toolsetId: string; enabled: boolean }) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.toolsets[":toolsetId"].$put({
              param: { toolsetId },
              json: { enabled },
            })
          : await apiClient.v1.spaces[":id"].toolsets[":toolsetId"].$put({
              param: { id: scope.spaceId, toolsetId },
              json: { enabled },
            });
      if (!res.ok) throw new Error(await errorOf(res));
      return toolsetSettingListSchema.parse(await res.json());
    },
    onSuccess: async (toolsets) => {
      queryClient.setQueryData(toolsQuery(scope).queryKey, toolsets);
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });
}

// Turns a built-in toolset's option on or off.
export function useToolsetOption(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolsetId,
      option,
      enabled,
    }: {
      toolsetId: string;
      option: string;
      enabled: boolean;
    }) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.toolsets[":toolsetId"].options[":option"].$put({
              param: { toolsetId, option },
              json: { enabled },
            })
          : await apiClient.v1.spaces[":id"].toolsets[":toolsetId"].options[":option"].$put({
              param: { id: scope.spaceId, toolsetId, option },
              json: { enabled },
            });
      if (!res.ok) throw new Error(await errorOf(res));
      return toolsetSettingListSchema.parse(await res.json());
    },
    onSuccess: (toolsets) => {
      queryClient.setQueryData(toolsQuery(scope).queryKey, toolsets);
    },
  });
}

async function policiesChanged(queryClient: ReturnType<typeof useQueryClient>, scope: Scope) {
  await queryClient.invalidateQueries({ queryKey: policiesKey(scope) });
  await queryClient.invalidateQueries({ queryKey: ["org-tool-policies"] });
  await queryClient.invalidateQueries({ queryKey: ["threads"] });
}

// Makes a policy, or changes the one with `id`; `then` runs with it saved before the policies are
// read again.
export function useSavePolicy(scope: Scope, then?: (saved: ToolPolicy) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, json }: { id?: string; json: ToolPolicyInput }) => {
      const res = id
        ? scope.kind === "org"
          ? await apiClient.v1.org["tool-policies"][":policyId"].$put({
              param: { policyId: id },
              json,
            })
          : await apiClient.v1.spaces[":id"]["tool-policies"][":policyId"].$put({
              param: { id: scope.spaceId, policyId: id },
              json,
            })
        : scope.kind === "org"
          ? await apiClient.v1.org["tool-policies"].$post({ json })
          : await apiClient.v1.spaces[":id"]["tool-policies"].$post({
              param: { id: scope.spaceId },
              json,
            });
      if (!res.ok) throw new Error(await errorOf(res));
      return toolPolicySchema.parse(await res.json());
    },
    onSuccess: async (saved) => {
      await then?.(saved);
      await policiesChanged(queryClient, scope);
    },
  });
}

export function useRemovePolicy(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org["tool-policies"][":policyId"].$delete({
              param: { policyId: id },
            })
          : await apiClient.v1.spaces[":id"]["tool-policies"][":policyId"].$delete({
              param: { id: scope.spaceId, policyId: id },
            });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => policiesChanged(queryClient, scope),
  });
}

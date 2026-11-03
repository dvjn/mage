// Changes to spaces: making one, or the person's own, its name, the model and effort its threads start with, who has a role in it,
// deleting it, and restoring it from trash or deleting it for good; and how the org makes them, and
// making a team org from the switcher.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createdOrgSchema, type TeamSettings } from "@/shared/orgs.ts";
import { spaceSchema, type SpaceRole } from "@/shared/spaces.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { teamSettingsQuery } from "@/web/orgs/queries";
import { spacesQuery, spaceTrashQuery } from "@/web/spaces/queries";

export function useRenameSpace(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.v1.spaces[":id"].$patch({
        param: { id: spaceId },
        json: { name },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
  });
}

export function useSpaceDefaults(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: {
      model?: string | null;
      effort?: Effort | null;
      agentName?: string | null;
    }) => {
      const res = await apiClient.v1.spaces[":id"].defaults.$patch({
        param: { id: spaceId },
        json,
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
  });
}

// Deletes a space, or puts a member's own one in trash; the spaces are read again once `leave`,
// when given, has taken the person elsewhere.
export function useDeleteSpace(leave?: () => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      const res = await apiClient.v1.spaces[":id"].$delete({ param: { id: spaceId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: async () => {
      await leave?.();
      await trashChanged(queryClient);
    },
  });
}

async function trashChanged(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["org-spaces"] }),
    queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: spaceTrashQuery.queryKey }),
  ]);
}

// Takes a space out of trash as it was.
export function useRestoreSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      const res = await apiClient.v1.spaces.trash[":id"].restore.$post({ param: { id: spaceId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => trashChanged(queryClient),
  });
}

// Deletes a space in trash for good.
export function usePurgeSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      const res = await apiClient.v1.spaces.trash[":id"].$delete({ param: { id: spaceId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => trashChanged(queryClient),
  });
}

// Makes a space, answering it.
export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.v1.spaces.$post({ json: { name } });
      if (!res.ok) throw new Error(await errorOf(res));
      return spaceSchema.parse(await res.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
  });
}

// Makes the person's own space in their team org, answering it.
export function useCreateMySpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.spaces.mine.$post();
      if (!res.ok) throw new Error(await errorOf(res));
      return spaceSchema.parse(await res.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
  });
}

// Makes a team org, answering its id; the switcher offers it beside the spaces.
export function useCreateOrg() {
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.v1.orgs.$post({ json: { name } });
      if (!res.ok) throw new Error(await errorOf(res));
      return createdOrgSchema.parse(await res.json()).orgId;
    },
  });
}

// How the org's members make spaces: who may, and whether each may have one of their own, which
// archives or restores those made.
export function useTeamSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: Partial<TeamSettings>) => {
      const res = await apiClient.v1.org.settings.$patch({ json });
      if (!res.ok) throw new Error(await errorOf(res));
      queryClient.setQueryData(teamSettingsQuery.queryKey, (await res.json()) as TeamSettings);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ["org-spaces"] }),
      ]),
  });
}

async function membersChanged(queryClient: ReturnType<typeof useQueryClient>, spaceId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] }),
    queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ["org-spaces"] }),
  ]);
}

// Gives a person or group a role in the space, or with none takes it away.
export function useSpaceGrant(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: { kind: "user" | "group"; id: string; role: SpaceRole | null }) => {
      const res = await apiClient.v1.spaces[":id"].members.$put({ param: { id: spaceId }, json });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => membersChanged(queryClient, spaceId),
  });
}

// The role everyone in the org has in the space, or none. The members are read again even when it
// fails.
export function useSpaceEveryone(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (role: "viewer" | "messager" | null) => {
      const res = await apiClient.v1.spaces[":id"].everyone.$put({
        param: { id: spaceId },
        json: { role },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSettled: () => membersChanged(queryClient, spaceId),
  });
}

// Changes to the org: its name, deleting it, and its people: adding, inviting, their roles and
// removing them.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createdOrgInviteSchema, type OrgRole } from "@/shared/orgs.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { meQuery } from "@/web/auth/queries";
import { orgsQuery } from "@/web/orgs/queries";

export function useRenameOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await apiClient.v1.org.$patch({ json: { name } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: orgsQuery.queryKey }),
      ]),
  });
}

export function useDeleteOrg() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.org.$delete();
      if (!res.ok) throw new Error(await errorOf(res));
    },
  });
}

async function peopleChanged(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all(
    ["org-people", "org-members", "org-groups", "directory"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}

// A member's or a linked group's role; the people are read again even when it fails.
export function useOrgRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: { kind: "member" | "group"; id: string; role: OrgRole }) => {
      const res =
        change.kind === "member"
          ? await apiClient.v1.org.members[":userId"].$patch({
              param: { userId: change.id },
              json: { role: change.role },
            })
          : await apiClient.v1.org.groups[":id"].$patch({
              param: { id: change.id },
              json: { role: change.role },
            });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSettled: () => peopleChanged(queryClient),
  });
}

// Removes a member, unlinks a group or takes back an invite.
export function useOrgRemoval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (removing: { kind: "member" | "group" | "invite"; id: string }) => {
      const res =
        removing.kind === "member"
          ? await apiClient.v1.org.members[":userId"].$delete({ param: { userId: removing.id } })
          : removing.kind === "group"
            ? await apiClient.v1.org.groups[":id"].$delete({ param: { id: removing.id } })
            : await apiClient.v1.org.invites[":id"].$delete({ param: { id: removing.id } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => peopleChanged(queryClient),
  });
}

// Adds someone from the directory, links a group, or invites by email, answering the invite made.
export function useOrgAdd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      adding:
        | { kind: "user" | "group"; id: string; role: OrgRole }
        | { email: string; role: OrgRole },
    ) => {
      const res =
        "email" in adding
          ? await apiClient.v1.org.invites.$post({
              json: { email: adding.email, role: adding.role },
            })
          : adding.kind === "group"
            ? await apiClient.v1.org.groups.$post({
                json: { groupId: adding.id, role: adding.role },
              })
            : await apiClient.v1.org.members.$post({
                json: { userId: adding.id, role: adding.role },
              });
      if (!res.ok) throw new Error(await errorOf(res));
      return "email" in adding ? createdOrgInviteSchema.parse(await res.json()) : null;
    },
    onSuccess: () => peopleChanged(queryClient),
  });
}

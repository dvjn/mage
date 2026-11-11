// Sharing a thread: making an invite link, adding a member of the org, changing what a guest, a
// link or the org's members may do, and taking away a guest's access or an invite. Each reads the
// thread's people again.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type AccessFor,
  createdInviteSchema,
  type OrgAccess,
  type ThreadRole,
} from "@/shared/guests.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { threadPeopleQuery } from "@/web/guests/queries";

export function useCreateInvite(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invite: { accessFor: AccessFor; role: ThreadRole }) => {
      const res = await apiClient.v1.threads[":id"].invites.$post({
        param: { id: threadId },
        json: invite,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return createdInviteSchema.parse(await res.json());
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
  });
}

// Makes a member of the org, or everyone in a group of it, a guest; the people and who can still be
// added are read again.
export function useAddGuest(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      guest: ({ userId: string } | { groupId: string }) & {
        accessFor: AccessFor;
        role: ThreadRole;
      },
    ) => {
      const res =
        "groupId" in guest
          ? await apiClient.v1.threads[":id"]["group-guests"].$post({
              param: { id: threadId },
              json: guest,
            })
          : await apiClient.v1.threads[":id"].guests.$post({
              param: { id: threadId },
              json: guest,
            });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["guest-candidates", threadId] }),
      ]),
  });
}

// Takes away a guest's or a group's access or an invite; the people are read again even when it
// fails.
export function useRevoke(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: { guest: string } | { group: string } | { invite: string }) => {
      const res =
        "guest" in path
          ? await apiClient.v1.threads[":id"].guests[":userId"].$delete({
              param: { id: threadId, userId: path.guest },
            })
          : "group" in path
            ? await apiClient.v1.threads[":id"]["group-guests"][":groupId"].$delete({
                param: { id: threadId, groupId: path.group },
              })
            : await apiClient.v1.threads[":id"].invites[":inviteId"].$delete({
                param: { id: threadId, inviteId: path.invite },
              });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
  });
}

// Changes what the org's members outside the space may do in the thread.
export function useSetOrgAccess(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orgAccess: OrgAccess) => {
      const res = await apiClient.v1.threads[":id"]["org-access"].$put({
        param: { id: threadId },
        json: { orgAccess },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
  });
}

// Changes what a guest, a group or the holder of a link not yet used may do in the thread.
export function useSetGuestRole(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      change: ({ guest: string } | { group: string } | { invite: string }) & {
        role: ThreadRole;
      },
    ) => {
      const { role } = change;
      const res =
        "guest" in change
          ? await apiClient.v1.threads[":id"].guests[":userId"].role.$put({
              param: { id: threadId, userId: change.guest },
              json: { role },
            })
          : "group" in change
            ? await apiClient.v1.threads[":id"]["group-guests"][":groupId"].role.$put({
                param: { id: threadId, groupId: change.group },
                json: { role },
              })
            : await apiClient.v1.threads[":id"].invites[":inviteId"].role.$put({
                param: { id: threadId, inviteId: change.invite },
                json: { role },
              });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
  });
}

// Sharing a thread with guests: making an invite link, and taking away a guest's access or an
// invite. Each reads the thread's people again.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type AccessFor, createdInviteSchema } from "@/shared/guests.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { threadPeopleQuery } from "@/web/guests/queries";

export function useCreateInvite(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (accessFor: AccessFor) => {
      const res = await apiClient.v1.threads[":id"].invites.$post({
        param: { id: threadId },
        json: { accessFor },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return createdInviteSchema.parse(await res.json());
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey }),
  });
}

// Takes away a guest's access or an invite; the people are read again even when it fails.
export function useRevoke(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: { guest: string } | { invite: string }) => {
      const res =
        "guest" in path
          ? await apiClient.v1.threads[":id"].guests[":userId"].$delete({
              param: { id: threadId, userId: path.guest },
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

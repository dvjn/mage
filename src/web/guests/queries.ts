import { queryOptions } from "@tanstack/react-query";

import { sharedThreadListSchema, threadPeopleSchema } from "@/shared/guests.ts";
import { apiClient } from "@/web/api/api-client";

// The threads the signed-in user is a guest in.
export const sharedThreadsQuery = queryOptions({
  queryKey: ["shared-threads"],
  queryFn: async () => {
    const res = await apiClient.v1["shared-threads"].$get();
    if (!res.ok) throw new Error("could not read the threads shared with you");
    return sharedThreadListSchema.parse(await res.json());
  },
});

// The thread's members who wrote in it, its guests and its invite links not yet used.
export function threadPeopleQuery(threadId: string) {
  return queryOptions({
    queryKey: ["thread-people", threadId],
    queryFn: async () => {
      const res = await apiClient.v1.threads[":id"].people.$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read who is in the thread");
      return threadPeopleSchema.parse(await res.json());
    },
  });
}

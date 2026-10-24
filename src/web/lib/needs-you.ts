// The threads that need the signed-in person, among the sidebar's space and those shared with them:
// the agent waits for their decision, or its last run failed since they looked; newest first.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { SharedThread } from "@/shared/guests.ts";
import { needsYou, statusOf } from "@/shared/thread-status.ts";
import type { ThreadListItem } from "@/shared/threads.ts";
import { usePlace } from "@/web/lib/active-space";
import { meQuery, sharedThreadsQuery, spaceThreadsQuery } from "@/web/lib/queries";

export type NeedsYouItem =
  | { kind: "space"; thread: ThreadListItem }
  | { kind: "shared"; thread: SharedThread };

export function useNeedsYou(): NeedsYouItem[] {
  const place = usePlace();
  const me = useQuery(meQuery);
  const spaceId = place?.kind === "space" && place.space.role ? place.space.id : undefined;
  const threads = useQuery({ ...spaceThreadsQuery(spaceId ?? ""), enabled: !!spaceId });
  const shared = useQuery(sharedThreadsQuery);
  const userId = me.data?.user.id;
  return useMemo(() => {
    if (!userId) return [];
    const mine = (spaceId ? (threads.data ?? []) : []).map(
      (thread) => ({ kind: "space", thread }) as const,
    );
    const theirs = (shared.data ?? []).map((thread) => ({ kind: "shared", thread }) as const);
    return [...mine, ...theirs]
      .filter((item) => needsYou(statusOf(item.thread.activity, userId)))
      .toSorted((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
  }, [userId, spaceId, threads.data, shared.data]);
}

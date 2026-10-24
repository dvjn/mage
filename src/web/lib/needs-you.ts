// The threads that need the signed-in person, among the sidebar's space and those shared with them:
// the agent waits for their decision, or its last run failed since they looked; newest first, as
// many as the sidebar has of the space's, and how many there are in all.

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

export function useNeedsYou(): { items: NeedsYouItem[]; total: number } {
  const place = usePlace();
  const me = useQuery(meQuery);
  const spaceId = place?.kind === "space" && place.space.role ? place.space.id : undefined;
  const threads = useQuery({ ...spaceThreadsQuery(spaceId ?? ""), enabled: !!spaceId });
  const shared = useQuery(sharedThreadsQuery);
  const userId = me.data?.user.id;
  return useMemo(() => {
    if (!userId) return { items: [], total: 0 };
    const sidebar = spaceId ? threads.data : undefined;
    const needing = (item: NeedsYouItem) => needsYou(statusOf(item.thread.activity, userId));
    const mine = (sidebar?.threads ?? [])
      .map((thread) => ({ kind: "space", thread }) as const)
      .filter(needing);
    const theirs = (shared.data ?? [])
      .map((thread) => ({ kind: "shared", thread }) as const)
      .filter(needing);
    const items = [...mine, ...theirs].toSorted((a, b) =>
      b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    );
    // A thread that just came to need them counts before the space's count is read again.
    const total = Math.max(sidebar?.needsYou ?? 0, mine.length) + theirs.length;
    return { items, total };
  }, [userId, spaceId, threads.data, shared.data]);
}

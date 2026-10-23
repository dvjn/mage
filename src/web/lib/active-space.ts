// Where the sidebar is: the threads shared with the person, on their page or in one of those
// threads, or otherwise a space: the page's, or the open thread's, or the one used last, or the
// first one.

import { useQuery } from "@tanstack/react-query";
import { useMatchRoute, useParams } from "@tanstack/react-router";

import type { SharedThread } from "@/shared/guests.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import { lastSpace } from "@/web/lib/last-space";
import { sharedThreadsQuery, spacesQuery, threadQuery } from "@/web/lib/queries";

export type Place =
  | { kind: "space"; space: SpaceSummary }
  // The open shared thread, when one is open.
  | { kind: "shared"; thread: SharedThread | undefined };

export function usePlace(): Place | undefined {
  const { spaceId, threadId } = useParams({ strict: false });
  const matchRoute = useMatchRoute();
  const spaces = useQuery(spacesQuery);
  const shared = useQuery(sharedThreadsQuery);
  const thread = useQuery({ ...threadQuery(threadId ?? ""), enabled: threadId !== undefined });
  if (matchRoute({ to: "/shared" })) return { kind: "shared", thread: undefined };
  if (thread.data?.access.via === "guest") {
    return { kind: "shared", thread: shared.data?.find((t) => t.id === threadId) };
  }
  const wanted = spaceId ?? thread.data?.thread.spaceId ?? lastSpace();
  const space = spaces.data?.find((s) => s.id === wanted) ?? spaces.data?.[0];
  return space && { kind: "space", space };
}

// The space the sidebar shows, or none while it shows the shared threads.
export function useActiveSpace() {
  const place = usePlace();
  return place?.kind === "space" ? place.space : undefined;
}

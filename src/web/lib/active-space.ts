// The space the sidebar shows: the page's space, or the open thread's, or the space used last, or
// the first one.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { lastSpace } from "@/web/lib/last-space";
import { spacesQuery, threadQuery } from "@/web/lib/queries";

export function useActiveSpace() {
  const { spaceId, threadId } = useParams({ strict: false });
  const spaces = useQuery(spacesQuery);
  const thread = useQuery({ ...threadQuery(threadId ?? ""), enabled: threadId !== undefined });
  const wanted = spaceId ?? thread.data?.thread.spaceId ?? lastSpace();
  return spaces.data?.find((space) => space.id === wanted) ?? spaces.data?.[0];
}

// A space's threads in the sidebar, listed grouped, the newest few of them, with the search for
// the rest.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import { SidebarGroup } from "@/web/components/ui/sidebar";
import { GroupedThreads } from "@/web/threads/nav/grouped-threads";
import { Empty, MenuSkeleton } from "@/web/threads/nav/list-states";
import { type Nav, type NavAction, NavContext } from "@/web/threads/nav/nav-context";
import { SpaceSection } from "@/web/threads/nav/space-section";
import { ThreadItem } from "@/web/threads/nav/thread-item";
import { spaceThreadsQuery } from "@/web/threads/queries";
import { ThreadDialogs } from "@/web/threads/thread-dialogs";
import { useOpenThreadSearch } from "@/web/threads/thread-search";

export function SpaceThreads({ space }: { space: SpaceSummary }) {
  const threads = useQuery(spaceThreadsQuery(space.id));
  const { threadId } = useParams({ strict: false });
  const openSearch = useOpenThreadSearch();
  const [action, setAction] = useState<NavAction | null>(null);

  const nav = useMemo<Nav>(
    () => ({ activeThreadId: threadId, act: setAction, role: space.role }),
    [threadId, space.role],
  );

  const listed = threads.data?.threads ?? [];
  // A thread that just joined counts before the count is read again.
  const total = Math.max(threads.data?.total ?? 0, listed.length);
  return (
    <>
      <SpaceSection space={space} />
      <SidebarGroup>
        <NavContext value={nav}>
          <GroupedThreads
            threads={listed}
            total={total}
            row={(thread) => <ThreadItem key={thread.id} thread={thread} />}
            more={(hidden) => `${hidden} more threads`}
            onMore={() => openSearch()}
          >
            {threads.isPending && <MenuSkeleton />}
            {threads.isSuccess && listed.length === 0 && (
              <Empty>
                {space.role === "viewer" ? "No threads yet." : "No threads yet. Start one above."}
              </Empty>
            )}
          </GroupedThreads>
        </NavContext>
      </SidebarGroup>
      <ThreadDialogs spaceId={space.id} action={action} onClose={() => setAction(null)} />
    </>
  );
}

// The threads shared with the person, grouped the same as a space's, each with the space it is in.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import type { SharedThread } from "@/shared/guests.ts";
import { SidebarGroup, SidebarGroupLabel } from "@/web/components/ui/sidebar";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { GroupedThreads } from "@/web/threads/nav/grouped-threads";
import { Empty, MenuSkeleton } from "@/web/threads/nav/list-states";
import { ThreadRow } from "@/web/threads/thread-row";
import { useOpenThreadSearch } from "@/web/threads/thread-search";

// The threads shared with the person, grouped, each with the space it is in, and its org on hover.
export function SharedThreads() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  const openSearch = useOpenThreadSearch();
  const list = shared.data ?? [];
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Shared with you</SidebarGroupLabel>
      <GroupedThreads
        threads={list}
        total={list.length}
        row={(thread: SharedThread) => (
          <ThreadRow
            key={thread.id}
            variant="sidebar"
            thread={thread}
            place={thread.spaceName}
            title={thread.place}
            isActive={thread.id === threadId}
          />
        )}
        more={(hidden) => `${hidden} more threads`}
        onMore={() => openSearch({ scope: "shared" })}
      >
        {shared.isPending && <MenuSkeleton />}
        {shared.isSuccess && list.length === 0 && <Empty>No threads are shared with you.</Empty>}
      </GroupedThreads>
    </SidebarGroup>
  );
}

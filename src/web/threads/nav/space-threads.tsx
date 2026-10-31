// A space's threads in the sidebar: chips pick a folder, or all of the space, and remember it;
// the threads picked are listed grouped below.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import { SidebarGroup, SidebarGroupLabel } from "@/web/components/ui/sidebar";
import { useFolderActivity } from "@/web/folders/folder-activity";
import { FolderDialogs } from "@/web/folders/folder-dialogs";
import { usePickedFolder } from "@/web/folders/picked-folder";
import { useShortcut } from "@/web/lib/shortcuts";
import { useMoveThread } from "@/web/threads/mutations";
import { FolderChips } from "@/web/threads/nav/folder-chips";
import { GroupedThreads } from "@/web/threads/nav/grouped-threads";
import { Empty, MenuSkeleton } from "@/web/threads/nav/list-states";
import { type Nav, type NavAction, NavContext } from "@/web/threads/nav/nav-context";
import { SpaceSection } from "@/web/threads/nav/space-section";
import { ThreadItem } from "@/web/threads/nav/thread-item";
import { useNewThread } from "@/web/threads/nav/use-new-thread";
import { spaceThreadsQuery } from "@/web/threads/queries";
import { ThreadDialogs } from "@/web/threads/thread-dialogs";
import { type SearchStart, useOpenThreadSearch } from "@/web/threads/thread-search";

export function SpaceThreads({ space }: { space: SpaceSummary }) {
  const folders = useFolderActivity(space.id);
  const threads = useQuery(spaceThreadsQuery(space.id));
  const { threadId } = useParams({ strict: false });
  const newThread = useNewThread();
  const openSearch = useOpenThreadSearch();
  const [pickedId, pick] = usePickedFolder(space.id);
  const [action, setAction] = useState<NavAction | null>(null);
  useShortcut("newFolder", () => setAction({ kind: "new-folder" }), {
    enabled: space.role !== "viewer",
  });

  const { mutate: moveThread } = useMoveThread();
  const nav = useMemo<Nav>(
    () => ({
      activeThreadId: threadId,
      act: setAction,
      folders: folders.map((f) => f.folder),
      spaceId: space.id,
      move: (thread, folderId) => {
        if (thread.folderId === folderId) return;
        moveThread({ thread: { id: thread.id, spaceId: space.id }, folderId });
      },
      role: space.role,
    }),
    [threadId, space.id, space.role, folders, moveThread],
  );

  // A folder deleted, or not read yet, leaves all of the space picked.
  const picked = folders.find((f) => f.folder.id === pickedId);
  const all = threads.data?.threads ?? [];
  const listed = picked ? all.filter((thread) => thread.folderId === picked.folder.id) : all;
  const spaceTotal = (threads.data?.loose ?? 0) + folders.reduce((sum, f) => sum + f.count, 0);
  const total = picked ? picked.count : spaceTotal;
  const folderNames = new Map(folders.map((f) => [f.folder.id, f.folder.name]));
  const search = (start: SearchStart = {}) =>
    openSearch(picked ? { ...start, folderId: picked.folder.id } : start);
  return (
    <>
      <SpaceSection space={space} onNewFolder={() => setAction({ kind: "new-folder" })} />
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <NavContext value={nav}>
          <FolderChips
            folders={folders}
            total={spaceTotal}
            picked={picked}
            onPick={pick}
            onStart={(folderId) => newThread(space.id, folderId)}
          />
          <GroupedThreads
            threads={listed}
            total={total}
            row={(thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                place={!picked && thread.folderId ? folderNames.get(thread.folderId) : undefined}
              />
            )}
            more={(hidden) =>
              picked ? `All ${total} in ${picked.folder.name}` : `${hidden} more threads`
            }
            onMore={() => search()}
          >
            {threads.isPending && <MenuSkeleton />}
            {threads.isSuccess && listed.length === 0 && (
              <Empty>
                {picked
                  ? "No threads"
                  : space.role === "viewer"
                    ? "No threads yet."
                    : "No threads yet. Start one above."}
              </Empty>
            )}
          </GroupedThreads>
        </NavContext>
      </SidebarGroup>
      <FolderDialogs spaceId={space.id} action={action} onClose={() => setAction(null)} />
      <ThreadDialogs spaceId={space.id} action={action} onClose={() => setAction(null)} />
    </>
  );
}

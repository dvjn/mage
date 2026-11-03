// A space's folders as the sidebar and the search show them: how many threads each holds, whether
// one inside needs the signed-in person, and the most recently active first.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import { needsYou } from "@/shared/thread-status.ts";
import { spaceFoldersQuery } from "@/web/folders/queries";
import { spaceThreadsQuery } from "@/web/threads/queries";

export interface FolderActivity {
  folder: FolderSummary;
  count: number;
  needsYou: boolean;
}

export function useFolderActivity(spaceId: string | undefined) {
  const folders = useQuery({ ...spaceFoldersQuery(spaceId ?? ""), enabled: !!spaceId });
  const threads = useQuery({ ...spaceThreadsQuery(spaceId ?? ""), enabled: !!spaceId });
  return useMemo(() => {
    const list = threads.data?.threads ?? [];
    const latest = new Map<string, string>();
    const needing = new Set<string>();
    for (const thread of list) {
      if (!thread.folderId) continue;
      if ((latest.get(thread.folderId) ?? "") < thread.updatedAt) {
        latest.set(thread.folderId, thread.updatedAt);
      }
      if (needsYou(thread.status)) needing.add(thread.folderId);
    }
    const counted = (folder: FolderSummary): FolderActivity => ({
      folder,
      // A thread that just joined counts before the counts are read again.
      count: Math.max(
        threads.data?.folders[folder.id] ?? 0,
        list.filter((thread) => thread.folderId === folder.id).length,
      ),
      needsYou: needing.has(folder.id),
    });
    const activeAt = (folder: FolderSummary) => latest.get(folder.id) ?? folder.updatedAt;
    return (folders.data ?? [])
      .map(counted)
      .toSorted((a, b) => activeAt(b.folder).localeCompare(activeAt(a.folder)));
  }, [folders.data, threads.data]);
}

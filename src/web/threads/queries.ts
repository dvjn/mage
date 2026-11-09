import { queryOptions } from "@tanstack/react-query";

import { threadCommandsSchema } from "@/shared/threads/commands.ts";
import { type ThreadDetail, threadDetailSchema } from "@/shared/threads/detail.ts";
import { asideListSchema, shownBranchSchema } from "@/shared/threads/history.ts";
import { threadSidebarSchema } from "@/shared/threads/list.ts";
import { rowsPageSchema } from "@/shared/threads/rows.ts";
import { apiClient } from "@/web/api/api-client";
import { withFreshRead } from "@/web/threads/thread-rows";

// The space's threads as its sidebar lists them.
export function spaceThreadsQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["spaces", spaceId, "threads"],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].threads.sidebar.$get({
        param: { id: spaceId },
      });
      if (!res.ok) throw new Error("could not read the space's threads");
      return threadSidebarSchema.parse(await res.json());
    },
  });
}

// The server says the thread does not exist, or is not the reader's to see.
export class ThreadNotFound extends Error {}

// The reader was a guest of the thread and their access has ended.
export class ThreadAccessEnded extends Error {}

// The thread as the reader sees it, its current branch or the one named.
async function readThread(threadId: string, branch?: string) {
  const res = await apiClient.v1.threads[":id"].$get({
    param: { id: threadId },
    query: { branch },
  });
  if ((res.status as number) === 404) throw new ThreadNotFound("Thread not found");
  if ((res.status as number) === 410) throw new ThreadAccessEnded("Access ended");
  if (!res.ok) throw new Error("could not read the thread");
  return threadDetailSchema.parse(await res.json());
}

const retry = (_count: number, error: Error) =>
  !(error instanceof ThreadNotFound || error instanceof ThreadAccessEnded);

// A thread with its newest rows as the reader sees them; live rows are merged in as they arrive,
// and a read keeps the earlier pages read so far and the rows that arrived while it was on its
// way. A thread that is not found, or whose guest access has ended, is not asked for again; a read
// that fails otherwise, as when the server cannot be reached, is tried again until it succeeds,
// waiting longer each time up to ten seconds.
export function threadQuery(threadId: string) {
  const queryKey = ["threads", threadId] as const;
  return queryOptions({
    queryKey,
    retry,
    retryDelay: (count) => Math.min(1000 * 2 ** count, 10_000),
    queryFn: async ({ client }) => {
      const fetched = await readThread(threadId);
      const shown = client.getQueryData<ThreadDetail>(queryKey);
      return shown ? withFreshRead(fetched, shown) : fetched;
    },
  });
}

// A branch of the thread other than its current one, read as it is now; one whose stopped run is
// still ending is read again every second until it ends.
export function threadBranchQuery(threadId: string, branchId: string) {
  return queryOptions({
    queryKey: ["threads", threadId, "branch", branchId] as const,
    retry,
    queryFn: () => readThread(threadId, branchId),
    refetchInterval: (query) => (query.state.data?.run ? 1000 : false),
  });
}

// The reader's side questions in the thread.
export function asidesQuery(threadId: string) {
  return queryOptions({
    queryKey: ["threads", threadId, "asides"] as const,
    queryFn: async () => {
      const res = await apiClient.v1.threads[":id"].asides.$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read the side questions");
      return asideListSchema.parse(await res.json());
    },
  });
}

// The commands the reader may send in the thread.
export function threadCommandsQuery(threadId: string) {
  return queryOptions({
    queryKey: ["threads", threadId, "commands"],
    staleTime: 30_000,
    queryFn: async () => {
      const res = await apiClient.v1.threads[":id"].commands.$get({ param: { id: threadId } });
      if (!res.ok) throw new Error("could not read the thread's commands");
      return threadCommandsSchema.parse(await res.json());
    },
  });
}

// The branch of the thread that holds the row: its current one when it does, else the newest.
export async function branchOfRow(threadId: string, rowId: string) {
  const res = await apiClient.v1.threads[":id"].rows[":rowId"].branch.$get({
    param: { id: threadId, rowId },
  });
  if (!res.ok) throw new Error("could not find the message");
  return shownBranchSchema.parse(await res.json());
}

// The rows of the thread before the place `before`, or with `at` as many as reach back to that row;
// of the branch named, or else the current one.
export async function earlierRows(threadId: string, before: number, at?: string, branch?: string) {
  const res = await apiClient.v1.threads[":id"].rows.$get({
    param: { id: threadId },
    query: { before: String(before), ...(at && { at }), ...(branch && { branch }) },
  });
  if (!res.ok) throw new Error("could not read the thread's earlier rows");
  return rowsPageSchema.parse(await res.json());
}

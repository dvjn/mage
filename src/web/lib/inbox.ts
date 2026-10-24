// Keeps the cached thread lists current from the signed-in person's inbox stream, one per tab: a
// thread that changed takes its place in its space's list, most recently active first, or joins it
// when the list is cached but does not have it yet; a shared one is changed in the shared list, which
// is read again when it lacks the thread; the pages of tables of threads it is in are read again. How far they saw a thread, here or on another device,
// clears what was new, and a thread gone for them leaves every list. After the stream was lost the
// lists are read again. Reading a thread records how far it was seen, at once in the lists here.
// The open thread is marked seen as it opens and as new events arrive while it is in view.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { SharedThread } from "@/shared/guests.ts";
import {
  type ThreadActivity,
  type ThreadListItem,
  threadListItemSchema,
} from "@/shared/threads.ts";
import { apiClient } from "@/web/lib/api-client";
import { tabOrg } from "@/web/lib/org-tab";
import { sharedThreadsQuery, spaceThreadsQuery } from "@/web/lib/queries";

type Listed = { id: string; updatedAt: string; activity: ThreadActivity };

// Most recently active first, as the server lists them.
function newestFirst<T extends Listed>(list: T[]) {
  return list.toSorted(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
  );
}

// The space's list with the thread as it now reads, in its place by when it was last active.
export function withThread(list: ThreadListItem[], thread: ThreadListItem) {
  return newestFirst([...list.filter((item) => item.id !== thread.id), thread]);
}

// The shared list with the thread's changes, or null when it does not have the thread.
export function withSharedThread(
  list: SharedThread[],
  thread: ThreadListItem,
): SharedThread[] | null {
  if (!list.some((item) => item.id === thread.id)) return null;
  return newestFirst(list.map((item) => (item.id === thread.id ? { ...item, ...thread } : item)));
}

// The list with the thread seen up to `seq`, never moving back.
export function withSeen<T extends Listed>(list: T[], threadId: string, seq: number): T[] {
  return list.map((item) =>
    item.id === threadId && item.activity.lastSeenSeq < seq
      ? { ...item, activity: { ...item.activity, lastSeenSeq: seq } }
      : item,
  );
}

export function without<T extends Listed>(list: T[], threadId: string): T[] {
  return list.filter((item) => item.id !== threadId);
}

// Every cached list of a space's threads.
const spaceLists = {
  predicate: (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] === "spaces" && query.queryKey[2] === "threads",
};

// Every cached page of a table of threads.
const threadPages = { queryKey: ["thread-pages"] };

// Changes every cached list, of a space's threads and of shared ones, and every page of them.
function eachList(queryClient: QueryClient, change: <T extends Listed>(list: T[]) => T[]) {
  queryClient.setQueriesData<ThreadListItem[]>(spaceLists, (list) => list && change(list));
  queryClient.setQueryData(sharedThreadsQuery.queryKey, (list) => list && change(list));
  queryClient.setQueriesData<{ items: Listed[] }>(
    threadPages,
    (page) => page && { ...page, items: change(page.items) },
  );
}

// Records here that the thread was seen up to `seq`.
export function seenHere(queryClient: QueryClient, threadId: string, seq: number) {
  eachList(queryClient, (list) => withSeen(list, threadId, seq));
}

// Tells the server the thread was seen up to `seq`, showing it here at once.
export async function markRead(queryClient: QueryClient, threadId: string, seq: number) {
  seenHere(queryClient, threadId, seq);
  // It outlives leaving the page right after opening the thread.
  await apiClient.v1.threads[":id"].read
    .$put({ param: { id: threadId }, json: { seq } }, { init: { keepalive: true } })
    .catch(() => null);
}

function patchThread(queryClient: QueryClient, thread: ThreadListItem, shared: boolean) {
  // A page's rows and their order depend on its search and filters, so the server reads it again.
  void queryClient.invalidateQueries({
    queryKey: ["thread-pages", shared ? "shared" : thread.spaceId],
  });
  if (shared) {
    const list = queryClient.getQueryData(sharedThreadsQuery.queryKey);
    const next = list && withSharedThread(list, thread);
    if (next) queryClient.setQueryData(sharedThreadsQuery.queryKey, next);
    else void queryClient.invalidateQueries({ queryKey: sharedThreadsQuery.queryKey });
    return;
  }
  queryClient.setQueryData(
    spaceThreadsQuery(thread.spaceId).queryKey,
    (list) => list && withThread(list, thread),
  );
}

// Follows the inbox while the signed-in app is open.
export function useInbox() {
  const queryClient = useQueryClient();
  useEffect(() => {
    // A stream cannot send headers, so it names the tab's org in its address.
    const org = tabOrg();
    const source = new EventSource(`/api/v1/inbox/events${org ? `?org=${org}` : ""}`);
    let lost = false;
    source.addEventListener("error", () => {
      lost = true;
    });
    source.addEventListener("open", () => {
      if (!lost) return;
      lost = false;
      void queryClient.invalidateQueries(spaceLists);
      void queryClient.invalidateQueries({ queryKey: sharedThreadsQuery.queryKey });
      void queryClient.invalidateQueries(threadPages);
    });
    source.addEventListener("thread", (message) => {
      const body = JSON.parse(message.data as string) as { thread: unknown; shared: boolean };
      const thread = threadListItemSchema.safeParse(body.thread);
      if (thread.success) patchThread(queryClient, thread.data, body.shared);
    });
    source.addEventListener("thread-read", (message) => {
      const { threadId, seq } = JSON.parse(message.data as string) as {
        threadId: string;
        seq: number;
      };
      seenHere(queryClient, threadId, seq);
    });
    source.addEventListener("thread-gone", (message) => {
      const { threadId } = JSON.parse(message.data as string) as { threadId: string };
      eachList(queryClient, (list) => without(list, threadId));
      void queryClient.invalidateQueries(threadPages);
    });
    return () => source.close();
  }, [queryClient]);
}

// How long new events wait to be marked seen, so a reply as it streams is told once.
const READ_DELAY_MS = 1000;

// Marks the open thread seen up to `seq`: at once when it opens, then a second after new events
// while the tab is in view and focused, and again when it comes back into view.
export function useMarkRead(threadId: string, seq: number | undefined) {
  const queryClient = useQueryClient();
  const sent = useRef<{ threadId: string; seq: number } | null>(null);
  const latest = useRef(seq);
  latest.current = seq;
  const send = useCallback(() => {
    const now = latest.current;
    if (now === undefined) return;
    if (sent.current?.threadId === threadId && sent.current.seq >= now) return;
    sent.current = { threadId, seq: now };
    void markRead(queryClient, threadId, now);
  }, [queryClient, threadId]);

  useEffect(() => {
    if (seq === undefined) return;
    if (sent.current?.threadId !== threadId) {
      send();
      return;
    }
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) send();
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [send, threadId, seq]);

  useEffect(() => {
    function back() {
      if (document.visibilityState === "visible") send();
    }
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [send]);
}

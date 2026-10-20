// Keeps a thread's cached events current: follows its live event stream from the newest event
// already cached, and merges each event in once, in seq order. The browser reconnects on its own
// and resumes after the last event it saw.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { type AnyThreadEvent, anyThreadEventSchema } from "@/shared/threads.ts";
import { threadQuery } from "@/web/lib/queries";

// Adds the events the cache does not have yet, keeping seq order, and moves the thread's last seq.
export function mergeEvents(queryClient: QueryClient, threadId: string, events: AnyThreadEvent[]) {
  queryClient.setQueryData(threadQuery(threadId).queryKey, (detail) => {
    if (!detail) return detail;
    const known = new Set(detail.events.map((event) => event.seq));
    const added = events.filter((event) => !known.has(event.seq));
    if (added.length === 0) return detail;
    const merged = [...detail.events, ...added].toSorted((a, b) => a.seq - b.seq);
    const lastEventSeq = Math.max(detail.thread.lastEventSeq, merged.at(-1)?.seq ?? 0);
    return { ...detail, events: merged, thread: { ...detail.thread, lastEventSeq } };
  });
}

export function useThreadEvents(threadId: string, ready: boolean, onEvent?: () => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ready) return;
    const after = queryClient.getQueryData(threadQuery(threadId).queryKey)?.thread.lastEventSeq;
    const source = new EventSource(`/api/v1/threads/${threadId}/events?after=${after ?? 0}`);
    source.addEventListener("thread-event", (message) => {
      const event = anyThreadEventSchema.safeParse(JSON.parse(message.data as string));
      if (!event.success) return;
      mergeEvents(queryClient, threadId, [event.data]);
      onEvent?.();
    });
    return () => source.close();
  }, [queryClient, threadId, ready, onEvent]);
}

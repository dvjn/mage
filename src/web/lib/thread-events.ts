// Keeps a thread's cached events current: follows its live event stream from the newest event
// already cached, and merges each event in once, in seq order. The browser reconnects on its own
// and resumes after the last event it saw.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { type AnyThreadEvent, anyThreadEventSchema } from "@/shared/threads.ts";
import { threadQuery } from "@/web/lib/queries";
import { withEvents } from "@/web/lib/thread-detail";

// Adds the events the cache does not have yet.
export function mergeEvents(queryClient: QueryClient, threadId: string, events: AnyThreadEvent[]) {
  queryClient.setQueryData(threadQuery(threadId).queryKey, (detail) =>
    detail ? withEvents(detail, events) : detail,
  );
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

// Keeps a thread's cached events current and its replies in progress streaming: follows its live
// event stream from the newest event already cached, merges each event in once, in seq order, shows
// a title the agent gives the thread, and gathers the pieces of each reply still being written. The
// browser reconnects on its own and resumes after the last event it saw; the server sends each
// reply's pieces again from the start, and the ones already here are skipped.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  type AnyThreadEvent,
  anyThreadEventSchema,
  type DeltaBatch,
  deltaBatchSchema,
} from "@/shared/threads.ts";
import { threadQuery } from "@/web/lib/queries";
import { withEvents } from "@/web/lib/thread-detail";

// Adds the events the cache does not have yet.
export function mergeEvents(queryClient: QueryClient, threadId: string, events: AnyThreadEvent[]) {
  queryClient.setQueryData(threadQuery(threadId).queryKey, (detail) =>
    detail ? withEvents(detail, events) : detail,
  );
}

// Shows the title the agent gave the thread.
function renamed(queryClient: QueryClient, threadId: string, data: unknown) {
  const title = (data as { title?: unknown }).title;
  if (typeof title !== "string") return;
  queryClient.setQueryData(threadQuery(threadId).queryKey, (detail) =>
    detail ? { ...detail, thread: { ...detail.thread, title } } : detail,
  );
}

// A reply's pieces so far, of its answer and of its reasoning, joined.
export interface Streaming {
  text: string;
  reasoning: string;
  // How many pieces the two hold.
  pieces: number;
}

// The replies with the batch's pieces they did not have yet.
export function withPieces(
  streaming: ReadonlyMap<string, Streaming>,
  { messageId, index, texts, part }: DeltaBatch,
): ReadonlyMap<string, Streaming> {
  const current = streaming.get(messageId) ?? { text: "", reasoning: "", pieces: 0 };
  const known = Math.max(0, current.pieces - index);
  if (known >= texts.length) return streaming;
  const added = texts.slice(known).join("");
  const next = new Map(streaming);
  next.set(messageId, {
    text: part === "reasoning" ? current.text : current.text + added,
    reasoning: part === "reasoning" ? current.reasoning + added : current.reasoning,
    pieces: index + texts.length,
  });
  return next;
}

// The text so far of each reply in progress, by message id.
export function useThreadEvents(threadId: string, ready: boolean, onEvent?: () => void) {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState<ReadonlyMap<string, Streaming>>(new Map());

  useEffect(() => {
    setStreaming(new Map());
    if (!ready) return;
    const after = queryClient.getQueryData(threadQuery(threadId).queryKey)?.thread.lastEventSeq;
    const source = new EventSource(`/api/v1/threads/${threadId}/events?after=${after ?? 0}`);
    source.addEventListener("thread-event", (message) => {
      const event = anyThreadEventSchema.safeParse(JSON.parse(message.data as string));
      if (!event.success) return;
      mergeEvents(queryClient, threadId, [event.data]);
      if (event.data.type === "thread.renamed") renamed(queryClient, threadId, event.data.data);
      onEvent?.();
    });
    source.addEventListener("message-delta", (message) => {
      const batch = deltaBatchSchema.safeParse(JSON.parse(message.data as string));
      if (batch.success) setStreaming((current) => withPieces(current, batch.data));
    });
    return () => source.close();
  }, [queryClient, threadId, ready, onEvent]);

  return streaming;
}

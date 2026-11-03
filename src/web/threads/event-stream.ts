// Keeps a thread's cached rows current and its replies in progress streaming: follows its live
// stream from the newest event already cached, merges in the rows each new event changed, as the
// reader sees them, with the messages waiting and the run under way, takes the thread as the server
// now has it once it is renamed, moved or set to another model, and gathers the pieces of each
// reply still being written. The browser reconnects on its own and resumes after the last event it
// saw; the server sends each reply's pieces again from the start, and the ones already here are
// skipped. A lost stream asks whether the server answers at all; when it does not, the app is
// offline. When the server says the reader's guest access has ended, following stops and the
// thread is read again, which tells them so.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { threadHeadSchema } from "@/shared/threads/detail.ts";
import { type DeltaBatch, deltaBatchSchema } from "@/shared/threads/events.ts";
import { rowsUpdateSchema } from "@/shared/threads/rows.ts";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { checkServer, useOnline } from "@/web/lib/online";
import { tabOrg } from "@/web/lib/org-tab";
import { threadQuery } from "@/web/threads/queries";
import { withHead, withUpdate } from "@/web/threads/thread-rows";

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

// The text so far of each reply in progress, by message id, and whether the stream is lost and
// being reconnected while the server answers. Once it is back, the thread is read again.
export function useThreadEvents(threadId: string, ready: boolean) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [streaming, setStreaming] = useState<ReadonlyMap<string, Streaming>>(new Map());
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    setStreaming(new Map());
    setReconnecting(false);
    if (!ready || !online) return;
    const { queryKey } = threadQuery(threadId);
    const after = queryClient.getQueryData(queryKey)?.thread.lastEventSeq;
    // A stream cannot send headers, so it names the tab's org in its address.
    const org = tabOrg();
    const source = new EventSource(
      `/api/v1/threads/${threadId}/events?after=${after ?? 0}${org ? `&org=${org}` : ""}`,
    );
    let lost = false;
    let closed = false;
    source.addEventListener("error", () => {
      lost = true;
      // A server that does not answer takes the app offline, which the header says instead.
      void checkServer().then((answered) => {
        if (answered && lost && !closed) setReconnecting(true);
      });
    });
    source.addEventListener("open", () => {
      if (!lost) return;
      lost = false;
      setReconnecting(false);
      void queryClient.invalidateQueries({ queryKey });
    });
    source.addEventListener("rows", (message) => {
      const update = rowsUpdateSchema.safeParse(JSON.parse(message.data as string));
      if (!update.success) return;
      queryClient.setQueryData(queryKey, (detail) => detail && withUpdate(detail, update.data));
    });
    source.addEventListener("thread", (message) => {
      const head = threadHeadSchema.safeParse(JSON.parse(message.data as string));
      if (!head.success) return;
      queryClient.setQueryData(queryKey, (detail) => detail && withHead(detail, head.data));
    });
    source.addEventListener("access-ended", () => {
      source.close();
      setReconnecting(false);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: sharedThreadsQuery.queryKey });
    });
    source.addEventListener("message-delta", (message) => {
      const batch = deltaBatchSchema.safeParse(JSON.parse(message.data as string));
      if (batch.success) setStreaming((current) => withPieces(current, batch.data));
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [queryClient, threadId, ready, online]);

  return { streaming, reconnecting };
}

// Changes to a thread's history: writing a reply again, sending a message again changed,
// restoring from a row, forking a new thread or starting one from a summary, and asking side
// questions, whose answers arrive as they are written. What they change in the thread arrives with
// its live stream; a new thread opens once made, and a failure goes to a toast.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  type Aside,
  asideStreamItemSchema,
  type BranchAction,
  branchActionResultSchema,
} from "@/shared/threads/history.ts";
import { threadSchema } from "@/shared/threads/thread.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { traced } from "@/web/lib/tracing";
import { useToast } from "@/web/shell/toaster";
import { asidesQuery } from "@/web/threads/queries";

// Acts from a row; what comes back is the branch made current, or the calls to confirm going
// past.
export function useHistoryAction(threadId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: (action: BranchAction) =>
      traced(action.action, threadId, async () => {
        const res = await apiClient.v1.threads[":id"].history.$post({
          param: { id: threadId },
          json: action,
        });
        if (!res.ok) throw new Error(await errorOf(res));
        return branchActionResultSchema.parse(await res.json());
      }),
    onError: (failed) => toast(failed.message),
  });
}

// Opens the new thread and has its space's list read again.
function useOpenThread() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (thread: { id: string; spaceId: string }) => {
    await queryClient.invalidateQueries({ queryKey: ["spaces", thread.spaceId] });
    await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
  };
}

// Forks a new thread from a row of a branch, or with a side question about it.
export function useForkThread(threadId: string) {
  const toast = useToast();
  const open = useOpenThread();
  return useMutation({
    mutationFn: (input: { rowId: string; branchId?: string; asideId?: string }) =>
      traced("fork", threadId, async () => {
        const res = await apiClient.v1.threads[":id"].fork.$post({
          param: { id: threadId },
          json: input,
        });
        if (!res.ok) throw new Error(await errorOf(res));
        return threadSchema.parse(await res.json());
      }),
    onSuccess: open,
    onError: (failed) => toast(failed.message),
  });
}

// Starts a new thread from a summary of the current branch.
export function useSummaryThread(threadId: string) {
  const toast = useToast();
  const open = useOpenThread();
  return useMutation({
    mutationFn: (input: { rowId: string; branchId?: string }) =>
      traced("new thread from summary", threadId, async () => {
        const res = await apiClient.v1.threads[":id"]["summary-thread"].$post({
          param: { id: threadId },
          json: input,
        });
        if (!res.ok) throw new Error(await errorOf(res));
        return threadSchema.parse(await res.json());
      }),
    onSuccess: open,
    onError: (failed) => toast(failed.message),
  });
}

// The reader's side questions with the one asked or answered in as it now stands.
function useKeepAside(threadId: string) {
  const queryClient = useQueryClient();
  return (aside: Aside) =>
    queryClient.setQueryData(asidesQuery(threadId).queryKey, (current) => [
      ...(current ?? []).filter((each) => each.id !== aside.id),
      aside,
    ]);
}

// The JSON lines of a body, each as it arrives.
async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  let buffered = "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buffered.trim()) yield JSON.parse(buffered);
}

// What asking aside is asked about: a row of a branch, with the reader's side question about it to
// ask more in once there is one.
interface AsideAsk {
  rowId: string;
  text: string;
  asideId?: string;
  branchId?: string;
}

// Asks a side question about a row, or asks one more, keeping the answer as it is written until it
// is done or stopped; while it is, which row's side question is being answered.
export function useAskAside(threadId: string) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const keep = useKeepAside(threadId);
  const [answering, setAnswering] = useState<{ rowId: string; asideId?: string } | null>(null);
  const asking = useMutation({
    mutationFn: (input: AsideAsk) =>
      traced("ask aside", threadId, async () => {
        const res = input.asideId
          ? await apiClient.v1.threads[":id"].asides[":asideId"].messages.$post({
              param: { id: threadId, asideId: input.asideId },
              json: { text: input.text },
            })
          : await apiClient.v1.threads[":id"].asides.$post({
              param: { id: threadId },
              json: { rowId: input.rowId, branchId: input.branchId, text: input.text },
            });
        if (!res.ok) throw new Error(await errorOf(res));
        if (!res.body) throw new Error("The answer could not be read");
        let asked: Aside | null = null;
        let written = "";
        for await (const line of jsonLines(res.body)) {
          const item = asideStreamItemSchema.parse(line);
          if (item.type === "aside") {
            asked = item.aside;
            keep(asked);
            setAnswering({ rowId: input.rowId, asideId: asked.id });
            continue;
          }
          if (!asked) continue;
          written += item.text;
          keep({
            ...asked,
            turns: [
              ...asked.turns,
              { id: `${asked.id}:answering`, role: "answer", text: written, at: asked.createdAt },
            ],
          });
        }
      }),
    onMutate: (input) => setAnswering({ rowId: input.rowId }),
    onSettled: () => setAnswering(null),
    onError: (failed) => {
      toast(failed.message);
      void queryClient.invalidateQueries({ queryKey: asidesQuery(threadId).queryKey });
    },
  });
  const stopping = useMutation({
    mutationFn: async (asideId: string) => {
      const res = await apiClient.v1.threads[":id"].asides[":asideId"].stop.$post({
        param: { id: threadId, asideId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onError: (failed) => toast(failed.message),
  });
  return {
    ask: asking.mutateAsync,
    answering,
    stop() {
      if (answering?.asideId) stopping.mutate(answering.asideId);
    },
  };
}

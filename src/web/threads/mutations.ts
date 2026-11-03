// Changes to threads: starting one, posting to it and changing or withdrawing a waiting message,
// stopping and retrying its runs, deciding on and answering its tool calls, its model and effort,
// and renaming, moving to another space, and deleting it. What they change in the
// thread's rows arrives with its live stream; a failure that only an action of the moment can show
// goes to a toast.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { AskAnswers } from "@/shared/ask.ts";
import type { CommandInput } from "@/shared/threads/commands.ts";
import type { Delivery, ToolScope } from "@/shared/threads/events.ts";
import { type Effort, threadSchema } from "@/shared/threads/thread.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { useToast } from "@/web/shell/toaster";
import { spaceThreadsQuery, threadQuery } from "@/web/threads/queries";

// Makes a thread in the space with its first message, and opens it.
export function useCreateThread(spaceId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({
      text,
      model,
      effort,
    }: {
      text: string;
      model?: string | null;
      effort?: Effort | null;
    }) => {
      const res = await apiClient.v1.spaces[":id"].threads.$post({
        param: { id: spaceId },
        json: {
          text,
          ...(model && { model }),
          ...(effort && { effort }),
        },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return threadSchema.parse(await res.json());
    },
    onSuccess: async (thread) => {
      await queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
      await navigate({ to: "/t/$threadId", params: { threadId: thread.id }, replace: true });
    },
  });
}

export function usePostMessage(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      text,
      mode,
      command,
    }: {
      text: string;
      mode: Delivery;
      command?: CommandInput;
    }) => {
      const res = await apiClient.v1.threads[":id"].messages.$post({
        param: { id: threadId },
        json: { text, mode, ...(command && { command }) },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    // Read again too, for when the live stream is reconnecting.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey }),
  });
}

// Changes or withdraws a message still waiting its turn.
export function useWaitingMessage(threadId: string, messageId: string) {
  return useMutation({
    mutationFn: async (change: { text?: string; mode?: "steer" | "queue" } | null) => {
      const param = { id: threadId, messageId };
      const res = change
        ? await apiClient.v1.threads[":id"].messages[":messageId"].$patch({ param, json: change })
        : await apiClient.v1.threads[":id"].messages[":messageId"].$delete({ param });
      if (!res.ok) throw new Error(await errorOf(res));
    },
  });
}

export function useStopRun(threadId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.threads[":id"].stop.$post({ param: { id: threadId } });
      // A run that ended meanwhile has nothing to stop.
      if (!res.ok && (res.status as number) !== 409) throw new Error(await errorOf(res));
    },
    onError: (failed) => toast(failed.message),
  });
}

// Brings a retired subagent back; its thread and its space's list are read again.
export function useUnarchiveSubagent(threadId: string, spaceId: string | undefined) {
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.threads[":id"].unarchive.$post({ param: { id: threadId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
      if (spaceId) {
        void queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
      }
    },
    onError: (failed) => toast(failed.message),
  });
}

export function useRetryRun(threadId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiClient.v1.threads[":id"].retry.$post({
        param: { id: threadId },
        json: { runId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onError: (failed) => toast(failed.message),
  });
}

// Approves or denies a tool call; the decision arrives with the thread's rows.
export function useToolDecision(threadId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: async ({
      callId,
      allow,
      scope,
      subagentThreadId,
    }: {
      callId: string;
      allow: boolean;
      scope: ToolScope;
      // For a subagent's call decided from the thread that started it, the subagent's thread.
      subagentThreadId?: string;
    }) => {
      const res = await apiClient.v1.threads[":id"].tools[":callId"].decision.$post({
        param: { id: subagentThreadId ?? threadId, callId },
        json: { allow, scope },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onError: (failed) => toast(failed.message),
  });
}

// Answers the questions a call asks, or skips them; the answer arrives with the thread's rows.
export function useToolAnswer(threadId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: async ({
      callId,
      answers,
      subagentThreadId,
    }: {
      callId: string;
      answers: AskAnswers | null;
      // For a subagent's questions answered from the thread that started it, the subagent's thread.
      subagentThreadId?: string;
    }) => {
      const res = await apiClient.v1.threads[":id"].tools[":callId"].answer.$post({
        param: { id: subagentThreadId ?? threadId, callId },
        json: { answers },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onError: (failed) => toast(failed.message),
  });
}

// The thread's model or reasoning effort; whether the model it now names can reply is the
// server's to say, so the thread is read again.
export function useThreadModel(threadId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (json: { model: string | null } | { effort: Effort | null }) => {
      const res = await apiClient.v1.threads[":id"].$patch({ param: { id: threadId }, json });
      if (!res.ok) throw new Error(await errorOf(res));
      return threadSchema.parse(await res.json());
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(threadQuery(threadId).queryKey, (current) =>
        current ? { ...current, thread: updated } : current,
      );
      await queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
    },
    onError: (failed) => toast(failed.message),
  });
}

// Moves a thread to another space.
export function useMoveThreadToSpace(thread: { id: string; spaceId: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spaceId: string) => {
      const res = await apiClient.v1.threads[":id"].move.$post({
        param: { id: thread.id },
        json: { spaceId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: (_, spaceId) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: threadQuery(thread.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["spaces", thread.spaceId] }),
        queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] }),
      ]),
  });
}

export function useRenameThread(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const res = await apiClient.v1.threads[":id"].$patch({ param: { id }, json: { title } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: async (_, { id }) => {
      await queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] });
      await queryClient.invalidateQueries({ queryKey: threadQuery(id).queryKey });
    },
  });
}

// Deletes a thread; `leave` first takes the person away from it when it is open.
export function useDeleteThread(spaceId: string, leave: (threadId: string) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.v1.threads[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: async (_, id) => {
      await leave(id);
      queryClient.removeQueries({ queryKey: threadQuery(id).queryKey });
      await queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] });
    },
  });
}

// A thread: its transcript as it happens, kept scrolled to the newest, what the agent is doing and
// the messages waiting for it, a composer to post, steer, queue, interrupt and stop, and the
// thread's model.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { anyThreadEventSchema, type Delivery, threadSchema } from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { ModelPicker } from "@/web/components/model-picker";
import { Composer, PendingTray, RunStatus } from "@/web/components/thread-composer";
import { AgentStarting, TranscriptItem } from "@/web/components/thread-events";
import { FieldError } from "@/web/components/ui/field";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import {
  meQuery,
  modelsQuery,
  spaceThreadsQuery,
  spacesQuery,
  threadQuery,
} from "@/web/lib/queries";
import { mergeEvents, useThreadEvents } from "@/web/lib/thread-events";

const threadRoute = getRouteApi("/_app/t/$threadId");

export function ThreadPage() {
  const { threadId } = threadRoute.useParams();
  const queryClient = useQueryClient();
  const detail = useQuery(threadQuery(threadId));
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const me = useQuery(meQuery);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // The run someone here asked to stop.
  const [stopped, setStopped] = useState<string>();
  const thread = detail.data?.thread;
  const events = detail.data?.events;
  const space = spaces.data?.find((s) => s.id === thread?.spaceId);

  useEffect(() => {
    if (thread) rememberSpace(thread.spaceId);
  }, [thread]);

  const spaceId = thread?.spaceId;
  const refreshList = useCallback(() => {
    if (spaceId)
      void queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
  }, [queryClient, spaceId]);
  const streaming = useThreadEvents(threadId, detail.isSuccess, refreshList);
  const transcript = useMemo(
    () =>
      transcriptOf(
        events ?? [],
        new Map([...streaming].map(([messageId, { text }]) => [messageId, text])),
      ),
    [events, streaming],
  );

  const run = transcript.run;

  // Throws when the message is not posted, so the composer keeps the text.
  async function send(text: string, mode: Delivery) {
    if (!text.trim()) return;
    setSending(true);
    const res = await apiClient.v1.threads[":id"].messages.$post({
      param: { id: threadId },
      json: { text, mode },
    });
    setSending(false);
    if (!res.ok) {
      const failed = await errorOf(res);
      setError(failed);
      throw new Error(failed);
    }
    setError(undefined);
    mergeEvents(queryClient, threadId, [anyThreadEventSchema.parse(await res.json())]);
    await queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
    refreshList();
  }

  async function stop() {
    if (!run) return;
    setStopped(run.id);
    const res = await apiClient.v1.threads[":id"].stop.$post({ param: { id: threadId } });
    // A run that ended meanwhile has nothing to stop.
    if (!res.ok && (res.status as number) !== 409) setError(await errorOf(res));
  }

  async function chooseModel(model: string) {
    const res = await apiClient.v1.threads[":id"].$patch({
      param: { id: threadId },
      json: { model },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const updated = threadSchema.parse(await res.json());
    queryClient.setQueryData(threadQuery(threadId).queryKey, (current) =>
      current ? { ...current, thread: updated } : current,
    );
  }

  if (detail.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Not found" }]} />
        <p className="p-4 text-muted-foreground">This thread does not exist or is not yours.</p>
      </>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <PageHeader
        crumbs={[
          ...(space
            ? [
                {
                  label: space.name,
                  link: { to: "/s/$spaceId" as const, params: { spaceId: space.id } },
                },
              ]
            : []),
          { label: thread?.title ?? "" },
        ]}
      />
      <Conversation aria-label="Events" className="min-h-0">
        <ConversationContent className={cn(pageWidth, "gap-6")}>
          {detail.data && transcript.rows.length === 0 ? (
            <ConversationEmptyState description="Write the first message below." />
          ) : (
            transcript.rows.map((row) => <TranscriptItem key={row.id} row={row} />)
          )}
          {run &&
            !transcript.rows.some((row) => row.kind === "agent" && row.status === "streaming") && (
              <AgentStarting at={run.createdAt} />
            )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className={cn(pageWidth, "p-4 pt-0")}>
        <div className="flex flex-col gap-2">
          <RunStatus stopping={!!run && run.id === stopped} />
          <PendingTray threadId={threadId} pending={transcript.pending} me={me.data?.user.id} />
          <Composer
            running={!!run}
            readOnly={space?.role === "viewer"}
            sending={sending}
            stopping={!!run && run.id === stopped}
            onSend={send}
            onStop={() => void stop()}
            tools={
              <ModelPicker
                models={models.data?.models ?? []}
                value={thread?.model ?? null}
                onChange={(ref) => void chooseModel(ref)}
                placeholder="Model"
                className="w-56"
              />
            }
          />
        </div>
        <FieldError className="mt-2">{error}</FieldError>
      </div>
    </div>
  );
}

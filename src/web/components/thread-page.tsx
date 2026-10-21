// A thread: its transcript as it happens, kept scrolled to the newest, what the agent is doing and
// the messages waiting for it, a composer to post, steer, queue, interrupt and stop, trying the
// last reply again when it failed or was stopped, and the thread's model with, for a model that can
// think, its reasoning effort. Its space's owners and messagers can share it from its header. A
// guest of the thread sees its space's name alone, and cannot change its model; once their access
// ends, they are told so. When the server cannot be reached, the thread as last read stays in view
// while it reconnects.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  anyThreadEventSchema,
  type Delivery,
  type Effort,
  effortSchema,
  threadSchema,
} from "@/shared/threads.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/web/components/ai-elements/prompt-input";
import { ModelPicker } from "@/web/components/model-picker";
import { ShareDialog } from "@/web/components/share-dialog";
import { Composer, PendingTray, RunStatus } from "@/web/components/thread-composer";
import { AgentStarting, TranscriptItem } from "@/web/components/thread-events";
import { Button } from "@/web/components/ui/button";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import {
  meQuery,
  modelsQuery,
  spaceThreadsQuery,
  spacesQuery,
  ThreadAccessEnded,
  ThreadNotFound,
  threadQuery,
} from "@/web/lib/queries";
import { mergeEvents, useThreadEvents } from "@/web/lib/thread-events";

const threadRoute = getRouteApi("/_app/t/$threadId");

const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

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
  const [picking, setPicking] = useState(false);
  const thread = detail.data?.thread;
  const events = detail.data?.events;
  const access = detail.data?.access;
  const guest = access?.via === "guest";
  const role = access?.via === "space" ? access.role : undefined;
  const space = spaces.data?.find((s) => s.id === thread?.spaceId);

  // A guest's thread is not in one of their own spaces.
  useEffect(() => {
    if (thread && !guest) rememberSpace(thread.spaceId);
  }, [thread, guest]);

  const spaceId = thread?.spaceId;
  const refreshList = useCallback(() => {
    if (spaceId)
      void queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
  }, [queryClient, spaceId]);
  const notFound = detail.error instanceof ThreadNotFound;
  const ended = detail.error instanceof ThreadAccessEnded;
  const { streaming, reconnecting } = useThreadEvents(
    threadId,
    !!detail.data && !notFound && !ended,
    refreshList,
  );
  // The thread cannot be read or followed right now; what is shown is what was last read.
  const offline = !notFound && !ended && (detail.failureCount > 0 || reconnecting);
  const transcript = useMemo(
    () =>
      transcriptOf(
        events ?? [],
        new Map(
          [...streaming].map(([messageId, { text, reasoning }]) => [
            messageId,
            { text, reasoning },
          ]),
        ),
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

  async function retry(runId: string) {
    const res = await apiClient.v1.threads[":id"].retry.$post({
      param: { id: threadId },
      json: { runId },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setError(undefined);
    mergeEvents(queryClient, threadId, [anyThreadEventSchema.parse(await res.json())]);
  }

  // Whether the thread's model can think, so its effort can be chosen.
  const thinks = !!models.data?.models.find((model) => model.ref === thread?.model)?.reasoning;

  // The last row, when it ends a run that failed or was stopped and nothing has run since.
  const last = transcript.rows.at(-1);
  const canRetry = role !== "viewer" && !run && transcript.pending.length === 0;
  const retryable =
    canRetry && (last?.kind === "failure" || last?.kind === "stop") ? last : undefined;

  // Changes the thread's model or reasoning effort.
  async function change(json: { model: string } | { effort: Effort }) {
    const res = await apiClient.v1.threads[":id"].$patch({ param: { id: threadId }, json });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const updated = threadSchema.parse(await res.json());
    queryClient.setQueryData(threadQuery(threadId).queryKey, (current) =>
      current ? { ...current, thread: updated } : current,
    );
  }

  if (notFound) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Not found" }]} />
        <p className="p-4 text-muted-foreground">This thread does not exist or is not yours.</p>
      </>
    );
  }

  if (ended) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Access ended" }]} />
        <div className={cn(pageWidth, "flex flex-col items-start gap-3 p-4")}>
          <p className="text-muted-foreground">
            Your access to this thread has ended. Ask whoever shared it for a new invite link.
          </p>
          <Button size="sm" variant="outline" render={<Link to="/" />} nativeButton={false}>
            Go home
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumbs={[
          ...(access?.via === "guest"
            ? [{ label: access.spaceName }]
            : space
              ? [
                  {
                    label: space.name,
                    link: { to: "/s/$spaceId" as const, params: { spaceId: space.id } },
                  },
                ]
              : []),
          { label: thread?.title ?? "" },
        ]}
      >
        {(role === "owner" || role === "messager") && <ShareDialog threadId={threadId} />}
      </PageHeader>
      <Conversation aria-label="Events" className="min-h-0">
        <ConversationContent className={cn(pageWidth, "gap-4")}>
          {detail.data && transcript.rows.length === 0 ? (
            <ConversationEmptyState description="Write the first message below." />
          ) : (
            transcript.rows.map((row) => (
              <TranscriptItem
                key={row.id}
                row={row}
                actions={{
                  ...(row === retryable && { retry: () => void retry(retryable.runId) }),
                  ...(!guest && { pickModel: () => setPicking(true) }),
                }}
              />
            ))
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
          {offline && (
            <div
              role="status"
              aria-label="Connection"
              className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
            >
              <Spinner className="size-3.5" aria-hidden />
              <span>Reconnecting…</span>
            </div>
          )}
          <RunStatus stopping={!!run && run.id === stopped} />
          <PendingTray threadId={threadId} pending={transcript.pending} me={me.data?.user.id} />
          <Composer
            running={!!run}
            readOnly={role === "viewer"}
            sending={sending}
            stopping={!!run && run.id === stopped}
            onSend={send}
            onStop={() => void stop()}
            tools={
              // A guest uses the model the thread's space chose.
              !guest && (
                <>
                  <ModelPicker
                    models={models.data?.models ?? []}
                    value={thread?.model ?? null}
                    onChange={(ref) => void change({ model: ref })}
                    open={picking}
                    onOpenChange={setPicking}
                    placeholder="Model"
                    variant="compact"
                  />
                  {thinks && (
                    <PromptInputSelect
                      value={thread?.effort ?? "medium"}
                      onValueChange={(value) => {
                        const effort = effortSchema.safeParse(value);
                        if (effort.success) void change({ effort: effort.data });
                      }}
                    >
                      <PromptInputSelectTrigger size="sm" aria-label="Reasoning effort">
                        <PromptInputSelectValue>
                          {(value: Effort) => EFFORT_LABELS[value]}
                        </PromptInputSelectValue>
                      </PromptInputSelectTrigger>
                      <PromptInputSelectContent alignItemWithTrigger={false} side="top">
                        {effortSchema.options.map((effort) => (
                          <PromptInputSelectItem key={effort} value={effort}>
                            {EFFORT_LABELS[effort]}
                          </PromptInputSelectItem>
                        ))}
                      </PromptInputSelectContent>
                    </PromptInputSelect>
                  )}
                </>
              )
            }
          />
        </div>
        <FieldError className="mt-2">{error}</FieldError>
      </div>
    </div>
  );
}

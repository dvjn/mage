// A thread: its transcript as it happens, kept scrolled to the newest, what the agent is doing and
// the messages waiting for it, a composer to post, steer, queue, interrupt and stop, trying the
// last reply again when it failed or was stopped, and the thread's model with, for a model that can
// think, its reasoning effort, or the defaults it follows, named as such, with a way back to them.
// Its space's owners and messagers can share it from its header. Those who may run a tool decide on
// the agent's calls of it that wait, and while the agent waits the composer says so. A
// guest of the thread sees its space's name alone, and cannot change its model; once their access
// ends, they are told so. When the server cannot be reached, the thread as last read stays in view
// while it reconnects. Reading it marks it seen.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  anyThreadEventSchema,
  type Delivery,
  type Effort,
  threadSchema,
  type ToolScope,
} from "@/shared/threads.ts";
import { agentTurnOf, transcriptOf } from "@/shared/transcript.ts";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { folderCrumb } from "@/web/components/folder-choice";
import { AuthCard, AuthFrame } from "@/web/components/auth-frame";
import { GoHome, NotFound } from "@/web/components/page-states";
import { ShareDialog } from "@/web/components/share-dialog";
import { Composer, PendingTray, RunStatus } from "@/web/components/thread-composer";
import { ThreadPickers } from "@/web/components/thread-pickers";
import { AgentStarting, TranscriptItem } from "@/web/components/thread-events";
import { useToast } from "@/web/components/toaster";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import {
  meQuery,
  modelsQuery,
  spaceFoldersQuery,
  spaceThreadsQuery,
  spacesQuery,
  ThreadAccessEnded,
  ThreadNotFound,
  threadQuery,
} from "@/web/lib/queries";
import { useMarkRead } from "@/web/lib/inbox";
import { useOnline } from "@/web/lib/online";
import { mergeEvents, useThreadEvents } from "@/web/lib/thread-events";

const threadRoute = getRouteApi("/_app/t/$threadId");

export function ThreadPage() {
  const { threadId } = threadRoute.useParams();
  const queryClient = useQueryClient();
  const detail = useQuery(threadQuery(threadId));
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const me = useQuery(meQuery);
  const online = useOnline();
  // A message that could not be posted, said above the composer; other failures are toasts.
  const [error, setError] = useState<string>();
  const toast = useToast();
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
  const folders = useQuery({
    ...spaceFoldersQuery(thread?.spaceId ?? ""),
    enabled: !!thread && !guest,
  });

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
  );
  useMarkRead(threadId, notFound || ended ? undefined : thread?.lastEventSeq);
  // The thread cannot be read or followed right now; what is shown is what was last read. Offline,
  // the sidebar says so instead.
  const offline = online && !notFound && !ended && (detail.failureCount > 0 || reconnecting);
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
    if (!res.ok && (res.status as number) !== 409) toast(await errorOf(res));
  }

  async function retry(runId: string) {
    const res = await apiClient.v1.threads[":id"].retry.$post({
      param: { id: threadId },
      json: { runId },
    });
    if (!res.ok) {
      toast(await errorOf(res));
      return;
    }
    mergeEvents(queryClient, threadId, [anyThreadEventSchema.parse(await res.json())]);
  }

  // Approves or denies a tool call; the decision arrives with the thread's events.
  async function decide(callId: string, allow: boolean, scope: ToolScope) {
    const res = await apiClient.v1.threads[":id"].tools[":callId"].decision.$post({
      param: { id: threadId, callId },
      json: { allow, scope },
    });
    if (!res.ok) toast(await errorOf(res));
  }

  // The last row, when it ends a run that failed or was stopped and nothing has run since.
  const last = transcript.rows.at(-1);
  const canRetry = role !== "viewer" && !run && transcript.pending.length === 0;
  const retryable =
    canRetry && (last?.kind === "failure" || last?.kind === "stop") ? last : undefined;

  // Changes the thread's model or reasoning effort.
  async function change(json: { model: string | null } | { effort: Effort | null }) {
    const res = await apiClient.v1.threads[":id"].$patch({ param: { id: threadId }, json });
    if (!res.ok) {
      toast(await errorOf(res));
      return;
    }
    const updated = threadSchema.parse(await res.json());
    queryClient.setQueryData(threadQuery(threadId).queryKey, (current) =>
      current ? { ...current, thread: updated } : current,
    );
    // Whether the model it now names can reply is the server's to say.
    await queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
  }

  // Moves the thread to a folder, or out of one, as the sidebar's "Move to" does.
  async function move(folderId: string | null) {
    if (!thread || thread.folderId === folderId) return;
    const res = await apiClient.v1.threads[":id"].$patch({
      param: { id: thread.id },
      json: { folderId },
    });
    if (!res.ok) {
      toast(await errorOf(res));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: threadQuery(thread.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: ["spaces", thread.spaceId] }),
    ]);
  }

  if (notFound) return <NotFound what="thread" id={threadId} />;

  if (ended) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Access ended" }]} />
        <AuthFrame inApp>
          <AuthCard
            title="Your access to this thread has ended"
            description="Ask whoever shared it for a new invite link."
            actions={<GoHome />}
          />
        </AuthFrame>
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
          ...(thread && !guest
            ? [
                folderCrumb({
                  spaceId: thread.spaceId,
                  folders: folders.data ?? [],
                  value: thread.folderId,
                  canMove: role === "owner" || role === "messager",
                  onChange: (folderId) => void move(folderId),
                }),
              ].filter((crumb) => crumb !== null)
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
            transcript.rows.map((row, index) => (
              <TranscriptItem
                key={row.id}
                row={row}
                turn={agentTurnOf(transcript.rows, index)}
                tools={detail.data?.tools}
                actions={{
                  ...(row === retryable && { retry: () => void retry(retryable.runId) }),
                  ...(!guest && { pickModel: () => setPicking(true) }),
                  ...(row.kind === "tool" &&
                    detail.data?.levels[row.toolId] === "run" && {
                      decide: (allow: boolean, scope: ToolScope) => decide(row.id, allow, scope),
                    }),
                }}
              />
            ))
          )}
          {run &&
            !run.waitingOn &&
            !transcript.rows.some((row) => row.kind === "agent" && row.status === "streaming") && (
              <AgentStarting
                at={run.createdAt}
                continued={agentTurnOf(transcript.rows, transcript.rows.length - 1) !== null}
              />
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
          <FieldError>{error}</FieldError>
          <Composer
            running={!!run}
            waiting={!!run?.waitingOn}
            readOnly={role === "viewer"}
            sending={sending}
            stopping={!!run && run.id === stopped}
            onSend={send}
            onStop={() => void stop()}
            tools={
              // A guest uses the model the thread's space chose.
              !guest && (
                <ThreadPickers
                  models={models.data?.models ?? []}
                  loading={models.isPending}
                  model={thread?.model ?? null}
                  effort={thread?.effort ?? null}
                  defaults={detail.data?.defaults}
                  used={
                    detail.data?.model?.used && {
                      ...detail.data.model.used,
                      effort: detail.data.model.effort,
                    }
                  }
                  onModel={(ref) => void change({ model: ref })}
                  onEffort={(effort) => void change({ effort })}
                  open={picking}
                  onOpenChange={setPicking}
                />
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

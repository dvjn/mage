// A thread: its transcript as it happens, opened where the reader stopped with a line above what
// is new to them, or else at the newest, and kept scrolled to the newest once they reach it, what
// the agent is doing and the messages waiting for it, a composer to post, steer, queue, interrupt
// and stop, trying the last reply again when it failed or was stopped, and the thread's model with,
// for a model that can think, its reasoning effort, or the defaults it follows, named as such, with
// a way back to them. Its space's owners and messagers can share it from its header. Those a
// tool's policy lets approve decide on the agent's calls of it that wait, those it lets use or
// approve it answer the agent's questions, and while the agent waits the composer says on what; a
// call allowed while signing in with its server is applied on coming back here. A guest of the
// thread sees its space's name alone, and cannot change its model; once their access ends, they are
// told so. When the server cannot be reached, the thread as last read stays in view while it
// reconnects. Reading it marks it seen.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { cn } from "cn";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ASK_TOOL, type AskAnswers } from "@/shared/ask.ts";
import type { Delivery, ToolScope } from "@/shared/threads/events.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { agentTurnOf, transcriptOf } from "@/shared/transcript.ts";
import { AuthCard, AuthFrame } from "@/web/auth/auth-frame";
import { meQuery } from "@/web/auth/queries";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { folderCrumb } from "@/web/folders/folder-choice";
import { spaceFoldersQuery } from "@/web/folders/queries";
import { ShareDialog } from "@/web/guests/share-dialog";
import { ArchivedThreadActions } from "@/web/threads/archived-thread-actions";
import { useOnline } from "@/web/lib/online";
import { modelsQuery } from "@/web/models/queries";
import { ThreadPickers } from "@/web/models/thread-pickers";
import { ReplyActions } from "@/web/replies/reply-actions";
import { GoHome, NotFound } from "@/web/shell/not-found";
import { PageHeader, pageWidth } from "@/web/shell/page-header";
import { rememberSpace } from "@/web/spaces/last-space";
import { spacesQuery } from "@/web/spaces/queries";
import { useThreadEvents } from "@/web/threads/event-stream";
import { useMarkRead } from "@/web/threads/inbox";
import {
  useMoveThread,
  usePostMessage,
  useRetryRun,
  useStopRun,
  useThreadModel,
  useToolAnswer,
  useToolDecision,
} from "@/web/threads/mutations";
import {
  spaceThreadsQuery,
  ThreadAccessEnded,
  ThreadNotFound,
  threadQuery,
} from "@/web/threads/queries";
import { Composer, PendingTray, RunStatus } from "@/web/threads/thread-composer";
import { AgentStarting } from "@/web/threads/transcript/agent-starting";
import { TranscriptItem } from "@/web/threads/transcript/transcript-item";

const threadRoute = getRouteApi("/_app/t/$threadId");

export function ThreadPage() {
  const { threadId } = threadRoute.useParams();
  const queryClient = useQueryClient();
  const detail = useQuery(threadQuery(threadId));
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const me = useQuery(meQuery);
  const online = useOnline();
  // The run someone here asked to stop.
  const [stopped, setStopped] = useState<string>();
  const [picking, setPicking] = useState(false);
  const thread = detail.data?.thread;
  const events = detail.data?.events;
  const access = detail.data?.access;
  const guest = access?.via === "guest";
  const role = access?.via === "space" ? access.role : undefined;
  // Its space is archived: it can be read, moved out and deleted, nothing more.
  const archived = !!detail.data?.archived;
  const writer = !archived && (role === "owner" || role === "messager");
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

  // The thread as first read from the server on this visit, or as cached when it cannot answer:
  // its events, and the first row the reader had not seen by then that is not their own nor a
  // reply still being written. It opens there, or at the end when there is none, and a line marks
  // that row until they post; while the agent is at work it is held there, not following the
  // reply, until the reader reaches the end. Until more events arrive, what renders late, such as
  // an image, lands at the end at once; what arrives after scrolls in. The thread is marked seen
  // once it is read.
  const [visit, setVisit] = useState<{
    threadId: string;
    events: unknown;
    openedAt?: string;
    newFrom?: string;
    hold: boolean;
  }>();
  if (
    detail.data &&
    (!detail.isFetching || detail.failureCount > 0) &&
    visit?.threadId !== threadId
  ) {
    const seen = detail.data.seenSeq;
    const reader = me.data?.user.id;
    const newFrom = transcript.rows.find(
      (row) =>
        row.seq > seen &&
        !(row.kind === "human" && row.author.userId === reader) &&
        !(row.kind === "agent" && row.status === "streaming"),
    )?.id;
    setVisit({
      threadId,
      events: detail.data.events,
      openedAt: newFrom,
      newFrom,
      hold: !!transcript.run,
    });
  }
  const opened = visit?.threadId === threadId ? visit : undefined;
  const arriving = !!opened && opened.events !== events;
  const stoppedAt = useRef<HTMLDivElement>(null);
  useMarkRead(threadId, notFound || ended || !opened ? undefined : thread?.lastEventSeq);

  const run = transcript.run;
  const posting = usePostMessage(threadId);
  const stopping = useStopRun(threadId);
  const retrying = useRetryRun(threadId);
  const decision = useToolDecision(threadId);
  const answering = useToolAnswer(threadId);
  const modelChange = useThreadModel(threadId);
  const moving = useMoveThread();

  // Throws when the message is not posted, so the composer keeps the text.
  async function send(text: string, mode: Delivery) {
    if (!text.trim()) return;
    await posting.mutateAsync({ text, mode });
    setVisit((shown) => shown && { ...shown, newFrom: undefined });
    refreshList();
  }

  function stop() {
    if (!run) return;
    setStopped(run.id);
    stopping.mutate();
  }

  function retry(runId: string) {
    retrying.mutate(runId);
  }

  // Approves or denies a tool call; the decision arrives with the thread's events.
  function decide(callId: string, allow: boolean, scope: ToolScope) {
    return decision.mutateAsync({ callId, allow, scope }).catch(() => {});
  }

  // Answers the questions a call asks, or skips them; the answer arrives with the thread's events.
  function answer(callId: string, answers: AskAnswers | null) {
    return answering.mutateAsync({ callId, answers }).catch(() => {});
  }

  // A call the reader allowed as they signed in with its server, which the page applies once the
  // browser is back here.
  const { allow, scope } = threadRoute.useSearch();
  const navigate = threadRoute.useNavigate();
  const allowing = useRef<string>(undefined);
  useEffect(() => {
    if (!allow || !detail.data || allowing.current === allow) return;
    allowing.current = allow;
    void navigate({ search: {}, replace: true });
    void decide(allow, true, scope ?? "once");
  });

  // What the run waits for: an answer to the agent's questions, or a decision on a call.
  const waitingOn = run?.waitingOn
    ? transcript.rows.find((row) => row.kind === "tool" && row.id === run.waitingOn)
    : undefined;
  const waiting = waitingOn
    ? waitingOn.kind === "tool" && waitingOn.toolId === ASK_TOOL
      ? "answer"
      : "decision"
    : null;

  // A click in a reply's layout posts as the person who clicked, for those who may post.
  const replyActions =
    access && role !== "viewer"
      ? { send: (text: string) => void send(text, "queue").catch(() => {}) }
      : {};

  // The last row, when it ends a run that failed or was stopped and nothing has run since.
  const last = transcript.rows.at(-1);
  const canRetry = role !== "viewer" && !archived && !run && transcript.pending.length === 0;
  const retryable =
    canRetry && (last?.kind === "failure" || last?.kind === "stop") ? last : undefined;

  // Changes the thread's model or reasoning effort.
  function change(json: { model: string | null } | { effort: Effort | null }) {
    modelChange.mutate(json);
  }

  // Moves the thread to a folder, or out of one, as the sidebar's "Move to" does.
  function move(folderId: string | null) {
    if (!thread || thread.folderId === folderId) return;
    moving.mutate({ thread, folderId });
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
                  canMove: writer,
                  onChange: (folderId) => move(folderId),
                }),
              ].filter((crumb) => crumb !== null)
            : []),
          { label: thread?.title ?? "" },
        ]}
      >
        {writer && <ShareDialog threadId={threadId} />}
        {archived && !guest && thread && <ArchivedThreadActions thread={thread} />}
      </PageHeader>
      <ReplyActions.Provider value={replyActions}>
        {detail.data ? (
          // The cached thread shows at once; it opens again where the reader stopped once read.
          <Conversation
            key={`${threadId}:${opened?.openedAt ?? ""}`}
            openAt={stoppedAt}
            holdOpenAt={opened?.hold}
            aria-label="Events"
            className="min-h-0"
            resize={arriving ? "smooth" : "instant"}
          >
            <ConversationContent className={cn(pageWidth, "gap-4")}>
              {transcript.rows.length === 0 ? (
                <ConversationEmptyState description="Write the first message below." />
              ) : (
                transcript.rows.map((savedRow, index) => {
                  const policy =
                    savedRow.kind === "tool" && savedRow.state === "pending"
                      ? detail.data?.pendingTools?.[savedRow.id]
                      : undefined;
                  const row =
                    policy && savedRow.kind === "tool"
                      ? { ...savedRow, risk: policy.risk }
                      : savedRow;
                  return (
                    <Fragment key={row.id}>
                      {row.id === opened?.newFrom && (
                        // Where the reader stopped; takes no room in the rows' gap.
                        <div ref={stoppedAt} aria-hidden className="-my-2 h-0 shrink-0" />
                      )}
                      <TranscriptItem
                        row={row}
                        turn={agentTurnOf(transcript.rows, index)}
                        tools={detail.data?.tools}
                        connection={policy?.connection}
                        actions={{
                          ...(row === retryable && { retry: () => retry(retryable.runId) }),
                          ...(!guest && !archived && { pickModel: () => setPicking(true) }),
                          ...(row.kind === "tool" &&
                            policy?.canDecide === true &&
                            (row.toolId === ASK_TOOL
                              ? { answer: (answers: AskAnswers | null) => answer(row.id, answers) }
                              : {
                                  decide: (allow: boolean, scope: ToolScope) =>
                                    decide(row.id, allow, scope),
                                })),
                        }}
                      />
                    </Fragment>
                  );
                })
              )}
              {run &&
                !run.waitingOn &&
                !transcript.rows.some(
                  (row) => row.kind === "agent" && row.status === "streaming",
                ) && (
                  <AgentStarting
                    at={run.createdAt}
                    continued={agentTurnOf(transcript.rows, transcript.rows.length - 1) !== null}
                  />
                )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        ) : (
          <div className="min-h-0 flex-1" />
        )}
      </ReplyActions.Provider>
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
          <FieldError>{posting.error?.message}</FieldError>
          <Composer
            running={!!run}
            waiting={waiting}
            readOnly={role === "viewer" || archived}
            notice={archived ? "This space is archived" : undefined}
            sending={posting.isPending}
            stopping={!!run && run.id === stopped}
            onSend={send}
            onStop={stop}
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
                  onModel={(ref) => change({ model: ref })}
                  onEffort={(effort) => change({ effort })}
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

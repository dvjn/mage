// A thread: its transcript as it happens, opened where the reader stopped with a line above what
// is new to them, or else at the newest, and kept scrolled to the newest once they reach it, with
// earlier rows read as the reader scrolls up to them; what the agent is doing and the messages
// waiting for it, a composer to post, steer, queue, interrupt and stop, trying the last reply again
// when it failed or was stopped, and the thread's model with, for a model that can think, its
// reasoning effort, or the defaults it follows, named as such, with a way back to them. Those who
// may share it do so from its header. What the reader may do in it, and with each of its rows, is
// the server's to say: decide on the agent's calls that wait, answer the agent's questions, retry;
// while the agent waits the composer says on what; a call allowed while signing in with its server
// is applied on coming back here. A guest of the thread sees its space's name alone, and cannot
// change its model; once their access ends, they are told so. When the server cannot be reached,
// the thread as last read stays in view while it reconnects. Reading it marks it seen. A subagent's
// thread sits under the thread that started it, and once retired is read-only, marked archived
// with a way to bring it back for those the server lets. A subagent's call that waits on
// someone shows in the thread that started it too, to be decided or answered from there. A link to
// one of its rows opens the thread there, reading back to it, with the row opened and lit.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { FileTextIcon, HistoryIcon, SplitIcon, Undo2Icon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AskAnswers } from "@/shared/ask.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { BTW, type CommandInput } from "@/shared/threads/commands.ts";
import type { Aside, BranchAction } from "@/shared/threads/history.ts";
import type { Delivery, ToolScope } from "@/shared/threads/events.ts";
import type { ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { AuthCard, AuthFrame } from "@/web/auth/auth-frame";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { meQuery } from "@/web/auth/queries";
import {
  Conversation,
  ConversationContent,
  ConversationEarlier,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
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
  usePostMessage,
  useRetryRun,
  useStopRun,
  useThreadModel,
  useToolAnswer,
  useToolDecision,
  useUnarchiveSubagent,
} from "@/web/threads/mutations";
import {
  asidesQuery,
  branchOfRow,
  earlierRows,
  spaceThreadsQuery,
  ThreadAccessEnded,
  threadBranchQuery,
  threadCommandsQuery,
  ThreadNotFound,
  threadQuery,
} from "@/web/threads/queries";
import {
  useAskAside,
  useForkThread,
  useHistoryAction,
  useSummaryThread,
} from "@/web/threads/history-mutations";
import { type AsideOpen, type Asides, AsidesContext } from "@/web/threads/transcript/aside-thread";
import { type RowHistory, RowHistoryContext } from "@/web/threads/transcript/row-history";
import { Composer, PendingTray, RunStatus } from "@/web/threads/thread-composer";
import { withEarlier } from "@/web/threads/thread-rows";
import { AgentStarting } from "@/web/threads/transcript/agent-starting";
import { type EntryGap, transcriptEntries } from "@/web/threads/transcript/entries";
import { ToolCall } from "@/web/threads/transcript/tool-call";
import { RelayMessages } from "@/web/threads/transcript/relay-message";
import { SubagentNotice } from "@/web/threads/transcript/subagent-notice";
import { ToolGroup } from "@/web/threads/transcript/tool-group";
import { type ThreadAgent, ThreadAgentContext } from "@/web/threads/transcript/agent";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import {
  lineKey,
  relayRunKey,
  rowElementId,
  RowFocusContext,
} from "@/web/threads/transcript/row-focus";
import { TranscriptItem } from "@/web/threads/transcript/transcript-item";

const threadRoute = getRouteApi("/_app/t/$threadId");

// The rows sit a turn apart; an entry that continues the agent's turn draws up close to the line
// before it, or near where text or a card meets the rest of the turn.
const ENTRY_GAPS: Record<EntryGap, string | undefined> = {
  apart: undefined,
  close: "-mt-3",
  near: "-mt-2",
};

// How long the row a link led to stays lit.
const LIT_MS = 3000;

export function ThreadPage() {
  const { threadId } = threadRoute.useParams();
  const queryClient = useQueryClient();
  const detail = useQuery(threadQuery(threadId));
  // A branch other than the current one, read-only, when the page is asked to show one.
  const { branch: asked } = threadRoute.useSearch();
  const currentBranch = detail.data?.branch.id;
  const viewing = asked && currentBranch && asked !== currentBranch ? asked : undefined;
  const older = useQuery({
    ...threadBranchQuery(threadId, viewing ?? ""),
    enabled: !!viewing,
  });
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const me = useQuery(meQuery);
  const online = useOnline();
  // The run someone here asked to stop.
  const [stopped, setStopped] = useState<string>();
  const [picking, setPicking] = useState(false);
  const thread = detail.data?.thread;
  // The rows shown: the current branch's, kept live, or the older branch's as read.
  const shown = viewing ? older.data : detail.data;
  const saved = shown?.rows;
  const access = detail.data?.access;
  const guest = access?.via === "guest";
  const can = detail.data?.can;
  // Its space is archived: it can be read, moved out and deleted, nothing more.
  const archived = !!detail.data?.archived;
  const space = spaces.data?.find((s) => s.id === thread?.spaceId);
  const commands = useQuery({ ...threadCommandsQuery(threadId), enabled: !!can?.post });

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
  // The rows with the text so far of each reply still being written.
  const rows = useMemo(
    () =>
      (saved ?? []).map((row): ShownRow => {
        const pieces = row.kind === "agent" && row.status === "streaming" && streaming.get(row.id);
        return pieces ? { ...row, text: pieces.text, reasoning: pieces.reasoning } : row;
      }),
    [saved, streaming],
  );

  const entries = useMemo(() => transcriptEntries(rows), [rows]);
  // The calls of the runs the reader opened, and the agents' messages and runs of them; a run stays
  // open while any of its rows is here, as it grows and as earlier rows join it.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRows = useCallback((ids: string[], open: boolean) => {
    setOpenRows((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // The thread as first read from the server on this visit, or as cached when it cannot answer:
  // its rows, and the first row the reader had not seen by then that is not their own nor a reply
  // still being written. It opens there, or at the end when there is none, and a line marks that
  // row until they post; while the agent is at work it is held there, not following the reply,
  // until the reader reaches the end. Until more rows arrive, what renders late, such as an image,
  // lands at the end at once; what arrives after scrolls in. The thread is marked seen once it is
  // read.
  const [visit, setVisit] = useState<{
    threadId: string;
    rows: unknown;
    openedAt?: string;
    newFrom?: string;
    hold: boolean;
  }>();
  if (
    detail.data &&
    (!detail.isFetching || detail.failureCount > 0) &&
    visit?.threadId !== threadId
  ) {
    const newFrom = detail.data.newFrom ?? undefined;
    setVisit({
      threadId,
      rows: detail.data.rows,
      openedAt: newFrom,
      newFrom,
      hold: !!detail.data.run,
    });
  }
  const opened = visit?.threadId === threadId ? visit : undefined;
  const arriving = !!opened && opened.rows !== saved;
  // The entry the line above what is new marks: the one with the first new row, or the first after
  // it where that row shows as nothing.
  const newFromOrder = rows.find((row) => row.id === opened?.newFrom)?.order;
  const newEntry =
    newFromOrder === undefined
      ? undefined
      : entries.find((entry) => {
          if (entry.kind === "subagent") return false;
          const last =
            entry.kind === "calls" || entry.kind === "relays" ? entry.rows.at(-1)! : entry.row;
          return last.order >= newFromOrder;
        })?.key;
  const stoppedAt = useRef<HTMLDivElement>(null);
  useMarkRead(threadId, notFound || ended || !opened ? undefined : thread?.lastEventSeq);

  const run = detail.data?.run;
  const posting = usePostMessage(threadId);
  const stopping = useStopRun(threadId);
  const retrying = useRetryRun(threadId);
  const decision = useToolDecision(threadId);
  const answering = useToolAnswer(threadId);
  const modelChange = useThreadModel(threadId);
  const subagent = detail.data?.subagent ?? null;
  const unarchiving = useUnarchiveSubagent(threadId, thread?.spaceId);
  // Who writes the thread's agent rows: the name its space or org gave the agent, or a subagent by
  // its label in its own thread.
  const label = subagent?.name;
  const agentName = detail.data?.agentName ?? DEFAULT_AGENT_NAME;
  const agent = useMemo<ThreadAgent>(
    () => ({
      self: label ? { name: label, subagent: true } : { name: agentName, subagent: false },
      agentName,
    }),
    [label, agentName],
  );

  // Reads the page of rows before the first here.
  const before = shown?.before ?? null;
  const loadEarlier = useCallback(async () => {
    if (before === null) return;
    const page = await earlierRows(threadId, before, undefined, viewing).catch(() => null);
    if (!page) return;
    queryClient.setQueryData(
      viewing ? threadBranchQuery(threadId, viewing).queryKey : threadQuery(threadId).queryKey,
      (current) => current && withEarlier(current, page),
    );
  }, [queryClient, threadId, before, viewing]);

  // Throws when the message is not posted, so the composer keeps the text.
  async function send(text: string, mode: Delivery, command?: CommandInput) {
    if (!text.trim()) return;
    // A side question about the last message is asked aside, never posted.
    if (command?.name === BTW) {
      if (!lastMessage || !command.args.trim()) return;
      setOpenAside({ rowId: lastMessage.id, fresh: false });
      await asides.ask(lastMessage.id, command.args.trim());
      return;
    }
    await posting.mutateAsync({ text, mode, ...(command && { command }) });
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

  // The subagent's thread a waiting call shown here is in, for one of a subagent's.
  function subagentThreadOf(callId: string) {
    const started = rows.find(
      (row): row is ToolRow => row.kind === "tool" && row.subagentCall?.id === callId,
    );
    return started?.subagent?.threadId;
  }

  // Approves or denies a tool call, here or in a subagent's thread; the decision arrives with the
  // thread's rows.
  function decide(callId: string, allow: boolean, scope: ToolScope) {
    const subagentThreadId = subagentThreadOf(callId);
    return decision
      .mutateAsync({ callId, allow, scope, ...(subagentThreadId && { subagentThreadId }) })
      .catch(() => {});
  }

  // Answers the questions a call asks, or skips them, here or in a subagent's thread; the answer
  // arrives with the thread's rows.
  function answer(callId: string, answers: AskAnswers | null) {
    const subagentThreadId = subagentThreadOf(callId);
    return answering
      .mutateAsync({ callId, answers, ...(subagentThreadId && { subagentThreadId }) })
      .catch(() => {});
  }

  // A call the reader allowed as they signed in with its server, which the page applies once the
  // browser is back here.
  const { allow, scope, row: target } = threadRoute.useSearch();
  const navigate = threadRoute.useNavigate();
  const allowing = useRef<string>(undefined);
  useEffect(() => {
    if (!allow || !detail.data || allowing.current === allow) return;
    allowing.current = allow;
    void navigate({ search: {}, replace: true });
    void decide(allow, true, scope ?? "once");
  });

  // The row a link led to: once the thread is open it is read back to, when it is in an earlier
  // page, and once here it opens, with the run it is in, is scrolled to and lit for a moment. Each
  // time a link is followed it leads there again, even to where the page already is.
  const [focused, setFocused] = useState<string>();
  const [lit, setLit] = useState<string>();
  const [followed, setFollowed] = useState(0);
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  const reaching = useRef<string>(undefined);
  const follow = useCallback(() => {
    setLit(undefined);
    setFollowed((count) => count + 1);
  }, []);
  // A row only on another branch opens that branch, the current one where it holds the row.
  useEffect(() => {
    const key = target && `${threadId}:${target}:${viewing ?? ""}:${entry}:${followed}`;
    if (!key || !target || !opened || !shown || focused === key) return;
    if (!rows.some((row) => row.id === target)) {
      if (reaching.current === key) return;
      reaching.current = key;
      const from = shown.branch.id;
      void branchOfRow(threadId, target)
        .then(async (holder) => {
          if (holder.id !== from) {
            await navigate({
              search: { ...(!holder.current && { branch: holder.id }), row: target },
              replace: true,
            });
            return;
          }
          if (before === null) return;
          const page = await earlierRows(threadId, before, target, viewing);
          queryClient.setQueryData(
            viewing
              ? threadBranchQuery(threadId, viewing).queryKey
              : threadQuery(threadId).queryKey,
            (current) => current && withEarlier(current, page),
          );
        })
        .catch(() => {});
      return;
    }
    setFocused(key);
    toggleRows([target, relayRunKey(target), lineKey(target)], true);
    setLit(target);
  });
  useEffect(() => {
    if (!lit) return;
    const timer = setTimeout(() => setLit(undefined), LIT_MS);
    return () => clearTimeout(timer);
  }, [lit]);
  const focus = useMemo(
    () => ({ opened: openRows, onOpenChange: toggleRows, follow, ...(lit && { lit }) }),
    [openRows, toggleRows, follow, lit],
  );

  // What the reader may do from a row.
  function actionsFor(row: ShownRow): RowActions {
    return {
      ...((row.kind === "failure" || row.kind === "stop") &&
        row.canRetry && { retry: () => retry(row.runId) }),
      ...(can?.arrange && { pickModel: () => setPicking(true) }),
      ...(row.kind === "tool" &&
        !!row.actions?.length && {
          decide: (allow: boolean, scope: ToolScope) => decide(row.id, allow, scope),
        }),
      ...(row.kind === "tool" &&
        row.canAnswer && {
          answer: (answers: AskAnswers | null) => answer(row.id, answers),
        }),
      ...(row.kind === "human" &&
        row.can?.includes("edit") && {
          edit: (text: string) => act({ action: "edit", rowId: row.id, text }),
        }),
    };
  }

  // The thread's history: acting from a row asks first before going past tool calls that changed
  // something, and a new current branch is shown once made; the reader's side questions sit at
  // the end of the actions of the rows they are about.
  const acting = useHistoryAction(threadId);
  const forking = useForkThread(threadId);
  const summarising = useSummaryThread(threadId);
  const [confirming, setConfirming] = useState<{
    calls: { title: string; toolset: string | null }[];
    go: () => void;
  }>();
  const showBranch = useCallback(
    (branchId?: string) =>
      void navigate({ search: branchId && branchId !== currentBranch ? { branch: branchId } : {} }),
    [navigate, currentBranch],
  );
  async function act(action: BranchAction): Promise<void> {
    const result = await acting.mutateAsync(action).catch(() => null);
    if (!result) return;
    if ("confirm" in result) {
      setConfirming({ calls: result.confirm, go: () => void act({ ...action, confirm: true }) });
      return;
    }
    if ("branchId" in result) showBranch();
  }
  const history: RowHistory = {
    retry: (rowId, asked) => void act({ action: "retry", rowId, ...(asked && { with: asked }) }),
    restore: (rowId) =>
      void act({ action: "restore", rowId, ...(viewing && { branchId: viewing }) }),
    fork: (rowId) => forking.mutate({ rowId, ...(viewing && { branchId: viewing }) }),
    version: (branchId) => showBranch(branchId),
    pickers: {
      models: models.data?.models ?? [],
      loading: models.isPending,
      model: thread?.model ?? null,
      effort: thread?.effort ?? null,
      defaults: detail.data?.defaults,
      used: detail.data?.model?.used && {
        ...detail.data.model.used,
        effort: detail.data.model.effort,
      },
      replying: detail.data?.model?.used?.ref ?? detail.data?.model?.chosen.ref ?? null,
    },
  };

  const asideList = useQuery({ ...asidesQuery(threadId), enabled: !!can?.post });
  const asking = useAskAside(threadId);
  const [openAside, setOpenAside] = useState<AsideOpen | null>(null);
  const byRow = new Map<string, Aside[]>();
  for (const aside of asideList.data ?? []) {
    byRow.set(aside.rowId, [...(byRow.get(aside.rowId) ?? []), aside]);
  }
  const asides: Asides = {
    byRow,
    open: openAside,
    setOpen: setOpenAside,
    answering: asking.answering?.rowId ?? null,
    stop: () => asking.stop(),
    async ask(rowId, text, asideId) {
      await asking.ask(
        asideId ? { rowId, asideId, text } : { rowId, text, ...(viewing && { branchId: viewing }) },
      );
    },
  };
  // The last message of the rows shown, which `/btw` asks about and an older branch is restored
  // or forked from as a whole.
  const lastMessage = rows.findLast(
    (row) => row.kind === "human" || (row.kind === "agent" && row.status !== "streaming"),
  );

  // A click in a reply's layout posts as the person who clicked, for those who may post.
  const replyActions = can?.post
    ? { send: (text: string) => void send(text, "queue").catch(() => {}) }
    : {};

  // Changes the thread's model or reasoning effort.
  function change(json: { model: string | null } | { effort: Effort | null }) {
    modelChange.mutate(json);
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
          ...(subagent
            ? [
                {
                  label: subagent.parent.title,
                  link: { to: "/t/$threadId" as const, params: { threadId: subagent.parent.id } },
                },
              ]
            : []),
          { label: subagent?.name ?? thread?.title ?? "" },
        ]}
      >
        {subagent?.state === "archived" && (
          <span className="text-xs text-muted-foreground">Archived</span>
        )}
        {subagent?.canUnarchive && (
          <Button
            size="sm"
            variant="outline"
            disabled={unarchiving.isPending}
            onClick={() => unarchiving.mutate()}
          >
            Unarchive
          </Button>
        )}
        {can?.share && !subagent && <ShareDialog threadId={threadId} />}
        {!viewing && lastMessage?.can?.includes("fork") && (
          <WithTooltip label="New thread from summary">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New thread from summary"
              disabled={summarising.isPending}
              onClick={() => summarising.mutate()}
            >
              {summarising.isPending ? <Spinner aria-hidden /> : <FileTextIcon />}
            </Button>
          </WithTooltip>
        )}
        {archived && thread && can && (can.move || can.delete) && (
          <ArchivedThreadActions thread={thread} can={can} />
        )}
      </PageHeader>
      <ThreadAgentContext.Provider value={agent}>
        <RowFocusContext.Provider value={focus}>
          <RowHistoryContext.Provider value={history}>
            <AsidesContext.Provider value={asides}>
              <ReplyActions.Provider value={replyActions}>
                {detail.data && (!viewing || older.data) ? (
                  // The cached thread shows at once; it opens again where the reader stopped once read.
                  <Conversation
                    key={`${threadId}:${viewing ?? currentBranch}:${opened?.openedAt ?? ""}`}
                    openAt={stoppedAt}
                    holdOpenAt={opened?.hold}
                    scrollTo={lit && rowElementId(lit)}
                    aria-label="Events"
                    className="min-h-0"
                    resize={arriving ? "smooth" : "instant"}
                  >
                    <ConversationContent className={cn(pageWidth, "gap-4")}>
                      {rows.length === 0 ? (
                        <ConversationEmptyState description="Write the first message below." />
                      ) : (
                        <>
                          <ConversationEarlier
                            more={before !== null}
                            first={rows[0]?.id}
                            onLoad={loadEarlier}
                          />
                          {entries.map((entry) => (
                            <Fragment key={entry.key}>
                              {entry.key === newEntry && (
                                // Where the reader stopped; takes no room in the rows' gap.
                                <div ref={stoppedAt} aria-hidden className="-my-2 h-0 shrink-0" />
                              )}
                              <div className={ENTRY_GAPS[entry.gap]}>
                                {entry.kind === "calls" ? (
                                  <ToolGroup
                                    rows={entry.rows}
                                    calls={entry.calls}
                                    turn={entry.turn}
                                    tools={detail.data?.tools ?? []}
                                    open={entry.calls.some((call) => openRows.has(call.id))}
                                    onOpenChange={(open) =>
                                      toggleRows(
                                        entry.calls.map((call) => call.id),
                                        open,
                                      )
                                    }
                                  />
                                ) : entry.kind === "relays" ? (
                                  <RelayMessages
                                    rows={entry.rows}
                                    opened={openRows}
                                    onOpenChange={toggleRows}
                                  />
                                ) : entry.kind === "notice" ? (
                                  <SubagentNotice row={entry.row} />
                                ) : entry.kind === "subagent" ? (
                                  <ToolCall
                                    row={entry.row}
                                    definition={detail.data?.tools.find(
                                      (tool) => tool.name === entry.row.toolId,
                                    )}
                                    turn={{ continued: false, model: null }}
                                    subagent={entry.subagent.name}
                                    decide={actionsFor(entry.row).decide}
                                    answer={actionsFor(entry.row).answer}
                                  />
                                ) : (
                                  <TranscriptItem
                                    row={entry.row}
                                    tools={detail.data?.tools}
                                    actions={actionsFor(entry.row)}
                                  />
                                )}
                              </div>
                            </Fragment>
                          ))}
                        </>
                      )}
                      {run &&
                        !viewing &&
                        !run.waiting &&
                        !rows.some((row) => row.kind === "agent" && row.status === "streaming") && (
                          <div className={rows.at(-1)?.turn ? ENTRY_GAPS.near : undefined}>
                            <AgentStarting
                              at={run.createdAt}
                              continued={!!rows.at(-1)?.turn}
                              compacting={run.compacting}
                            />
                          </div>
                        )}
                    </ConversationContent>
                    <ConversationScrollButton />
                  </Conversation>
                ) : (
                  <div className="min-h-0 flex-1" />
                )}
              </ReplyActions.Provider>
            </AsidesContext.Provider>
          </RowHistoryContext.Provider>
        </RowFocusContext.Provider>
      </ThreadAgentContext.Provider>
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
          {viewing ? (
            <div
              role="region"
              aria-label="Earlier version"
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
            >
              <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1 text-sm text-muted-foreground">
                Earlier version · read-only
              </span>
              {lastMessage?.can?.includes("restore") && (
                <Button size="sm" variant="ghost" onClick={() => history.restore(lastMessage.id)}>
                  <Undo2Icon />
                  Restore from here
                </Button>
              )}
              {lastMessage?.can?.includes("fork") && (
                <Button size="sm" variant="ghost" onClick={() => history.fork(lastMessage.id)}>
                  <SplitIcon />
                  Fork into new thread
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => showBranch()}>
                Back to current
              </Button>
            </div>
          ) : (
            <>
              <RunStatus stopping={!!run && run.id === stopped} />
              <PendingTray
                threadId={threadId}
                pending={detail.data?.pending ?? []}
                me={me.data?.user.id}
              />
              <FieldError>{posting.error?.message}</FieldError>
              <Composer
                running={!!run}
                waiting={run?.waiting ?? null}
                readOnly={!!detail.data && !can?.post}
                notice={
                  archived
                    ? "This space is archived"
                    : subagent?.state === "archived"
                      ? "This subagent is archived"
                      : undefined
                }
                sending={posting.isPending}
                stopping={!!run && run.id === stopped}
                onSend={send}
                onStop={stop}
                commands={can?.post ? commands.data : undefined}
                onConnected={() => commands.refetch()}
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
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(undefined)}
        title="Changes stay"
        description="These tool calls changed something and won't be undone."
        action="Continue"
        onConfirm={() => {
          confirming?.go();
          setConfirming(undefined);
        }}
      >
        <ul aria-label="Not undone" className="flex flex-col gap-1 text-sm">
          {confirming?.calls.map((call, index) => (
            <li key={index} className="truncate">
              {[call.toolset, call.title].filter(Boolean).join(" › ")}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

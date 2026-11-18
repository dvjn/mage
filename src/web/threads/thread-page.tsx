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
import { HistoryIcon, SplitIcon, Undo2Icon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import type { AskAnswers } from "@/shared/ask.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { BTW, type CommandInput } from "@/shared/threads/commands.ts";
import type { Aside, BranchAction } from "@/shared/threads/history.ts";
import type { Delivery, ToolScope } from "@/shared/threads/events.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { AuthCard, AuthFrame } from "@/web/auth/auth-frame";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import {
  Conversation,
  ConversationContent,
  ConversationEarlier,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import { Button } from "@/web/components/ui/button";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { ArtifactThreadContext } from "@/web/artifacts/artifact-card";
import { ThreadArtifacts } from "@/web/artifacts/thread-artifacts";
import { ShareDialog } from "@/web/guests/share-dialog";
import { ThreadMenu } from "@/web/threads/thread-menu";
import { useStable } from "@/web/hooks/use-stable";
import { useOnline } from "@/web/lib/online";
import { modelsQuery } from "@/web/models/queries";
import { ThreadPickers } from "@/web/models/thread-pickers";
import { ReplyActions } from "@/web/replies/reply-actions";
import { GoHome, NotFound } from "@/web/shell/not-found";
import { PageHeader, pageWidth } from "@/web/shell/page-header";
import { rememberSpace } from "@/web/spaces/last-space";
import { spacesQuery } from "@/web/spaces/queries";
import { PrintedContext, useThreadEvents } from "@/web/threads/event-stream";
import { opensFor } from "@/web/threads/transcript/call-tree";
import { useMarkRead } from "@/web/threads/thread-lists";
import {
  usePostMessage,
  useRetryRun,
  useStopRun,
  useThreadModel,
  useCancelJob,
  useScheduleAndWebhookActions,
  useMoveToBackground,
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
import {
  type RowHistory,
  RowHistoryContext,
  RowToolbar,
} from "@/web/threads/transcript/row-history";
import { ActivityTray, type TrayGroup, OpenTrayContext } from "@/web/threads/activity-tray";
import { Composer, WaitingTray, RunStatus } from "@/web/threads/thread-composer";
import { rowsWithCallers, withEarlier, withLatestPage } from "@/web/threads/thread-rows";
import { EarlierUnread } from "@/web/threads/transcript/earlier-unread";
import { AgentStarting } from "@/web/threads/transcript/agent-starting";
import { type TranscriptEntry, transcriptTurns } from "@/web/threads/transcript/entries";
import { EntryView } from "@/web/threads/transcript/entry-view";
import { type ThreadAgent, ThreadAgentContext } from "@/web/threads/transcript/agent";
import { rowActions } from "@/web/threads/transcript/row-actions";
import {
  lineKey,
  noticeRunKey,
  rowElementId,
  RowFocusContext,
} from "@/web/threads/transcript/row-focus";
import { ActivityActionsContext } from "@/web/threads/transcript/activity-actions";

const threadRoute = getRouteApi("/_app/t/$threadId");

// Marks the element as the floating layer at the bottom of its parent, and publishes its height on
// the parent as `--layer-height`, so the transcript can pad below it and the scroll button can sit
// above it. Measured before paint and on every resize, so it never jumps.
function floatingLayer(layer: HTMLElement | null) {
  const root = layer?.parentElement;
  if (!layer || !root) return;
  const measure = () => root.style.setProperty("--layer-height", `${layer.offsetHeight}px`);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(layer);
  return () => {
    observer.disconnect();
    root.style.removeProperty("--layer-height");
  };
}

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
  const online = useOnline();
  // The kind of the activity tray that is open.
  const [trayOpen, setTrayOpen] = useState<TrayGroup | null>(null);
  // The rows whose cards are open in the tray, which stay marked.
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  // The run someone here asked to stop.
  const [stopped, setStopped] = useState<string>();
  const [picking, setPicking] = useState(false);
  const thread = detail.data?.thread;
  // The header and the composer are drawn as a thread opens; its transcript and the tray strip over
  // it follow in a render that gives way to input, from the same cache, in the room they fill.
  const settled = useDeferredValue(threadId, "") === threadId;
  // The rows shown: the current branch's, kept live, or the older branch's as read.
  const shown = viewing ? older.data : detail.data;
  const saved = shown?.rows;
  const callers = shown?.callers;
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
  const { streaming, printed, reconnecting } = useThreadEvents(
    threadId,
    !!detail.data && !notFound && !ended,
  );
  // The thread cannot be read or followed right now; what is shown is what was last read. Offline,
  // the sidebar says so instead.
  const offline = online && !notFound && !ended && (detail.failureCount > 0 || reconnecting);
  // The rows with the text so far of each reply still being written.
  const rows = useMemo(
    () =>
      rowsWithCallers(saved ?? [], callers).map((row): ShownRow => {
        const pieces = row.kind === "agent" && row.status === "streaming" && streaming.get(row.id);
        return pieces ? { ...row, text: pieces.text, reasoning: pieces.reasoning } : row;
      }),
    [saved, callers, streaming],
  );

  const running = !!detail.data?.run;
  const turns = useMemo(() => transcriptTurns(rows, { running }), [rows, running]);
  const entries = useMemo(
    () =>
      turns.flatMap((turn) =>
        turn.blocks.flatMap((block) => (block.kind === "lines" ? block.entries : [block])),
      ),
    [turns],
  );
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
          if (entry.kind === "subagent" || entry.kind === "artifacts") return false;
          const last =
            entry.kind === "calls" || entry.kind === "notices" ? entry.rows.at(-1)! : entry.row;
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
  const moving = useMoveToBackground(threadId);
  const cancelling = useCancelJob(threadId);
  const timed = useScheduleAndWebhookActions(threadId);
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

  // Leaving the thread keeps its newest page only, so it opens again as cheaply as one never
  // scrolled back, still fresh or stale as it was.
  useEffect(
    () => () => {
      for (const key of [
        threadQuery(threadId).queryKey,
        ...(viewing ? [threadBranchQuery(threadId, viewing).queryKey] : []),
      ]) {
        const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        const data = query?.state.data;
        if (!query || !data) continue;
        const kept = withLatestPage(data as ThreadDetail);
        if (kept !== data) {
          queryClient.setQueryData(key, kept, { updatedAt: query.state.dataUpdatedAt });
        }
      }
    },
    [queryClient, threadId, viewing],
  );

  // Reads the page of rows before the first here.
  const before = shown?.before ?? null;
  const loadEarlier = useCallback(async () => {
    if (before === null) return;
    // Rejects when the page is not read, for the transcript to offer a retry.
    const page = await earlierRows(threadId, before, {
      branch: viewing,
      unreadFrom: shown?.newFrom,
    });
    queryClient.setQueryData(
      viewing ? threadBranchQuery(threadId, viewing).queryKey : threadQuery(threadId).queryKey,
      (current) => current && withEarlier(current, page),
    );
  }, [queryClient, threadId, before, viewing, shown?.newFrom]);

  // Reads back to the first row the reader had not seen, past the page the thread opened with.
  const newFrom = shown?.newFrom;
  const loadUnread = useCallback(async () => {
    if (before === null || !newFrom) return;
    const page = await earlierRows(threadId, before, {
      at: newFrom,
      branch: viewing,
      unreadFrom: newFrom,
    }).catch(() => null);
    if (!page) return;
    queryClient.setQueryData(
      viewing ? threadBranchQuery(threadId, viewing).queryKey : threadQuery(threadId).queryKey,
      (current) => current && withEarlier(current, page),
    );
  }, [queryClient, threadId, before, viewing, newFrom]);

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
      .mutateAsync({
        callId,
        allow,
        scope,
        ...(subagentThreadId && { subagentThreadId }),
      })
      .catch(() => {});
  }

  // Moves a call to the background, and stops one there.
  const background = {
    move: (callId: string) => moving.mutateAsync(callId).catch(() => {}),
    cancel: (callId: string) => cancelling.mutateAsync(callId).catch(() => {}),
    schedule: {
      pause: (id: string) => timed.schedule.pause(id).catch(() => {}),
      resume: (id: string) => timed.schedule.resume(id).catch(() => {}),
      remove: (id: string) => timed.schedule.remove(id).catch(() => {}),
    },
    webhook: {
      pause: (id: string) => timed.webhook.pause(id).catch(() => {}),
      resume: (id: string) => timed.webhook.resume(id).catch(() => {}),
      remove: (id: string) => timed.webhook.remove(id).catch(() => {}),
      secret: (id: string, secret: string | null) => timed.webhook.secret(id, secret),
      deliveryHeader: (id: string, header: string | null) =>
        timed.webhook.deliveryHeader(id, header),
    },
  };

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
  // page, and once here it opens, with its run, is scrolled to and marked for two to five seconds. Each
  // time a link is followed it leads there again, even to where the page already is.
  const [focused, setFocused] = useState<string>();
  const [litRow, setLit] = useState<string>();
  // Marked while the link that led to it is followed.
  const lit = target ? litRow : undefined;
  const [acknowledged, setAcknowledged] = useState<string>();
  const highlightedAt = useRef(0);
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
          const page = await earlierRows(threadId, before, {
            at: target,
            branch: viewing,
            unreadFrom: shown.newFrom,
          });
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
    toggleRows([target, noticeRunKey(target), lineKey(target), ...opensFor(rows, target)], true);
    // An agent's message starts open, and is kept here only once the reader closes it.
    const reached = rows.find((row) => row.id === target);
    if (reached?.kind === "notice" && reached.type === "message") toggleRows([target], false);
    highlightedAt.current = Date.now();
    setAcknowledged(undefined);
    setLit(target);
  });
  const clearHighlight = useCallback(
    (rowId: string) => {
      if (lit !== rowId) return;
      setLit(undefined);
      if (target === rowId) {
        void navigate({
          search: (previous) => ({ ...previous, row: undefined }),
          replace: true,
          resetScroll: false,
        });
      }
    },
    [lit, target, navigate],
  );
  const dismiss = useCallback(
    (rowId: string) => {
      if (lit === rowId) setAcknowledged(rowId);
    },
    [lit],
  );
  useEffect(() => {
    if (!lit) return;
    const duration = acknowledged === lit ? 2000 : 5000;
    const remaining = Math.max(0, duration - (Date.now() - highlightedAt.current));
    const timer = setTimeout(() => clearHighlight(lit), remaining);
    return () => clearTimeout(timer);
  }, [lit, acknowledged, clearHighlight]);
  const focus = useMemo(
    () => ({
      opened: openRows,
      onOpenChange: toggleRows,
      follow,
      dismiss,
      held,
      ...(lit && { lit }),
    }),
    [openRows, toggleRows, follow, dismiss, lit, held],
  );

  // The thread's history: acting from a row asks first before going past tool calls that changed
  // something, and a new current branch is shown once made; the reader's side questions sit at
  // the end of the actions of the rows they are about.
  const acting = useHistoryAction(threadId);
  const forking = useForkThread(threadId);
  const summarising = useSummaryThread(threadId);
  const [confirming, setConfirming] = useState<{
    calls: { title: string; toolset: string | null }[];
    action: BranchAction;
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
      setConfirming({ calls: result.confirm, action });
      return;
    }
    if ("branchId" in result) showBranch();
  }
  const history: RowHistory = {
    retry: (rowId, asked) => void act({ action: "retry", rowId, ...(asked && { with: asked }) }),
    restore: (rowId) =>
      void act({ action: "restore", rowId, ...(viewing && { branchId: viewing }) }),
    fork: (rowId) => forking.mutate({ rowId, ...(viewing && { branchId: viewing }) }),
    forkFromSummary: (rowId) =>
      summarising.mutate({ rowId, ...(viewing && { branchId: viewing }) }),
    summarising: summarising.isPending ? (summarising.variables?.rowId ?? null) : null,
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

  // What the reader may do from a row, the same for a row until its handlers change.
  const retryRun = useStable(retry);
  const decideCall = useStable(decide);
  const answerCall = useStable(answer);
  const editRow = useStable((rowId: string, text: string) => act({ action: "edit", rowId, text }));
  const arrange = !!can?.arrange;
  const pickModel = useCallback(() => setPicking(true), []);
  const actionsFor = useMemo(
    () =>
      rowActions({
        retry: retryRun,
        decide: decideCall,
        answer: answerCall,
        edit: editRow,
        ...(arrange && { pickModel }),
      }),
    [retryRun, decideCall, answerCall, editRow, arrange, pickModel],
  );
  const tools = detail.data?.tools;

  // One entry of a turn; the one with the first new row marks where the reader stopped.
  const entryView = (entry: TranscriptEntry) => (
    <div key={entry.key} ref={entry.key === newEntry ? stoppedAt : undefined} data-row-frame>
      <EntryView
        entry={entry}
        tools={tools}
        actionsFor={actionsFor}
        open={entry.kind === "calls" && entry.calls.some((call) => openRows.has(call.id))}
        opened={entry.kind === "notices" ? openRows : undefined}
        onOpenChange={toggleRows}
      />
    </div>
  );
  // The agent getting to work: under its turn where it continues one, else a turn of its own.
  const starting = run &&
    !viewing &&
    !run.waiting &&
    !rows.some((row) => row.kind === "agent" && row.status === "streaming") && (
      <AgentStarting
        at={run.createdAt}
        continued={!!rows.at(-1)?.turn}
        compacting={run.compacting}
      />
    );

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
    <div className="relative flex h-full min-h-0 flex-col">
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
        {!subagent && <ThreadArtifacts threadId={threadId} rows={rows} />}
        {can?.share && !subagent && <ShareDialog threadId={threadId} />}
        {thread && can && (
          <ThreadMenu
            thread={thread}
            can={can}
            archived={archived}
            onUnarchive={subagent?.canUnarchive ? () => unarchiving.mutate() : undefined}
          />
        )}
      </PageHeader>
      <ThreadAgentContext.Provider value={agent}>
        <ArtifactThreadContext.Provider value={threadId}>
          <RowFocusContext.Provider value={focus}>
            <PrintedContext.Provider value={printed}>
              <ActivityActionsContext.Provider value={background}>
                <OpenTrayContext.Provider value={setTrayOpen}>
                  <RowHistoryContext.Provider value={history}>
                    <AsidesContext.Provider value={asides}>
                      <ReplyActions.Provider value={replyActions}>
                        {detail.data && (!viewing || older.data) && settled ? (
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
                            <ConversationContent
                              className={cn(
                                pageWidth,
                                "gap-6 pb-[calc(var(--layer-height,0px)+1rem)]",
                              )}
                            >
                              {rows.length === 0 ? (
                                <ConversationEmptyState description="Write the first message below." />
                              ) : (
                                <>
                                  {before !== null && !!shown?.earlierUnread && (
                                    <EarlierUnread
                                      count={shown.earlierUnread}
                                      onLoad={loadUnread}
                                    />
                                  )}
                                  <ConversationEarlier
                                    more={before !== null}
                                    first={rows[0]?.id}
                                    onLoad={loadEarlier}
                                  />
                                  {turns.map((turn, index) => (
                                    <div
                                      key={turn.key}
                                      data-turn={turn.kind}
                                      className="flex flex-col gap-1"
                                    >
                                      <div className="flex flex-col gap-3">
                                        {turn.blocks.map((block) =>
                                          block.kind === "lines" ? (
                                            <div key={block.key} className="flex flex-col gap-1">
                                              {block.entries.map(entryView)}
                                            </div>
                                          ) : (
                                            entryView(block)
                                          ),
                                        )}
                                        {index === turns.length - 1 &&
                                          turn.kind === "agent" &&
                                          starting}
                                      </div>
                                      {turn.actions && (
                                        <RowToolbar
                                          rowId={turn.actions.id}
                                          text={turn.actions.text}
                                          can={turn.actions.can}
                                        />
                                      )}
                                    </div>
                                  ))}
                                </>
                              )}
                              {turns.at(-1)?.kind !== "agent" && starting}
                            </ConversationContent>
                            <ConversationScrollButton className="bottom-[calc(var(--layer-height,0px)+1.5rem)]" />
                          </Conversation>
                        ) : (
                          <div className="min-h-0 flex-1" />
                        )}
                      </ReplyActions.Provider>
                    </AsidesContext.Provider>
                  </RowHistoryContext.Provider>
                </OpenTrayContext.Provider>
              </ActivityActionsContext.Provider>
            </PrintedContext.Provider>
          </RowFocusContext.Provider>
        </ArtifactThreadContext.Provider>
      </ThreadAgentContext.Provider>
      <div ref={floatingLayer} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className={cn(pageWidth, "relative p-4 pt-2")}>
          {/* Only the surfaces take the pointer; the chat behind them stays scrollable around them. */}
          <div className="flex flex-col gap-2 *:pointer-events-auto">
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
            {!viewing && (
              <>
                <RunStatus stopping={!!run && run.id === stopped} />
                <WaitingTray threadId={threadId} waiting={detail.data?.waiting ?? []} />
                <FieldError>{posting.error?.message}</FieldError>
              </>
            )}
            <ActivityActionsContext.Provider value={background}>
              <ActivityTray
                threadId={threadId}
                agentName={agentName}
                settled={settled}
                asked={trayOpen}
                onAsk={setTrayOpen}
                decide={decide}
                onHold={setHeld}
              >
                {viewing ? (
                  <div
                    role="region"
                    aria-label="Earlier version"
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="flex-1 text-sm text-muted-foreground">
                      Earlier version · read-only
                    </span>
                    {lastMessage?.can?.includes("restore") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => history.restore(lastMessage.id)}
                      >
                        <Undo2Icon />
                        Restore from here
                      </Button>
                    )}
                    {lastMessage?.can?.includes("fork") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => history.fork(lastMessage.id)}
                      >
                        <SplitIcon />
                        Fork into new thread
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => showBranch()}>
                      Back to current
                    </Button>
                  </div>
                ) : (
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
                )}
              </ActivityTray>
            </ActivityActionsContext.Provider>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(undefined)}
        title="Changes stay"
        description="These tool calls changed something and won't be undone."
        action="Continue"
        onConfirm={() => {
          if (confirming) void act({ ...confirming.action, confirm: true });
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

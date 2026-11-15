// A thread as each reader sees it: the thread itself, what they may do in it, the defaults it
// follows and the models it names and replies with; its transcript's rows, a page at a time from
// the newest, reaching back to the first they had not seen, with what they may do from each, what
// waits for the agent and the run under way; and, followed, the rows each new event changes, with
// the pieces of replies in progress and of running calls' output, the tray and the task list. A
// subagent's thread is read like any other, though nothing in it is ever new to anyone; the lines
// for starting each subagent show where it stands now, with the call it waits on as the reader
// would see it in the subagent's thread. Each subagent call links to where it had its effect, and
// each message another agent sent links back to the call that sent it, in the threads the reader
// may read. Each row written again shows its versions.

import type { Subagents } from "@/server/subagents/subagents.ts";
import { influenceParts } from "@/server/calls/influence.ts";
import type { Queue, QueuedInput } from "@/server/queue/queue.ts";
import type { CallPresentation, Tools } from "@/server/tools/registry.ts";

import type { Signals, ThreadHint } from "@/server/sync/signals.ts";
import type { Models } from "@/server/models/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import { agentNameFrom, type Space } from "@/server/spaces/service.ts";
import type { Access, Reader as AccessReader, ThreadAccess } from "@/server/access/access.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { ThreadCan, ThreadDetail, ThreadHead } from "@/shared/threads/detail.ts";
import type { WaitingCall } from "@/server/calls/calls.ts";
import type { Tasks } from "@/server/tasks/tasks.ts";
import type { Live } from "@/server/calls/live.ts";
import { type ActivityList } from "@/shared/jobs.ts";
import type { TaskList } from "@/shared/tasks.ts";
import { type DeltaBatch, type LiveChunk } from "@/shared/threads/events.ts";
import {
  ROWS_PAGE,
  type RowsPage,
  type RowsUpdate,
  type RowVersions,
  type ShownRow,
  type ShownRun,
  type WaitingAction,
  type WaitingRow,
} from "@/shared/threads/rows.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";
import type {
  LimitRow,
  PendingMessage,
  NoticeMessage,
  NoticeRow,
  SentCommand,
  ToolRow as TranscriptToolRow,
  Transcript,
  TranscriptFold,
  TranscriptRow,
} from "@/shared/transcript.ts";

import type { BranchHistory, Branches } from "@/server/threads/branches.ts";
import type { DeltaStore, Thread, ThreadStore } from "@/server/threads/types.ts";
import { rowActions } from "@/server/threads/history.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";

import type { Needs } from "./needs.ts";
import type { Reads } from "./reads.ts";
import type { Activity } from "./activity.ts";
import { threadSummary } from "@/server/threads/threads.ts";

export interface ThreadViewsOptions {
  access: Pick<ThreadAccess, "can" | "of" | "require" | "reader">;
  threads: ThreadStore;
  deltas: Pick<DeltaStore, "inThread" | "from">;
  models: Pick<Models, "inOrg" | "modelLabels">;
  signals: Signals;
  // What waits for the thread's agent.
  queue: Pick<Queue, "waiting">;
  // Threads' transcripts, shared with the agent so a thread's fold is kept once.
  transcripts: Transcripts;
  // The thread's branches: what the reader may do from its rows, and their versions.
  branches: Pick<Branches, "branchIn" | "historyOf">;
  // Whether the thread is a retired subagent's, which nobody posts in.
  retired: (thread: Thread) => Promise<boolean>;
  needs: Pick<Needs, "of" | "waitsFor">;
  reads: Pick<Reads, "seen">;
  activity: Pick<Activity, "of">;
  // The traceparent of a run's span while it runs, which its readers' traces link to; none while
  // tracing is off.
  runTrace?: (runId: string) => string | undefined;
  // The agent's tools, for each reader's level for them.
  tools: Pick<Tools, "shownTo" | "movable" | "connectionFor" | "namesIn" | "present">;
  // The subagents threads' agents start, when given.
  subagents?: Pick<Subagents, "find" | "summaryOf">;
  // The thread's task list, when given.
  tasks?: Pick<Tasks, "listFor" | "ownerOf">;
  // What the thread's running calls have printed so far, when kept.
  live?: Pick<Live, "inThread" | "tail">;
}

export type ThreadViews = ReturnType<typeof createThreadViews>;

// What a thread's follower is told: the rows the log's new events changed, with the waiting
// messages and the run as they now are; the pieces of a reply in progress and of a running call's
// output; and the thread itself once it is renamed, moved or set to another model.
export type ThreadFollowItem =
  | { kind: "rows"; update: RowsUpdate }
  | { kind: "delta"; delta: DeltaBatch }
  | { kind: "live"; live: LiveChunk }
  | { kind: "thread"; head: ThreadHead }
  | { kind: "tasks"; list: TaskList }
  | { kind: "activity"; list: ActivityList };

// Who reads a thread and what they may do in it, for the parts of its rows that are theirs, built
// once per request or delivery from what the access rule read of them.
interface Page {
  principal: AccessReader["principal"];
  // What the access rule read of them before the thread.
  read: AccessReader;
  userId: string;
  thread: Thread;
  space: Space | null;
  can: ThreadCan;
  // What the agent of the thread's space goes by.
  agentName: string;
  // What each tool call is called where it shows.
  names: ReturnType<Tools["namesIn"]>;
  // What each call of the branch shows the reader beyond its row, read once for them all.
  present(row: TranscriptToolRow): Promise<CallPresentation>;
  // The thread's calls that wait for a person, by id, with whether the reader may act on each.
  waitingCalls(): Promise<Map<string, WaitingCall>>;
  // Other threads' transcripts read for this reader's rows, each read once.
  folds: Map<string, TranscriptFold>;
  // Another thread when the reader may read it, else null; each read once for the page.
  readable(threadId: string): Promise<Thread | null>;
  // What the thread's own agent goes by: its subagent's label, or the agent's name; read once.
  ownName(): Promise<string>;
  // The branch read, what they may do from its rows and which of them have versions.
  history: BranchHistory;
  // What waits for the thread's agent on its current branch, read once when first asked.
  waiting(): Promise<QueuedInput[]>;
}

// The parts of a row that are the reader's, which can change while the row itself does not.
function readerPartsOf(row: ShownRow) {
  if (row.kind === "tool") {
    return JSON.stringify([
      row.risk,
      row.actions,
      row.canAnswer,
      row.canBackground,
      row.work,
      row.connection,
      row.influence,
      row.subagent,
      row.subagentCall,
    ]);
  }
  if (row.kind === "failure" || row.kind === "stop") return JSON.stringify([row.canRetry]);
  return "";
}

// A command as its message shows it: what the person typed, without what the agent reads for it.
function shownCommand(command: SentCommand | undefined) {
  return command && { command: { name: command.name, args: command.args } };
}

// The tool rows among the rows.
function toolRowsOf(rows: readonly TranscriptRow[]) {
  return rows.filter((row): row is TranscriptToolRow => row.kind === "tool");
}

// The rows whose reader's parts can change while they do not: the calls waiting for a decision or
// for answers, those whose presentation may change with no new event, and a last row from which
// a failed or stopped run is tried again.
async function liveIndexes({ rows }: Transcript, reader: Page) {
  const live = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "tool") continue;
    if (row.state === "waiting") live.add(index);
    else if ((await reader.present(row)).live) live.add(index);
  }
  const last = rows.at(-1);
  if (last?.kind === "failure" || last?.kind === "stop") live.add(rows.length - 1);
  return live;
}

// The run under way, whether it waits for answers to the agent's questions or for a decision, and
// its trace while it is traced.
async function shownRun(
  { run }: Transcript,
  threadId: string,
  traceOf: (runId: string) => string | undefined,
  waitsFor: (threadId: string, callId: string) => Promise<"decision" | "answer" | null>,
): Promise<ShownRun | null> {
  if (!run) return null;
  const waiting = run.waitingOn ? ((await waitsFor(threadId, run.waitingOn)) ?? "decision") : null;
  const trace = traceOf(run.id);
  return {
    id: run.id,
    createdAt: run.createdAt,
    waiting,
    ...(run.compacting && { compacting: true as const }),
    ...(trace && { trace }),
  };
}

// How many rows beyond the newest page a first read reaches back for what the reader has not seen:
// one page, so opening a thread costs at most about twice a plain open, and the rest is asked for.
const UNREAD_REACH = ROWS_PAGE;

// Where the newest page of rows starts: ROWS_PAGE rows back, or at `from` where that is earlier but
// no more than UNREAD_REACH further, and at the last message where that is earlier still, which
// `/btw`, retry and fork act on past a long run of tool calls.
function pageStart({ rows }: Transcript, from: number) {
  const lastMessage = rows.findLastIndex(
    (row) => row.kind === "human" || (row.kind === "agent" && row.status !== "streaming"),
  );
  const newest = Math.max(0, rows.length - ROWS_PAGE);
  return Math.min(
    newest,
    Math.max(from, newest - UNREAD_REACH),
    lastMessage === -1 ? rows.length : lastMessage,
  );
}

// Whether a row is new to a reader: not seen up to `seen`, not their own, not a reply still being
// written.
function isUnread(row: Transcript["rows"][number], seen: number, userId: string) {
  return (
    row.seq > seen &&
    !(row.kind === "human" && row.author.userId === userId) &&
    !(row.kind === "agent" && row.status === "streaming")
  );
}

// The index of the first row the reader had not seen up to `seen` that is new to them; -1 when
// there is none.
function newFromOf({ rows }: Transcript, seen: number, userId: string) {
  return rows.findIndex((row) => isUnread(row, seen, userId));
}

// How many rows before the place `end` are new to the reader, from the row at `from` on.
function unreadBefore({ rows }: Transcript, from: number, end: number, userId: string) {
  if (from < 0 || from >= end) return 0;
  const seen = rows[from]!.seq - 1;
  return rows.slice(from, end).filter((row) => isUnread(row, seen, userId)).length;
}

// A read of one reply's pieces from piece `from` on, begun once `upto` pieces were known stored.
interface PieceRead {
  from: number;
  upto: number;
  batches: Promise<DeltaBatch[]>;
}

export function createThreadViews(options: ThreadViewsOptions) {
  const {
    access,
    threads,
    deltas,
    models,
    signals,
    queue,
    transcripts,
    branches,
    retired,
    needs,
    reads,
    activity,
    tools,
    subagents,
    tasks,
    live: printed,
  } = options;
  const runTrace = options.runTrace ?? (() => undefined);
  const callWaitsFor = needs.waitsFor;
  // The reads of reply pieces made for the streams open on each thread here, by reply: one read
  // serves every stream whose cursor it starts at or before and that was told of no more pieces
  // than it read, and each takes its own pieces from it. Kept while a stream follows the thread.
  const pieceReads = new Map<string, { streams: number; reads: Map<string, PieceRead> }>();
  function followPieces(threadId: string) {
    const followed = pieceReads.get(threadId) ?? { streams: 0, reads: new Map() };
    followed.streams += 1;
    pieceReads.set(threadId, followed);
    const piecesOf = async (messageId: string, from: number, upto: number) => {
      const known = followed.reads.get(messageId);
      if (known && known.from <= from && known.upto >= upto) return known.batches;
      const read: PieceRead = { from, upto, batches: deltas.from(messageId, from) };
      followed.reads.set(messageId, read);
      // A read that failed serves no one after.
      read.batches.catch(() => {
        if (followed.reads.get(messageId) === read) followed.reads.delete(messageId);
      });
      return read.batches;
    };
    const unfollow = () => {
      followed.streams -= 1;
      if (followed.streams === 0) pieceReads.delete(threadId);
    };
    return { piecesOf, unfollow };
  }

  // Whether the principal may still read the thread.
  async function readableThread(principal: AccessReader["principal"], id: string) {
    const thread = await threads.find(id);
    return thread && (await access.can(principal, thread, "read")) ? thread : null;
  }

  // What the person may do in the thread, from what was read of them before it when given.
  async function canIn(
    principal: AccessReader["principal"],
    thread: Thread,
    read?: AccessReader,
  ): Promise<ThreadCan> {
    const may = read ?? (await access.reader(principal, thread));
    return {
      post: may.can("post") && !(await retired(thread)),
      arrange: may.can("arrange"),
      share: may.can("share"),
      move: may.can("move"),
      delete: may.can("delete"),
    };
  }

  // The reader of the branch, the thread's current one when none is named, whose rows are given;
  // from what was read of them before the thread when given, which is then read no more.
  async function pageOf(
    principal: AccessReader["principal"],
    thread: Thread,
    branchId = thread.currentBranchId,
    rows?: readonly TranscriptRow[],
    given?: AccessReader,
  ): Promise<Page> {
    const read = given ?? (await access.reader(principal, thread));
    const { space } = read;
    const can = await canIn(principal, thread, read);
    const viewed = rows ?? (await transcripts.of(thread.id, branchId)).transcript().rows;
    let waiting: Promise<QueuedInput[]> | undefined;
    let presented: Promise<(row: TranscriptToolRow) => CallPresentation> | undefined;
    let waitingCalls: Promise<Map<string, WaitingCall>> | undefined;
    const readables = new Map<string, Promise<Thread | null>>();
    let ownName: Promise<string> | undefined;
    const agentName =
      space && read.settings ? agentNameFrom(space, read.settings) : DEFAULT_AGENT_NAME;
    return {
      principal,
      read,
      userId: principal.userId,
      thread,
      space,
      can,
      agentName,
      names: tools.namesIn(space),
      present: async (row) =>
        (presented ??= tools.present(read, toolRowsOf(viewed))).then((present) => present(row)),
      waitingCalls: async () =>
        (waitingCalls ??= (async () =>
          new Map(
            ((await needs.of(principal, [thread.id])).get(thread.id) ?? []).map((one) => [
              one.call.id,
              one,
            ]),
          ))()),
      folds: new Map(),
      readable: async (id) => {
        const known = readables.get(id) ?? readableThread(principal, id);
        readables.set(id, known);
        return known;
      },
      ownName: async () =>
        (ownName ??= (async () => (await subagents?.find(thread.id))?.name ?? agentName)()),
      history: await branches.historyOf(principal, thread, read, can, branchId, viewed),
      waiting: () => (waiting ??= queue.waiting(thread.id)),
    };
  }

  // The row at `index` as the reader sees it: with its place, the last event that changed it, its
  // turn, for a call what its tool is called, and what they may do from it. A call waiting for a decision says what they may decide,
  // none while it waits on others, under the risk its tool's policy gives it now, with their own
  // connection for a call that would run with it, and nobody else's; one waiting for answers, whether
  // they may give them; and the last row of a run that failed or was stopped, whether they may try
  // it again, which they may while nothing else runs or waits to.
  async function shownRow(
    fold: TranscriptFold,
    transcript: Transcript,
    index: number,
    reader: Page,
  ): Promise<ShownRow> {
    const row = transcript.rows[index]!;
    const actions = rowActions(transcript.rows, index, reader.history.abilities);
    const versions = reader.history.versions.get(row.id);
    const place = {
      order: index,
      seq: fold.changedAt(index),
      turn: fold.turnAt(index),
      ...(actions.length > 0 && { can: actions }),
      ...(versions && { versions }),
    };
    const { space, userId } = reader;
    const current = reader.history.abilities.current;
    if (row.kind === "fork") {
      return { ...row, ...place, linked: !!(await reader.readable(row.from.threadId)) };
    }
    if (row.kind === "tool") {
      const shownBy = await reader.present(row);
      const { subagent } = shownBy;
      const subagentCall = subagent?.needs && (await subagentWaitsOn(subagent.threadId, reader));
      const effects = shownBy.effects ?? [];
      // A call its run is running, or that waits for a decision in it, may move to the background,
      // for whoever can post here.
      const running = row.state === "ready";
      const waitingInRun = row.state === "waiting";
      const movable =
        (running || waitingInRun) &&
        !row.background &&
        transcript.run?.id === row.runId &&
        reader.can.post &&
        !!space &&
        (await tools.movable(row, space));
      const state = row.state === "waiting" ? (await reader.waitingCalls()).get(row.id) : null;
      const { background: _flag, waits: _waits, ...plain } = row;
      const call = {
        ...plain,
        ...(row.state === "waiting" && { waitsFor: state?.waitsFor ?? ("decision" as const) }),
        ...place,
        ...(await reader.names(row)),
        ...shownBy.names,
        ...(movable && { canBackground: true }),
        // The call's card, where it runs in the background or set a timer, schedule or webhook.
        ...(shownBy.work && { work: shownBy.work }),
        ...(subagent && { subagent }),
        ...(subagentCall && { subagentCall }),
        ...(effects.length > 0 && { effects }),
      };
      if (!state || !space || !current) return call;
      const may = state.canAct;
      // Where other agents' messages steered the call, whose words they carried.
      const influence =
        transcript.rows.some((other) => other.kind === "notice") &&
        influenceParts(transcript.rows, await reader.ownName(), reader.agentName);
      const waiting = { ...call, ...(influence && { influence }) };
      if (state.waitsFor === "answer") return { ...waiting, canAnswer: may };
      const { risk } = state;
      const connection = await tools.connectionFor(space, row.toolId, userId, row.input);
      const forNow = risk === "normal" ? (["allow_for_now"] as const) : [];
      return {
        ...waiting,
        risk,
        actions: may ? ["allow", ...forNow, "deny"] : [],
        ...(connection && { connection }),
      };
    }
    if (row.kind === "failure" || row.kind === "stop") {
      const last = index === transcript.rows.length - 1;
      const idle =
        !transcript.run && !(await reader.waiting()).some((input) => input.kind === "message");
      return { ...row, ...place, canRetry: current && last && idle && reader.can.post };
    }
    if (row.kind === "human") {
      const { command, ...message } = row;
      return { ...message, ...place, ...shownCommand(command) };
    }
    if (row.kind === "notice") return shownNotice(row, reader, place);
    if (row.kind === "limit") {
      const { call: _call, ...limit } = row;
      const sentBy = await sentByOf(row, reader);
      return { ...limit, ...place, ...(sentBy && { sentBy }) };
    }
    return { ...row, ...place };
  }

  // A notification as the reader sees it: named as people know things, and linking back to where
  // it came from in the threads they may read.
  async function shownNotice(
    row: NoticeRow,
    reader: Page,
    place: Pick<ShownRow, "order" | "seq" | "turn" | "can" | "versions">,
  ) {
    const { influence: _influence, call: _call, rowId, ...message } = row;
    // A change of model names each model as people know it, in place of its ref.
    if (message.change?.action === "model" && reader.space) {
      const label = await models.modelLabels(reader.space.orgId);
      const { from, to } = message.change;
      message.change = {
        ...message.change,
        ...(from && { from: (await label(from)) ?? from }),
        ...(to && { to: (await label(to)) ?? to }),
      };
    }
    const sentBy = await sentByOf(row, reader);
    const source =
      rowId && (await reader.readable(row.from.threadId))
        ? { threadId: row.from.threadId, rowId }
        : null;
    const ran = await completedOf(row, reader);
    return {
      ...message,
      ...place,
      ...(sentBy && { sentBy }),
      ...(source && { source }),
      ...(ran && { ran }),
    };
  }

  // Everything waiting for the agent to take it in, oldest first, as rows after the transcript's
  // last: each is what the reader will see once it is taken in, marked as waiting, with what they
  // may still do with it. A person's message is its author's to change: to reword unless it was
  // sent as a command, to switch between steering and queueing unless it interrupts, and to take
  // back; a notification is nobody's to change. The fold keeps people's messages and other
  // agents' notifications apart; a new kind of input is one more branch here.
  async function shownWaiting(transcript: Transcript, reader: Page): Promise<WaitingRow[]> {
    const inputs = (await reader.waiting()).flatMap(
      (
        input,
      ): ({ seq: number; message: PendingMessage } | { seq: number; notice: NoticeMessage })[] =>
        input.message
          ? [{ seq: input.seq, message: input.message }]
          : input.notice && input.wake
            ? [{ seq: input.seq, notice: input.notice }]
            : [],
    );
    return await Promise.all(
      inputs.map(async (input, index): Promise<WaitingRow> => {
        const place = { order: transcript.rows.length + index, seq: input.seq, turn: null };
        if ("notice" in input) {
          return {
            ...(await shownNotice({ kind: "notice", ...input.notice }, reader, place)),
            waiting: { can: [] },
          };
        }
        const { mode, command, ...message } = input.message;
        const mine = message.author.userId === reader.userId && reader.can.post;
        const can: WaitingAction[] = mine
          ? [
              ...(command ? [] : ["edit" as const]),
              ...(mode === "interrupt" ? [] : ["mode" as const]),
              "remove",
            ]
          : [];
        return {
          kind: "human",
          ...message,
          ...place,
          quiet: false,
          ...shownCommand(command),
          waiting: { mode, can },
        };
      }),
    );
  }

  // The background call a notification tells ended, as the reader may read it where it was made.
  async function completedOf(row: NoticeRow, reader: Page) {
    const call = row.call;
    if (row.type !== "call.ended" || !call) return null;
    const thread = await reader.readable(call.threadId);
    if (!thread) return null;
    const fold = reader.folds.get(thread.id) ?? (await transcripts.of(thread.id));
    reader.folds.set(thread.id, fold);
    const ran = fold.transcript().rows[fold.indexOf(call.callId)];
    if (ran?.kind !== "tool") return null;
    const { background: _flag, waits: _waits, ...plain } = ran;
    return { ...plain, ...(await reader.names(ran)) };
  }

  // The call that sent another agent's message, or that was refused past the limit, as the reader
  // may follow it back: in a thread they may read, named as its line there is.
  async function sentByOf(row: NoticeRow | LimitRow, reader: Page) {
    const call = row.call;
    const thread = call && (await reader.readable(call.threadId));
    if (!call || !thread) return null;
    const fold = reader.folds.get(thread.id) ?? (await transcripts.of(thread.id));
    reader.folds.set(thread.id, fold);
    const sending = fold.transcript().rows[fold.indexOf(call.callId)];
    if (sending?.kind !== "tool") return null;
    const { title, toolset } = await reader.names(sending);
    return {
      threadId: thread.id,
      rowId: sending.id,
      title,
      toolset,
      thread: (await subagents?.find(thread.id))?.name ?? thread.title ?? UNTITLED,
    };
  }

  // The call the subagent's run waits on, as the reader sees it in the subagent's thread.
  async function subagentWaitsOn(threadId: string, reader: Page) {
    const thread = await threads.find(threadId);
    if (!thread) return null;
    const fold = await transcripts.of(threadId);
    const transcript = fold.transcript();
    const index = transcript.rows.findIndex((row) => row.id === transcript.run?.waitingOn);
    if (index === -1) return null;
    // Read as the starter's reader, whose access to it is the starter's.
    const read = { ...reader.read, thread };
    const page = await pageOf(reader.principal, thread, undefined, transcript.rows, read);
    const shown = await shownRow(fold, transcript, index, page);
    return shown.kind === "tool" && shown.state === "waiting" ? shown : null;
  }

  // The thread as the reader sees it, without its rows: what they may do in it, the defaults it
  // follows, and the model it names and the one that replies, which differ while the one it names
  // is turned off.
  async function headOf(
    principal: AccessReader["principal"],
    thread: Thread,
    read: AccessReader & { via: Access },
  ): Promise<ThreadHead> {
    const { space, via } = read;
    // The thread's own org decides, whoever reads it; its models are read once for all three.
    const org = space && (await models.inOrg(space.orgId, read.settings ?? undefined));
    const defaults = space && org ? org.defaults(space) : { model: null, effort: null };
    // The default that replies, with its effort.
    const following = space && (await org!.replyModel(space, { model: null, effort: null }));
    const used = following?.used ? { used: following.used, effort: following.effort } : null;
    const subagent = await subagentOf(principal, thread, read);
    // How they come to the thread was read in its space's org when that is theirs.
    const sameOrg = !!space && principal.orgId === space.orgId;
    const shown =
      space && (await tools.shownTo(principal.userId, thread, space, sameOrg ? via : undefined));
    return {
      ...(subagent && { subagent }),
      agentName: space && read.settings ? agentNameFrom(space, read.settings) : DEFAULT_AGENT_NAME,
      thread: threadSummary(thread),
      access: via,
      archived: !!space?.archived,
      can: await canIn(principal, thread, read),
      levels: shown?.levels ?? {},
      tools: shown?.definitions ?? [],
      defaults: { ...defaults, used: used && { ...used.used, effort: used.effort } },
      model: space
        ? await org!.replyModel(space, { model: thread.model, effort: thread.effort })
        : null,
    };
  }

  // For a subagent's thread, the subagent as it is now and the thread that started it.
  async function subagentOf(
    principal: AccessReader["principal"],
    thread: Thread,
    read: AccessReader,
  ) {
    const summary = thread.parentThreadId ? await subagents?.summaryOf(thread.id) : null;
    if (!summary) return null;
    const parent = await threads.find(thread.parentThreadId!);
    return {
      ...summary,
      parent: { id: thread.parentThreadId!, title: parent?.title ?? UNTITLED },
      canUnarchive: summary.state === "archived" && read.can("post"),
    };
  }

  return {
    // The thread as the reader sees it, with its newest rows, reaching back to the first they had
    // not seen, the messages waiting for the agent and the run under way.
    // Another branch, named, reads the same way, with nothing new in it and nothing waiting.
    async detail(read: AccessReader & { via: Access }, branchId?: string): Promise<ThreadDetail> {
      const { thread, principal } = read;
      const id = thread.id;
      const head = await headOf(principal, thread, read);
      // Read after the models, which wait on providers, so the rows are the newest.
      const latest = (await threads.find(id)) ?? thread;
      const branch = await branches.branchIn(latest, branchId);
      const current = branch === latest.currentBranchId;
      const fold = await transcripts.of(id, branch);
      const transcript = fold.transcript();
      const reader = await pageOf(principal, latest, branch, transcript.rows, read);
      const seen = (await reads.seen(principal.userId, [id])).get(id) ?? 0;
      // A subagent's thread has nothing new in it, and opens at its newest.
      const from =
        thread.parentThreadId || !current ? -1 : newFromOf(transcript, seen, principal.userId);
      const total = transcript.rows.length;
      const start = pageStart(transcript, from === -1 ? total : from);
      const rows = [];
      for (let index = start; index < total; index++) {
        rows.push(await shownRow(fold, transcript, index, reader));
      }
      return {
        ...head,
        thread: { ...head.thread, lastEventSeq: Math.max(head.thread.lastEventSeq, fold.last) },
        branch: { id: branch, current },
        rows,
        before: start > 0 ? start : null,
        newFrom: from === -1 ? null : transcript.rows[from]!.id,
        earlierUnread: unreadBefore(transcript, from, start, principal.userId),
        waiting: current ? await shownWaiting(transcript, reader) : [],
        run: await shownRun(transcript, thread.id, runTrace, callWaitsFor),
      };
    },

    // The thread as the reader sees it, without its rows.
    async head(read: AccessReader & { via: Access }): Promise<ThreadHead> {
      return headOf(read.principal, read.thread, read);
    },

    // The rows before the place `before`, at most `limit` of them, or with `at` as many as reach
    // back to the row with that id when it is before them, as the reader sees them; of the branch
    // named, or else the current one. With `unreadFrom`, the row a read opened at, how many rows
    // before the page are still new to the reader.
    async rows(
      read: AccessReader,
      page: {
        before: number;
        limit?: number;
        at?: string;
        branchId?: string;
        unreadFrom?: string;
      },
    ): Promise<RowsPage> {
      const { thread, principal } = read;
      const { before, limit = ROWS_PAGE, at, branchId, unreadFrom } = page;
      const id = thread.id;
      const branch = await branches.branchIn(thread, branchId);
      const fold = await transcripts.of(id, branch);
      const transcript = fold.transcript();
      const reader = await pageOf(principal, thread, branch, transcript.rows, read);
      const end = Math.min(before, transcript.rows.length);
      const target = at === undefined ? -1 : fold.indexOf(at);
      const start = Math.max(0, Math.min(end - limit, target === -1 ? end : target));
      const rows = [];
      for (let index = start; index < end; index++) {
        rows.push(await shownRow(fold, transcript, index, reader));
      }
      const from = unreadFrom === undefined ? -1 : fold.indexOf(unreadFrom);
      return {
        rows,
        before: start > 0 ? start : null,
        earlierUnread: unreadBefore(transcript, from, start, principal.userId),
      };
    },

    // Delivers, as the reader sees them, the rows events with seq above `after` changed, then the
    // pieces stored so far of the replies in progress and of the output of the calls running, then
    // the rows each new event changes and each piece as it is stored, each exactly once. With the
    // rows go the waiting messages and the run, and any row whose parts that are the reader's
    // changed while the row did not, as when someone else writes and a call can no longer be
    // allowed for now. The thread itself is delivered as the stream opens after events the reader
    // has not seen, and again once it is renamed, moved or set to another model. Listening starts
    // before the stored ones are read, so none falls between the two. Returns the function that
    // stops it once the reader may read the thread and listening has started.
    async follow(
      principal: Principal,
      id: string,
      after: number,
      deliver: (item: ThreadFollowItem | "ended") => void,
    ): Promise<{ stop: () => void; recheck: (full: boolean) => Promise<void> }> {
      const first = (await access.require(principal, id)).thread;
      const release = transcripts.hold(id);
      const shared = followPieces(id);
      let stopped = false;
      let last = after;
      // The reader's parts of each live row as last delivered, by row id.
      const told = new Map<string, string>();
      // The next piece number to send, by reply.
      const pieces = new Map<string, number>();
      // How far each running call's output was sent, by call.
      const outputs = new Map<string, number>();
      // What is delivered is worked out one thing at a time, in the order it was asked for, so
      // that what two changes at once bring is neither sent twice nor out of order.
      let turn: Promise<void> = Promise.resolve();
      function inTurn(work: () => Promise<void>) {
        const done = turn.then(async () => {
          if (!stopped) await work();
        });
        turn = done.catch(() => {});
        return done;
      }
      // A refusal, as of a reader who may no longer read the thread, ends that delivery alone; any
      // other failure, as of the database, is kept for the next recheck to throw, so the stream
      // fails and the browser connects again rather than being told its access ended.
      let failed: unknown;
      const later = (work: () => Promise<void>) =>
        void inTurn(work).catch((err: unknown) => {
          if (!(err instanceof ServiceError)) failed ??= err;
        });
      // The branch followed, and what the reader could do from each row and its versions as last
      // delivered.
      let branch = first.currentBranchId;
      const able = new Map<string, string>();
      const ableOf = (shown: { can?: readonly string[]; versions?: RowVersions }) =>
        JSON.stringify([shown.can ?? [], shown.versions ?? null]);
      // Each part is told to `to`; a delivery's parts share what the access rule read of the
      // reader, when given.
      async function sendRows(
        given?: AccessReader,
        to: (item: ThreadFollowItem) => void = deliver,
      ) {
        const read = given ?? (await readerNow());
        if (!read) return end();
        const thread = await threads.find(id);
        if (!thread) return;
        const fold = await transcripts.of(id);
        const transcript = fold.transcript();
        const reader = await pageOf(
          principal,
          thread,
          thread.currentBranchId,
          transcript.rows,
          read && { ...read, thread },
        );
        const run = await shownRun(transcript, thread.id, runTrace, callWaitsFor);
        const waiting = await shownWaiting(transcript, reader);
        // Another branch made current starts afresh from its newest rows.
        if (thread.currentBranchId !== branch) {
          branch = thread.currentBranchId;
          told.clear();
          able.clear();
          const total = transcript.rows.length;
          const start = pageStart(transcript, total);
          const rows: ShownRow[] = [];
          for (let index = start; index < total; index++) {
            const shown = await shownRow(fold, transcript, index, reader);
            able.set(shown.id, ableOf(shown));
            rows.push(shown);
          }
          last = fold.last;
          to({
            kind: "rows",
            update: {
              seq: last,
              rows,
              waiting,
              run,
              reset: { branch: { id: branch, current: true }, before: start > 0 ? start : null },
            },
          });
          return;
        }
        const live = await liveIndexes(transcript, reader);
        const rows: ShownRow[] = [];
        for (const [index, row] of transcript.rows.entries()) {
          const changed = fold.changedAt(index) > last;
          // What the reader may do from a row, and its versions, change as rows come after it.
          const actions = ableOf({
            can: rowActions(transcript.rows, index, reader.history.abilities),
            versions: reader.history.versions.get(row.id),
          });
          const unable = able.has(row.id) && able.get(row.id) !== actions;
          able.set(row.id, actions);
          if (!changed && !unable && !live.has(index) && !told.has(row.id)) continue;
          const shown = await shownRow(fold, transcript, index, reader);
          const parts = readerPartsOf(shown);
          if (changed || unable || told.get(row.id) !== parts) rows.push(shown);
          if (live.has(index)) told.set(row.id, parts);
          else told.delete(row.id);
        }
        if (fold.last <= last && rows.length === 0) return;
        last = Math.max(last, fold.last);
        to({ kind: "rows", update: { seq: last, rows, waiting, run } });
      }
      // What was sent already is skipped; a piece wholly sent still tells the progress.
      function sendOutput(chunk: LiveChunk, to: (item: ThreadFollowItem) => void = deliver) {
        const known = Math.max(0, (outputs.get(chunk.callId) ?? 0) - chunk.offset);
        const text = chunk.text.slice(known);
        if (!text && !chunk.progress) return;
        outputs.set(
          chunk.callId,
          Math.max(outputs.get(chunk.callId) ?? 0, chunk.offset + chunk.text.length),
        );
        to({ kind: "live", live: { ...chunk, offset: chunk.offset + known, text } });
      }
      function sendDelta(delta: DeltaBatch, to: (item: ThreadFollowItem) => void = deliver) {
        const { messageId, index, texts } = delta;
        const sent = Math.max(0, (pieces.get(messageId) ?? 0) - index);
        if (sent >= texts.length) return;
        pieces.set(messageId, index + texts.length);
        to({
          kind: "delta",
          delta: { ...delta, index: index + sent, texts: texts.slice(sent) },
        });
      }
      // A hint is read from where what it tells of is kept; hints of what was read already cost
      // nothing.
      async function send(hint: ThreadHint) {
        if (hint.kind === "event") {
          const read = await readerNow();
          if (!read) return end();
          if (hint.seq > last) await sendRows(read);
          await sendBackground(false, read);
          return;
        }
        // Reply pieces and call output are told only to a reader who may still read the thread,
        // checked once for each delivery of them.
        if (hint.kind === "live") {
          const chunk = await printed?.tail(hint.callId);
          if (!chunk) return;
          if (!(await readerNow())) return end();
          sendOutput(chunk);
          return;
        }
        const cursor = pieces.get(hint.messageId) ?? 0;
        if (cursor >= hint.upto) return;
        if (!(await readerNow())) return end();
        for (const delta of await shared.piecesOf(hint.messageId, cursor, hint.upto)) {
          sendDelta(delta);
        }
      }
      // After a gap in what this instance heard, all of it is read again.
      async function catchUp() {
        const read = await readerNow();
        if (!read) return end();
        await sendRows(read);
        for (const delta of await deltas.inThread(id)) sendDelta(delta);
        for (const chunk of (await printed?.inThread(id)) ?? []) sendOutput(chunk);
        await sendBackground(false, read);
        await sendTasks(false, deliver, read);
      }
      // What the access rule reads of the reader now; none once they may no longer read it.
      const readerNow = async () =>
        access.require(principal, id).catch((err: unknown) => {
          if (err instanceof ServiceError) return undefined;
          throw err;
        });
      // What the thread was named, set to and where it was, as last delivered.
      const placeOf = async (thread: Thread) =>
        JSON.stringify([
          thread.title,
          thread.model,
          thread.effort,
          thread.spaceId,
          thread.parentThreadId && (await subagents?.summaryOf(thread.id)),
        ]);
      let place = "";
      const unsubscribe = signals.subscribe(id, (hint) => later(() => send(hint)));
      const stopGap = signals.onGap(() => later(catchUp));
      // The subagents started here, each of which shows where it stands on the line that started
      // it; a start writes here, so they are read again when this thread changes.
      const subagentsOf = async () =>
        new Set((await threads.children(id)).map((child) => child.id));
      let started = new Set<string>();
      const stopActivity = signals.onChanged((change) => {
        if (change.read || change.gone || change.tasks || change.activity) return;
        later(async () => {
          if (change.rows) {
            if (change.threadId === id) await sendRows();
            return;
          }
          if (change.threadId !== id) {
            if (started.has(change.threadId)) await sendRows();
            return;
          }
          started = await subagentsOf();
          const thread = await threads.find(id);
          if (thread && thread.currentBranchId !== branch) await sendRows();
          if (!thread) return;
          const now = await placeOf(thread);
          if (now === place) return;
          place = now;
          await sendHead(thread);
        });
      });
      async function sendHead(thread: Thread) {
        const read = await access.of(principal, thread);
        if (!read?.via) return;
        const head = await headOf(principal, thread, { ...read, via: read.via });
        if (!stopped) deliver({ kind: "thread", head });
      }
      // The thread's task list, told again whenever it differs from what was last told.
      let toldTasks = "";
      async function sendTasks(
        first = false,
        to: (item: ThreadFollowItem) => void = deliver,
        given?: AccessReader,
      ) {
        if (!tasks) return;
        const read = given ?? (await readerNow());
        if (!read) return end();
        try {
          const list = await tasks.listFor(principal, id, false, read);
          const text = JSON.stringify(list);
          if (text === toldTasks) return;
          toldTasks = text;
          // An empty list is what the page read already.
          if (!first || list.tasks.length > 0) to({ kind: "tasks", list });
        } catch (err) {
          // The reader may no longer read the thread, which the stream says on its own.
          if (!(err instanceof ServiceError)) throw err;
        }
      }
      // The thread's live background work, told again whenever it differs from what was last told.
      let toldBackground = "";
      async function sendBackground(
        first = false,
        given?: Awaited<ReturnType<typeof readerNow>>,
        to: (item: ThreadFollowItem) => void = deliver,
      ) {
        const read = given ?? (await readerNow());
        if (!read) return end();
        try {
          const list = await activity.of(read);
          const text = JSON.stringify(list);
          if (text === toldBackground) return;
          toldBackground = text;
          // An empty list is what the page read already.
          if (!first || list.items.length > 0) to({ kind: "activity", list });
        } catch (err) {
          // The reader may no longer read the thread, which the stream says on its own.
          if (!(err instanceof ServiceError)) throw err;
        }
      }
      // A subagent changing where it stands changes its starter's dock.
      const stopBackground = signals.onChanged((change) => {
        if (stopped || change.read || change.gone) return;
        // Tasks given to the subagents here count on their lines.
        if (change.tasks && change.threadId !== id) return;
        later(async () => {
          if (change.threadId !== id && !started.has(change.threadId)) return;
          await sendBackground();
        });
      });
      const stopTasks = signals.onChanged((change) => {
        if (!change.tasks || stopped) return;
        later(async () => {
          if (change.threadId === (await tasks?.ownerOf(id))) await sendTasks();
        });
      });
      // What is stored comes first; what the listeners above hear meanwhile waits its turn. It is
      // read after this returns, so the caller can stop it while it is read.
      later(async () => {
        place = await placeOf(first);
        started = await subagentsOf();
        // Its parts are read together, and told in this order: tasks, rows, reply pieces, call
        // output, tray.
        const read = await readerNow();
        if (!read) return end();
        const parts: ThreadFollowItem[][] = [[], [], [], [], []];
        const into = (part: number) => (item: ThreadFollowItem) => void parts[part]!.push(item);
        await Promise.all([
          sendTasks(true, into(0), read),
          sendRows(read, into(1)),
          (async () => {
            for (const delta of await deltas.inThread(id)) sendDelta(delta, into(2));
          })(),
          (async () => {
            for (const chunk of (await printed?.inThread(id)) ?? []) sendOutput(chunk, into(3));
          })(),
          sendBackground(true, read, into(4)),
        ]);
        for (const item of parts.flat()) if (!stopped) deliver(item);
        // The thread may have been renamed or set to another model since the reader's page read
        // it, which no later change would tell them; each of those leaves an event.
        if (first.lastEventSeq > after) await sendHead(first);
      });
      function stop() {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        stopGap();
        stopActivity();
        stopTasks();
        stopBackground();
        release();
        shared.unfollow();
      }
      // A delivery whose reader may no longer read the thread ends the stream there.
      function end() {
        if (stopped) return;
        stop();
        deliver("ended");
      }
      return {
        stop,
        // Reads the thread again without a hint: its rows when the log grew past what was sent or
        // another branch is current, and in full also everything else it shows, as after a gap.
        async recheck(full: boolean) {
          await inTurn(async () => {
            if (failed) throw failed;
            const read = await readerNow();
            if (!read) return end();
            const { thread } = read;
            if (thread.lastEventSeq > last || thread.currentBranchId !== branch) {
              await sendRows(read);
            }
            if (!full) return;
            for (const delta of await deltas.inThread(id)) sendDelta(delta);
            for (const chunk of (await printed?.inThread(id)) ?? []) sendOutput(chunk);
            await sendBackground(false, read);
            await sendTasks(false, deliver, read);
            const now = await placeOf(thread);
            if (now === place) return;
            place = now;
            await sendHead(thread);
          }).catch((err: unknown) => {
            if (!(err instanceof ServiceError)) throw err;
          });
        },
      };
    },
  };
}

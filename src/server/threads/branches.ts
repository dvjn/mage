// A thread's branches as people act on them: which branch holds a row, what a reader may do from
// each row of a branch and which rows have versions, and the actions that make a new current
// branch from a row: writing a reply again, sending one's own message again changed, or restoring
// the conversation up to it, each stopping the run under way in the branch before.

import { findAsync } from "@/server/kernel/async.ts";
import type { Reader as AccessReader, ThreadAccess } from "@/server/access/access.ts";
import type { Execution } from "@/server/execution/execution.ts";
import type { Tools } from "@/server/tools/registry.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Models } from "@/server/models/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Queue, QueuedInput } from "@/server/queue/queue.ts";
import type { Space } from "@/server/spaces/service.ts";
import type { Signals } from "@/server/sync/signals.ts";
import type { ThreadCan } from "@/shared/threads/detail.ts";
import type { BranchAction, BranchActionResult, ShownBranch } from "@/shared/threads/history.ts";
import type { RowVersions } from "@/shared/threads/rows.ts";
import type { ToolRow, TranscriptRow } from "@/shared/transcript.ts";

import {
  type Abilities,
  changedSomething,
  cutBefore,
  cutThrough,
  dropped,
  othersPast,
  rowActions,
  type Source,
  versionsOf,
} from "./history.ts";
import type { Append, ThreadLog } from "./log.ts";
import type { Transcripts } from "./transcripts.ts";
import type { Thread, ThreadStore } from "./types.ts";

export interface BranchesOptions {
  threads: Pick<
    ThreadStore,
    "find" | "branch" | "branches" | "sources" | "eventAt" | "addBranch" | "setCurrent"
  >;
  transcripts: Pick<Transcripts, "of">;
  access: Pick<ThreadAccess, "require" | "reader">;
  log: ThreadLog;
  queue: Pick<Queue, "enqueue" | "admission">;
  // Where the run under way in the branch before is stopped, and the new branch's run started.
  execution: Pick<Execution, "stop" | "rewrite">;
  models: Pick<Models, "requireModel">;
  // The tools, for the calls a new branch would leave out as the reader sees them named.
  tools: Pick<Tools, "definitions" | "namesIn">;
  // Whether the thread is a retired subagent's, which nobody posts in.
  retired: (thread: Thread) => Promise<boolean>;
  signals: Pick<Signals, "wake">;
}

// The branch read, what the reader may do from its rows and which of them have versions.
export interface BranchHistory {
  branchId: string;
  abilities: Abilities;
  versions: Map<string, RowVersions>;
}

export type Branches = ReturnType<typeof createBranches>;

export function createBranches(options: BranchesOptions) {
  const { threads, transcripts, access, log, queue, execution, models, tools, retired, signals } =
    options;

  // The thread's branch with the id, or its current one when none is named.
  async function branchIn(thread: Thread, branchId?: string) {
    if (!branchId || branchId === thread.currentBranchId) return thread.currentBranchId;
    if ((await threads.branch(branchId))?.threadId !== thread.id) {
      throw new ServiceError(404, "Branch not found");
    }
    return branchId;
  }

  // The versions of the rows of the branch written again, and the first row of the versions each
  // belongs to. Each branch's own first row is read from its log.
  async function versionsIn(thread: Thread, branchId: string, rows: readonly TranscriptRow[]) {
    const branches = await threads.branches(thread.id);
    if (branches.length < 2)
      return { versions: new Map<string, RowVersions>(), groupOf: new Map() };
    const sources = new Map<string, readonly Source[]>();
    return versionsOf({
      viewed: branchId,
      current: thread.currentBranchId,
      branches,
      rows,
      sourcesOf: async (id) => {
        const known = sources.get(id) ?? (await threads.sources(id));
        sources.set(id, known);
        return known;
      },
      firstOf: async (branch) => {
        const after = branch.forkSeq ?? 0;
        const own = (await transcripts.of(thread.id, branch.id))
          .transcript()
          .rows.find((row) => row.seq > after);
        return own ? { id: own.id, seq: own.seq } : null;
      },
      originOf: async (branch, rowId) => {
        const fold = await transcripts.of(thread.id, branch);
        const row = fold.transcript().rows[fold.indexOf(rowId)];
        const owner = row && (await threads.eventAt(thread.id, row.seq))?.branchId;
        return row && owner ? { owner, seq: row.seq } : null;
      },
    });
  }

  // What the reader may do from the rows of the branch, and the versions among them.
  async function historyOf(
    principal: Pick<Principal, "userId">,
    thread: Thread,
    read: AccessReader,
    can: Pick<ThreadCan, "post">,
    branchId: string,
    rows: readonly TranscriptRow[],
  ): Promise<BranchHistory> {
    const current = branchId === thread.currentBranchId;
    const currentRows = current ? rows : (await transcripts.of(thread.id)).transcript().rows;
    const guest = read.via?.via === "guest";
    const archived = !!read.space?.archived;
    return {
      branchId,
      abilities: {
        userId: principal.userId,
        current,
        post: can.post && !archived,
        rewrite: read.can("rewrite"),
        fork:
          !guest &&
          !thread.parentThreadId &&
          !!read.space &&
          read.canInSpace("message") &&
          !archived,
        othersPast: othersPast(currentRows, rows, principal.userId),
      },
      versions: (await versionsIn(thread, branchId, rows)).versions,
    };
  }

  // What the reader may do from the rows of the branch, read of them afresh.
  async function abilitiesIn(
    principal: Principal,
    thread: Thread,
    branchId: string,
    rows: readonly TranscriptRow[],
  ) {
    const read = await access.reader(principal, thread);
    const post = read.can("post") && !(await retired(thread));
    return (await historyOf(principal, thread, read, { post }, branchId, rows)).abilities;
  }

  // The calls among the rows that changed something, as the reader sees them named.
  async function undoneIn(left: readonly TranscriptRow[], space: Space | null) {
    const definitions = space ? await tools.definitions(space) : [];
    const names = tools.namesIn(space);
    return await Promise.all(
      left
        .filter((row): row is ToolRow => changedSomething(row, definitions))
        .map(async (row) => {
          const { title, toolset } = await names(row);
          return { title, toolset };
        }),
    );
  }

  return {
    branchIn,
    versionsIn,
    historyOf,
    abilitiesIn,

    // The branch that holds the row: the current one when it does, else the newest that does.
    async branchOf(principal: Principal, id: string, rowId: string): Promise<ShownBranch> {
      const { thread } = await access.require(principal, id);
      if ((await transcripts.of(id)).indexOf(rowId) !== -1) {
        return { id: thread.currentBranchId, current: true };
      }
      const newestFirst = (await threads.branches(id))
        .filter((branch) => branch.id !== thread.currentBranchId)
        .toSorted(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
        );
      const holder = await findAsync(
        newestFirst,
        async (branch) => (await transcripts.of(id, branch.id)).indexOf(rowId) !== -1,
      );
      if (!holder) throw new ServiceError(404, "Message not found");
      return { id: holder.id, current: false };
    },

    // Writes a reply again, with the thread's model or another; sends the reader's own message
    // again changed; or restores the conversation up to a row of any branch. Each makes a new
    // current branch, and the run under way in the branch before is asked to stop. What the
    // reader may do from the row is the rule; one that would leave out tool calls that changed
    // something lists them instead, until confirmed.
    async act(principal: Principal, id: string, action: BranchAction): Promise<BranchActionResult> {
      const asked = action.action === "retry" ? action.with : undefined;
      if (asked) await models.requireModel(principal.orgId, asked.model);
      // Seen again after the model check, which waits on providers.
      const read = await access.require(principal, id, "post");
      const { thread } = read;
      if (await retired(thread)) throw new ServiceError(409, "This subagent is archived");
      const from = await branchIn(
        thread,
        action.action === "restore" ? action.branchId : undefined,
      );
      const fold = await transcripts.of(id, from);
      const { rows } = fold.transcript();
      const index = fold.indexOf(action.rowId);
      const row = rows[index];
      if (!row) throw new ServiceError(404, "Message not found");
      const { abilities } = await historyOf(
        principal,
        thread,
        read,
        { post: read.can("post") },
        from,
        rows,
      );
      if (!rowActions(rows, index, abilities).includes(action.action)) {
        const editor = { ...abilities, rewrite: true };
        throw rowActions(rows, index, editor).includes(action.action)
          ? new ServiceError(403, "Only the space's owners can leave out other people's messages")
          : new ServiceError(409, "This can't be done from this message");
      }
      const restore = action.action === "restore";
      const forkSeq = restore ? cutThrough(fold, index) : cutBefore(rows, index);
      const currentRows =
        from === thread.currentBranchId ? rows : (await transcripts.of(id)).transcript().rows;
      const left = dropped(currentRows, restore ? rows.slice(0, index + 1) : rows.slice(0, index));
      const undone = await undoneIn(left, read.space);
      if (undone.length > 0 && !action.confirm) return { confirm: undone };
      // The row the new branch goes on in place of: this one, or once restored, the message or
      // restore line after it.
      const replaced = restore
        ? rows
            .slice(index + 1)
            .find((r) => r.kind === "human" || r.kind === "agent" || r.kind === "restore")
        : row;
      const group =
        replaced &&
        ((await versionsIn(thread, from, rows)).groupOf.get(replaced.id) ?? replaced.id);
      // Messages taken in with an edited one still wait for the run that takes in the new one.
      const keep =
        action.action === "edit"
          ? rows.filter((r) => r.kind === "human" && r.seq === row.seq && r.id !== row.id)
          : [];
      const guest = read.via?.via === "guest";
      const actor = { kind: "user" as const, userId: principal.userId };
      const branch = (
        await log.write(id, async (append) => {
          const before = (await threads.find(id))?.currentBranchId ?? thread.currentBranchId;
          const made = await threads.addBranch({
            threadId: id,
            parentBranchId: from,
            forkSeq,
            kind: action.action,
            rowId: row.id,
            groupRowId: group ?? null,
            createdBy: principal.userId,
          });
          const into: Append = async (event, title) => append(event, title, made.id);
          await into({
            type: "branch.started",
            actor,
            data: {
              kind: action.action,
              rowId: row.id,
              ...(keep.length > 0 && { keep: keep.map((message) => message.id) }),
            },
          });
          await threads.setCurrent(id, made.id);
          await queue.admission.branched(id, made.id, before);
          await execution.stop({ branchId: before }, principal.userId);
          let edited: QueuedInput | null = null;
          if (action.action === "edit") {
            const quiet = row.kind === "human" && row.quiet;
            // The run below takes the message in, so it starts nothing itself.
            const { event, input } = await queue.enqueue(
              id,
              {
                kind: "message",
                by: principal.userId,
                text: action.text,
                delivery: "steer",
                quiet,
                ...(guest && { guest }),
              },
              {
                origin: { kind: "person", id: principal.userId },
                branchId: made.id,
                quietly: true,
              },
            );
            if (!input) return made.id;
            edited = { ...input, seq: event.seq };
          }
          if (restore) return made.id;
          await execution.rewrite(id, made.id, {
            by: principal.userId,
            wokenBySeq: forkSeq,
            keep: keep.map((message) => message.id),
            message: edited,
            asked: asked ? { model: asked.model, effort: asked.effort ?? null } : null,
          });
          return made.id;
        })
      ).result;
      signals.wake(id);
      return { branchId: branch };
    },
  };
}

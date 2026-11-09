// Claims and lease checks are single conditional statements, so two workers never both hold a run.

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { thread } from "@/server/threads/schema.ts";
import type { Db } from "@/server/db/db.ts";

import { type Lease, LeaseLost, type Run, type RunStore } from "./runs.ts";
import { run, threadTool } from "./schema.ts";

const columns = {
  id: run.id,
  threadId: run.threadId,
  branchId: sql<string>`coalesce(${run.branchId}, ${run.threadId})`,
  status: run.status,
  triggerSeq: run.triggerSeq,
  model: run.model,
  askedModel: run.askedModel,
  askedEffort: run.askedEffort,
  continuesRunId: run.continuesRunId,
  reason: run.reason,
  createdBy: run.createdBy,
  attempt: run.attempt,
  cancelRequestedAt: run.cancelRequestedAt,
  cancelRequestedBy: run.cancelRequestedBy,
  leaseOwner: run.leaseOwner,
  leaseExpiresAt: run.leaseExpiresAt,
  leaseEpoch: run.leaseEpoch,
  error: run.error,
  errorKind: run.errorKind,
  errorDetail: run.errorDetail,
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
};

const ACTIVE = ["queued", "running", "waiting"] as const;

// Whether the run is in its thread's current branch, with the thread joined.
const inCurrent = sql`${run.branchId} = coalesce(${thread.currentBranchId}, ${thread.id})`;

export function createRunStore(db: Db): RunStore {
  function held(lease: Lease) {
    return and(
      eq(run.id, lease.runId),
      eq(run.leaseOwner, lease.owner),
      eq(run.leaseEpoch, lease.epoch),
      eq(run.status, "running"),
    );
  }

  function staleWhere(before?: Date) {
    return and(eq(run.status, "running"), before ? lt(run.leaseExpiresAt, before) : undefined);
  }

  function take(owner: string, expiresAt: Date) {
    return {
      status: "running" as const,
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      leaseEpoch: sql`${run.leaseEpoch} + 1`,
      startedAt: sql`coalesce(${run.startedAt}, ${Date.now()})`,
      updatedAt: new Date(),
    };
  }

  // The branch the thread's people see, as SQL.
  const currentOf = (threadId: string) =>
    sql`(select coalesce(${thread.currentBranchId}, ${thread.id}) from ${thread} where ${thread.id} = ${threadId})`;

  function activeOn(branchId: string | ReturnType<typeof sql>) {
    return (
      db
        .select(columns)
        .from(run)
        .where(and(eq(run.branchId, branchId), inArray(run.status, ACTIVE)))
        .get() ?? null
    );
  }

  function active(threadId: string) {
    return activeOn(currentOf(threadId));
  }

  function requestCancelWhere(where: ReturnType<typeof and>, userId: string | null, at: Date) {
    db.update(run)
      .set({ cancelRequestedAt: at, cancelRequestedBy: userId, updatedAt: at })
      .where(and(where, inArray(run.status, ACTIVE), isNull(run.cancelRequestedAt)))
      .run();
  }

  return {
    // In the thread's current branch when none is named.
    create({ branchId, ...input }) {
      return db
        .insert(run)
        .values({
          id: ulid(),
          status: "queued",
          ...input,
          branchId: branchId ?? currentOf(input.threadId),
        })
        .returning(columns)
        .get();
    },

    activeOn,

    requestCancelOn(branchId, userId, at) {
      requestCancelWhere(eq(run.branchId, branchId), userId, at);
      return activeOn(branchId);
    },

    find(id) {
      return db.select(columns).from(run).where(eq(run.id, id)).get() ?? null;
    },

    latest(threadId) {
      return (
        db
          .select(columns)
          .from(run)
          .where(and(eq(run.threadId, threadId), eq(run.branchId, currentOf(threadId))))
          // Ids made in the same millisecond do not sort by time; rows are numbered as inserted.
          .orderBy(desc(sql`rowid`))
          .limit(1)
          .get() ?? null
      );
    },

    active,

    activeThreadIds() {
      return db
        .select({ threadId: run.threadId })
        .from(run)
        .where(inArray(run.status, ACTIVE))
        .all()
        .map((row) => row.threadId);
    },

    // Each thread's run in its current branch comes after any in its others.
    activeInSpace(spaceId) {
      return db
        .select(columns)
        .from(run)
        .innerJoin(thread, eq(thread.id, run.threadId))
        .where(and(eq(thread.spaceId, spaceId), inArray(run.status, ACTIVE)))
        .orderBy(inCurrent)
        .all();
    },

    activeIn(threadIds) {
      if (threadIds.length === 0) return [];
      return db
        .select(columns)
        .from(run)
        .innerJoin(thread, eq(thread.id, run.threadId))
        .where(and(inArray(run.threadId, threadIds), inArray(run.status, ACTIVE)))
        .orderBy(inCurrent)
        .all();
    },

    requestCancel(threadId, userId, at) {
      requestCancelWhere(eq(run.branchId, currentOf(threadId)), userId, at);
      return active(threadId);
    },

    claim(owner, expiresAt) {
      const next = db
        .select({ id: run.id })
        .from(run)
        .where(eq(run.status, "queued"))
        .orderBy(asc(run.id))
        .limit(1);
      return (
        db
          .update(run)
          .set(take(owner, expiresAt))
          .where(and(eq(run.status, "queued"), eq(run.id, sql`(${next})`)))
          .returning(columns)
          .get() ?? null
      );
    },

    takeOver(id, owner, expiresAt, before) {
      return (
        db
          .update(run)
          .set(take(owner, expiresAt))
          .where(and(eq(run.id, id), staleWhere(before)))
          .returning(columns)
          .get() ?? null
      );
    },

    stale(before) {
      return db.select(columns).from(run).where(staleWhere(before)).orderBy(asc(run.id)).all();
    },

    hold(lease) {
      const row = db.select(columns).from(run).where(held(lease)).get();
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    renew(lease, expiresAt) {
      const row = db
        .update(run)
        .set({ leaseExpiresAt: expiresAt, updatedAt: new Date() })
        .where(held(lease))
        .returning(columns)
        .get();
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    setModel(lease, model) {
      const row = db
        .update(run)
        .set({ model, updatedAt: new Date() })
        .where(held(lease))
        .returning({ id: run.id })
        .get();
      if (!row) throw new LeaseLost(lease.runId);
    },

    turnOn(lease, callId, toolIds) {
      const current = db.select({ threadId: run.threadId }).from(run).where(held(lease)).get();
      if (!current) throw new LeaseLost(lease.runId);
      const on = db
        .select({ count: sql<number>`count(*)` })
        .from(threadTool)
        .where(eq(threadTool.threadId, current.threadId))
        .get();
      const values = [...new Set(toolIds)].map((toolId, index) => ({
        threadId: current.threadId,
        toolId,
        callId,
        position: (on?.count ?? 0) + index,
      }));
      if (values.length > 0) db.insert(threadTool).values(values).onConflictDoNothing().run();
    },

    toolsOn(threadId) {
      return db
        .select({ id: threadTool.toolId, callId: threadTool.callId })
        .from(threadTool)
        .where(eq(threadTool.threadId, threadId))
        .orderBy(asc(threadTool.position))
        .all();
    },

    wait(lease) {
      const row = db
        .update(run)
        .set({ status: "waiting", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(held(lease))
        .returning(columns)
        .get();
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    resume(runId) {
      const row = db
        .update(run)
        .set({ status: "queued", updatedAt: new Date() })
        .where(and(eq(run.id, runId), eq(run.status, "waiting")))
        .returning({ id: run.id })
        .get();
      return !!row;
    },

    end(lease, { status, error, errorKind, errorDetail, usage }): Run {
      const now = new Date();
      const row = db
        .update(run)
        .set({
          status,
          error: error ?? null,
          errorKind: errorKind ?? null,
          errorDetail: errorDetail ?? null,
          ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
          leaseOwner: null,
          leaseExpiresAt: null,
          endedAt: now,
          updatedAt: now,
        })
        .where(held(lease))
        .returning(columns)
        .get();
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },
  };
}

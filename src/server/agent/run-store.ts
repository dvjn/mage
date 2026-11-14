// Claims and lease checks are single conditional statements, so two workers never both hold a run.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { thread } from "@/server/threads/schema.ts";
import type { Db } from "@/server/db/db.ts";
import { leasesOn } from "@/server/sync/lease.ts";

import { type Lease, LeaseLost, type Run, type RunStore } from "./runs.ts";
import { run, runMachine, threadTool } from "./schema.ts";

const columns = {
  id: run.id,
  threadId: run.threadId,
  branchId: run.branchId,
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
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
};

const ACTIVE = ["queued", "running", "waiting"] as const;

// Whether the run is in its thread's current branch, with the thread joined.
const inCurrent = sql`${run.branchId} = ${thread.currentBranchId}`;

const leases = leasesOn(run);

// The event that ends a run in each way it ends.
const ENDS = { completed: "complete", failed: "fail", cancelled: "cancel" } as const;

export function createRunStore(db: Db): RunStore {
  function held(lease: Lease) {
    return and(eq(run.id, lease.runId), leases.held(lease), eq(run.status, "running"));
  }

  function staleWhere() {
    return and(runMachine.from("takeOver", run.status), leases.expired());
  }

  function take(event: "claim" | "takeOver", owner: string, leaseMs: number) {
    return {
      ...runMachine.to(event),
      ...leases.take(owner, leaseMs),
      startedAt: sql`coalesce(${run.startedAt}, ${new Date()})`,
      updatedAt: new Date(),
    };
  }

  // The branch the thread's people see, as SQL.
  const currentOf = (threadId: string) =>
    sql`(select ${thread.currentBranchId} from ${thread} where ${thread.id} = ${threadId})`;

  async function activeOn(branchId: string | ReturnType<typeof sql>) {
    return (
      (
        await db
          .select(columns)
          .from(run)
          .where(and(eq(run.branchId, branchId), inArray(run.status, ACTIVE)))
          .limit(1)
      )[0] ?? null
    );
  }

  async function active(threadId: string) {
    return activeOn(currentOf(threadId));
  }

  async function requestCancelWhere(
    where: ReturnType<typeof and>,
    userId: string | null,
    at: Date,
  ) {
    await db
      .update(run)
      .set({ cancelRequestedAt: at, cancelRequestedBy: userId, updatedAt: at })
      .where(and(where, inArray(run.status, ACTIVE), isNull(run.cancelRequestedAt)));
  }

  return {
    // In the thread's current branch when none is named.
    async create({ branchId, ...input }) {
      return (
        await db
          .insert(run)
          .values({
            id: ulid(),
            status: "queued",
            ...input,
            branchId: branchId ?? currentOf(input.threadId),
          })
          .returning(columns)
      )[0]!;
    },

    activeOn,

    async requestCancelOn(branchId, userId, at) {
      await requestCancelWhere(eq(run.branchId, branchId), userId, at);
      return activeOn(branchId);
    },

    async find(id) {
      return (await db.select(columns).from(run).where(eq(run.id, id)).limit(1))[0] ?? null;
    },

    async latest(threadId) {
      return (
        (
          await db
            .select(columns)
            .from(run)
            .where(and(eq(run.threadId, threadId), eq(run.branchId, currentOf(threadId))))
            .orderBy(desc(run.createdAt), desc(run.id))
            .limit(1)
        )[0] ?? null
      );
    },

    active,

    async activeThreadIds() {
      return (
        await db.select({ threadId: run.threadId }).from(run).where(inArray(run.status, ACTIVE))
      ).map((row) => row.threadId);
    },

    // Each thread's run in its current branch comes after any in its others.
    async activeInSpace(spaceId) {
      return await db
        .select(columns)
        .from(run)
        .innerJoin(thread, eq(thread.id, run.threadId))
        .where(and(eq(thread.spaceId, spaceId), inArray(run.status, ACTIVE)))
        .orderBy(inCurrent);
    },

    async activeIn(threadIds) {
      if (threadIds.length === 0) return [];
      return await db
        .select(columns)
        .from(run)
        .innerJoin(thread, eq(thread.id, run.threadId))
        .where(and(inArray(run.threadId, threadIds), inArray(run.status, ACTIVE)))
        .orderBy(inCurrent);
    },

    async requestCancel(threadId, userId, at) {
      await requestCancelWhere(eq(run.branchId, currentOf(threadId)), userId, at);
      return active(threadId);
    },

    // The oldest queued run another worker is not claiming at the same moment.
    async claim(owner, leaseMs) {
      const next = db
        .select({ id: run.id })
        .from(run)
        .where(runMachine.from("claim", run.status))
        .orderBy(asc(run.id))
        .limit(1)
        .for("no key update", { skipLocked: true });
      return (
        (
          await db
            .update(run)
            .set(take("claim", owner, leaseMs))
            .where(and(runMachine.from("claim", run.status), eq(run.id, sql`(${next})`)))
            .returning(columns)
        )[0] ?? null
      );
    },

    async takeOver(id, owner, leaseMs) {
      return (
        (
          await db
            .update(run)
            .set(take("takeOver", owner, leaseMs))
            .where(and(eq(run.id, id), staleWhere()))
            .returning(columns)
        )[0] ?? null
      );
    },

    async stale() {
      return await db.select(columns).from(run).where(staleWhere()).orderBy(asc(run.id));
    },

    async hold(lease) {
      const row = (await db.select(columns).from(run).where(held(lease)).limit(1))[0];
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    async renew(lease, leaseMs) {
      const row = (
        await db
          .update(run)
          .set({ ...leases.renew(leaseMs), updatedAt: new Date() })
          .where(held(lease))
          .returning(columns)
      )[0];
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    async expire(lease) {
      await db
        .update(run)
        .set({ ...leases.expire(), updatedAt: new Date() })
        .where(held(lease));
    },

    async setModel(lease, model) {
      const row = (
        await db
          .update(run)
          .set({ model, updatedAt: new Date() })
          .where(held(lease))
          .returning({ id: run.id })
      )[0];
      if (!row) throw new LeaseLost(lease.runId);
    },

    async turnOn(lease, callId, toolIds) {
      const current = (
        await db.select({ threadId: run.threadId }).from(run).where(held(lease)).limit(1)
      )[0];
      if (!current) throw new LeaseLost(lease.runId);
      const on = (
        await db
          .select({ count: sql<number>`count(*)` })
          .from(threadTool)
          .where(eq(threadTool.threadId, current.threadId))
          .limit(1)
      )[0];
      const values = [...new Set(toolIds)].map((toolId, index) => ({
        threadId: current.threadId,
        toolId,
        callId,
        position: (on?.count ?? 0) + index,
      }));
      if (values.length > 0) await db.insert(threadTool).values(values).onConflictDoNothing();
    },

    async toolsOn(threadId) {
      return await db
        .select({ id: threadTool.toolId, callId: threadTool.callId })
        .from(threadTool)
        .where(eq(threadTool.threadId, threadId))
        .orderBy(asc(threadTool.position));
    },

    async wait(lease) {
      const row = (
        await db
          .update(run)
          .set({ ...runMachine.to("wait"), ...leases.release(), updatedAt: new Date() })
          .where(and(held(lease), runMachine.from("wait", run.status)))
          .returning(columns)
      )[0];
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },

    async resume(runId) {
      const row = (
        await db
          .update(run)
          .set({ ...runMachine.to("resume"), updatedAt: new Date() })
          .where(and(eq(run.id, runId), runMachine.from("resume", run.status)))
          .returning({ id: run.id })
      )[0];
      return !!row;
    },

    async end(lease, { status, usage }): Promise<Run> {
      const now = new Date();
      const row = (
        await db
          .update(run)
          .set({
            ...runMachine.to(ENDS[status]),
            ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
            ...leases.release(),
            endedAt: now,
            updatedAt: now,
          })
          .where(and(held(lease), runMachine.from(ENDS[status], run.status)))
          .returning(columns)
      )[0];
      if (!row) throw new LeaseLost(lease.runId);
      return row;
    },
  };
}

// Runs kept in the run table, with ULID ids. Claims and lease checks are single conditional
// statements, so two workers never both hold a run.

import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { type Lease, LeaseLost, type Run, type RunStore } from "@/ports/runs.ts";

import type { Db } from "./db.ts";
import { run } from "./schema.ts";

const columns = {
  id: run.id,
  threadId: run.threadId,
  status: run.status,
  triggerSeq: run.triggerSeq,
  model: run.model,
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
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
};

const ACTIVE = ["queued", "running", "waiting"] as const;

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

  function active(threadId: string) {
    return (
      db
        .select(columns)
        .from(run)
        .where(and(eq(run.threadId, threadId), inArray(run.status, ACTIVE)))
        .get() ?? null
    );
  }

  return {
    create(input) {
      return db
        .insert(run)
        .values({ id: ulid(), status: "queued", ...input })
        .returning(columns)
        .get();
    },

    find(id) {
      return db.select(columns).from(run).where(eq(run.id, id)).get() ?? null;
    },

    active,

    requestCancel(threadId, userId, at) {
      db.update(run)
        .set({ cancelRequestedAt: at, cancelRequestedBy: userId, updatedAt: at })
        .where(
          and(
            eq(run.threadId, threadId),
            inArray(run.status, ACTIVE),
            isNull(run.cancelRequestedAt),
          ),
        )
        .run();
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

    end(lease, { status, error, usage }): Run {
      const now = new Date();
      const row = db
        .update(run)
        .set({
          status,
          error: error ?? null,
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

// Background calls. A running one is held by the instance running it under a lease, and every
// change of where it stands is one conditional statement, so of several instances one wins.

import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { leasesOn } from "@/server/sync/lease.ts";

import { backgroundCall } from "./schema.ts";
import type { CallLease, CallRecord, CallStore } from "./calls.ts";

const leases = leasesOn(backgroundCall);

export function createCallStore(db: Db): CallStore {
  const held = (lease: CallLease) =>
    and(
      eq(backgroundCall.id, lease.callId),
      eq(backgroundCall.status, "running"),
      leases.held(lease),
    );

  return {
    async create(input, lease) {
      return (
        await db
          .insert(backgroundCall)
          .values({
            ...input,
            ...(lease && { ...leases.take(lease.owner, lease.leaseMs), leaseEpoch: 1 }),
          })
          .returning()
      )[0]!;
    },

    async find(id) {
      return (
        (await db.select().from(backgroundCall).where(eq(backgroundCall.id, id)).limit(1))[0] ??
        null
      );
    },

    async inThread(threadId): Promise<CallRecord[]> {
      return await db
        .select()
        .from(backgroundCall)
        .where(eq(backgroundCall.threadId, threadId))
        .orderBy(desc(backgroundCall.createdAt), desc(backgroundCall.id));
    },

    async open(threadId): Promise<CallRecord[]> {
      return await db
        .select()
        .from(backgroundCall)
        .where(
          and(
            eq(backgroundCall.threadId, threadId),
            inArray(backgroundCall.status, ["pending", "running"]),
          ),
        );
    },

    async start(id, owner, leaseMs) {
      return (
        (
          await db
            .update(backgroundCall)
            .set({ status: "running", ...leases.take(owner, leaseMs) })
            .where(and(eq(backgroundCall.id, id), eq(backgroundCall.status, "pending")))
            .returning()
        )[0] ?? null
      );
    },

    async renew(lease, leaseMs) {
      const row = (
        await db
          .update(backgroundCall)
          .set(leases.renew(leaseMs))
          .where(held(lease))
          .returning({ id: backgroundCall.id })
      )[0];
      return !!row;
    },

    async finish(lease, fields) {
      const row = (
        await db
          .update(backgroundCall)
          .set({ ...fields, ...leases.release() })
          .where(held(lease))
          .returning({ id: backgroundCall.id })
      )[0];
      return !!row;
    },

    async expire(lease) {
      await db.update(backgroundCall).set(leases.expire()).where(held(lease));
    },

    async stale() {
      return await db
        .select()
        .from(backgroundCall)
        .where(and(eq(backgroundCall.status, "running"), leases.expired()));
    },

    async interrupt(id, at) {
      return (
        (
          await db
            .update(backgroundCall)
            .set({ status: "interrupted", endedAt: at, ...leases.release() })
            .where(
              and(
                eq(backgroundCall.id, id),
                eq(backgroundCall.status, "running"),
                leases.expired(),
              ),
            )
            .returning()
        )[0] ?? null
      );
    },

    async cancel(id, at) {
      return (
        (
          await db
            .update(backgroundCall)
            .set({ status: "cancelled", endedAt: at, ...leases.release() })
            .where(
              and(
                eq(backgroundCall.id, id),
                inArray(backgroundCall.status, ["pending", "running"]),
              ),
            )
            .returning()
        )[0] ?? null
      );
    },

    async update(id, fields) {
      await db.update(backgroundCall).set(fields).where(eq(backgroundCall.id, id));
    },
  };
}

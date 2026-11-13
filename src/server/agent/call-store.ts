// Background calls. A running one is held by the instance running it under a lease, and every
// change of where it stands is one conditional statement, so of several instances one wins.

import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { leasesOn } from "@/server/db/lease.ts";

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
    create(input, lease) {
      return db
        .insert(backgroundCall)
        .values({
          ...input,
          ...(lease && {
            leaseOwner: lease.owner,
            leaseExpiresAt: lease.expiresAt,
            leaseEpoch: 1,
          }),
        })
        .returning()
        .get();
    },

    find(id) {
      return db.select().from(backgroundCall).where(eq(backgroundCall.id, id)).get() ?? null;
    },

    inThread(threadId): CallRecord[] {
      return db
        .select()
        .from(backgroundCall)
        .where(eq(backgroundCall.threadId, threadId))
        .orderBy(desc(backgroundCall.createdAt), desc(backgroundCall.id))
        .all();
    },

    open(threadId): CallRecord[] {
      return db
        .select()
        .from(backgroundCall)
        .where(
          and(
            eq(backgroundCall.threadId, threadId),
            inArray(backgroundCall.status, ["pending", "running"]),
          ),
        )
        .all();
    },

    start(id, owner, expiresAt) {
      return (
        db
          .update(backgroundCall)
          .set({ status: "running", ...leases.take(owner, expiresAt) })
          .where(and(eq(backgroundCall.id, id), eq(backgroundCall.status, "pending")))
          .returning()
          .get() ?? null
      );
    },

    renew(lease, expiresAt) {
      const row = db
        .update(backgroundCall)
        .set(leases.renew(expiresAt))
        .where(held(lease))
        .returning({ id: backgroundCall.id })
        .get();
      return !!row;
    },

    finish(lease, fields) {
      const row = db
        .update(backgroundCall)
        .set({ ...fields, ...leases.release() })
        .where(held(lease))
        .returning({ id: backgroundCall.id })
        .get();
      return !!row;
    },

    expire(lease) {
      db.update(backgroundCall).set(leases.expire()).where(held(lease)).run();
    },

    stale(before) {
      return db
        .select()
        .from(backgroundCall)
        .where(and(eq(backgroundCall.status, "running"), leases.expired(before)))
        .all();
    },

    interrupt(id, before, at) {
      return (
        db
          .update(backgroundCall)
          .set({ status: "interrupted", endedAt: at, ...leases.release() })
          .where(
            and(
              eq(backgroundCall.id, id),
              eq(backgroundCall.status, "running"),
              leases.expired(before),
            ),
          )
          .returning()
          .get() ?? null
      );
    },

    cancel(id, at) {
      return (
        db
          .update(backgroundCall)
          .set({ status: "cancelled", endedAt: at, ...leases.release() })
          .where(
            and(eq(backgroundCall.id, id), inArray(backgroundCall.status, ["pending", "running"])),
          )
          .returning()
          .get() ?? null
      );
    },

    update(id, fields) {
      db.update(backgroundCall).set(fields).where(eq(backgroundCall.id, id)).run();
    },
  };
}

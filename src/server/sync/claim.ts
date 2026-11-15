// Taking rows that are due, and work only one instance does at a time. Due rows are locked as they
// are read, skipping those another transaction holds, so instances ticking together never wait on
// each other's rows; the owner's conditional update stays what makes a row's work happen once. A
// singleton is held by a lease on its row, renewed while its work runs, so the work writes in
// transactions of its own however long it takes; an instance that cannot take the lease skips the
// pass. A holder that dies leaves the lease to run out and the next pass to another instance; one
// that stalls past it may finish its pass beside the next holder's, so a singleton's work must be
// safe to do twice.

import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Db } from "@/server/db/db.ts";
import type { Logger } from "@/server/kernel/logger.ts";

import type { Keeper, KeeperOptions } from "./keeper.ts";
import { type Lease, leasesOn } from "./lease.ts";
import { singleton } from "./schema.ts";

export const SINGLETON_LEASE_MS = 30_000;

const leases = leasesOn(singleton);

export function createClaims(deps: {
  db: Db;
  inTransaction: () => boolean;
  instanceId: string;
  keeper: <L>(opts: KeeperOptions<L>) => Keeper;
  logger: Logger;
}) {
  const { db, inTransaction } = deps;
  const ofName = (name: string, lease: Lease) => and(eq(singleton.name, name), leases.held(lease));

  return {
    // The rows of the table that match, in order, up to the limit, locked until the transaction
    // under way ends; none another transaction holds.
    claimDue: async <T extends PgTable>(
      table: T,
      opts: { where: SQL; orderBy: SQL | PgColumn; limit: number },
    ): Promise<T["$inferSelect"][]> => {
      if (!inTransaction()) throw new Error("Due rows are claimed inside a transaction.");
      return (await db
        .select()
        .from(table as PgTable)
        .where(opts.where)
        .orderBy(opts.orderBy)
        .limit(opts.limit)
        .for("update", { skipLocked: true })) as T["$inferSelect"][];
    },

    // Runs the work unless another instance runs work of the same name now.
    singleton: async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<{ ran: true; result: T } | { ran: false }> => {
      if (inTransaction()) throw new Error("A singleton runs outside any transaction.");
      const owner = deps.instanceId;
      const taken = await db
        .insert(singleton)
        .values({ name, ...leases.take(owner, SINGLETON_LEASE_MS), leaseEpoch: 1 })
        .onConflictDoUpdate({
          target: singleton.name,
          set: leases.take(owner, SINGLETON_LEASE_MS),
          setWhere: leases.expired(),
        })
        .returning({ epoch: singleton.leaseEpoch });
      if (!taken[0]) return { ran: false };
      const lease: Lease = { owner, epoch: taken[0].epoch };
      const keeper = deps.keeper({
        name: `singleton:${name}`,
        everyMs: SINGLETON_LEASE_MS / 3,
        held: () => [lease],
        renew: async (held) =>
          (
            await db
              .update(singleton)
              .set(leases.renew(SINGLETON_LEASE_MS))
              .where(ofName(name, held))
              .returning({ name: singleton.name })
          ).length > 0,
        onLost: () => deps.logger.warn({ name }, "singleton lease lost while its work ran"),
      });
      try {
        await keeper.start();
        return { ran: true, result: await work() };
      } finally {
        await keeper.stop();
        await db
          .update(singleton)
          .set(leases.release())
          .where(ofName(name, lease))
          .catch((err: unknown) => deps.logger.error({ err, name }, "singleton lease not let go"));
      }
    },
  };
}

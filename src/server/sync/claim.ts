// Taking rows that are due, and work only one instance does at a time. Due rows are locked as they
// are read, skipping those another transaction holds, so instances ticking together never wait on
// each other's rows; the owner's conditional update stays what makes a row's work happen once. A
// singleton's lock lasts its transaction: an instance that cannot take it skips the pass.

import { type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Db } from "@/server/db/db.ts";

import type { Transact } from "./transact.ts";

export function createClaims(db: Db, transact: Transact, inTransaction: () => boolean) {
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
    ): Promise<{ ran: true; result: T } | { ran: false }> =>
      transact(async () => {
        const taken = await db.execute<{ taken: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext(${name})) as taken`,
        );
        if (!taken.rows[0]?.taken) return { ran: false as const };
        return { ran: true as const, result: await work() };
      }),
  };
}

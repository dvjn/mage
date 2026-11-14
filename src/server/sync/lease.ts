// Leases on rows of work that a server instance carries out, such as a run or a background call.
// Several instances may share the database: one holds a row while its lease runs and renews it as
// it works; another takes the row over only once the lease has expired. Every take bumps the epoch,
// and every write of the holder is fenced on owner and epoch, so an instance that lost its lease
// can no longer write for the row.

import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { integer, type PgColumn, text } from "drizzle-orm/pg-core";

import { at } from "@/server/db/columns.ts";

// The right to write for a row, held by one instance until it lets it go or it expires.
export interface Lease {
  owner: string;
  epoch: number;
}

// Thrown by a write whose lease no longer holds.
export class LeaseLost extends Error {
  constructor(what: string) {
    super(`lease on ${what} lost`);
  }
}

// The columns a leased table declares.
export function leaseColumns() {
  return {
    // The instance holding the row, until when, and how many times it has been taken.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: at("lease_expires_at"),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
  };
}

interface Leased {
  leaseOwner: PgColumn;
  leaseExpiresAt: PgColumn;
  leaseEpoch: PgColumn;
}

// When a lease taken or renewed now runs out, by the database's clock, which every instance shares.
function until(leaseMs: number) {
  return sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`;
}

// Conditions and changes for the table's lease columns, for its store's own statements. Expiry is
// set and compared by the database's clock, never an instance's.
export function leasesOn(table: Leased) {
  return {
    // The row is still held under the lease.
    held: (lease: Lease): SQL =>
      and(eq(table.leaseOwner, lease.owner), eq(table.leaseEpoch, lease.epoch))!,
    // Nobody holds the row now: its lease ran out, or it never had one.
    expired: (): SQL =>
      or(isNull(table.leaseExpiresAt), sql`${table.leaseExpiresAt} < clock_timestamp()`)!,
    // Sets the owner and expiry, and the next epoch.
    take: (owner: string, leaseMs: number) => ({
      leaseOwner: owner,
      leaseExpiresAt: until(leaseMs),
      leaseEpoch: sql`${table.leaseEpoch} + 1`,
    }),
    renew: (leaseMs: number) => ({ leaseExpiresAt: until(leaseMs) }),
    // Lets the row go: nobody holds it.
    release: () => ({ leaseOwner: null, leaseExpiresAt: null }),
    // Ends the lease now, for whoever comes next to take the row over at once.
    expire: () => ({ leaseExpiresAt: new Date(0) }),
  };
}

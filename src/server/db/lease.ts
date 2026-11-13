// Leases on rows of work that a server instance carries out, such as a run or a background call.
// Several instances may share the database: one holds a row while its lease runs and renews it as
// it works; another takes the row over only once the lease has expired. Every take bumps the epoch,
// and every write of the holder is fenced on owner and epoch, so an instance that lost its lease
// can no longer write for the row.

import { and, eq, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { integer, type SQLiteColumn, text } from "drizzle-orm/sqlite-core";

// The right to write for a row, held by one instance until it lets it go or it expires.
export interface Lease {
  owner: string;
  epoch: number;
}

// The columns a leased table declares.
export function leaseColumns() {
  return {
    // The instance holding the row, until when, and how many times it has been taken.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
  };
}

interface Leased {
  leaseOwner: SQLiteColumn;
  leaseExpiresAt: SQLiteColumn;
  leaseEpoch: SQLiteColumn;
}

// Conditions and changes for the table's lease columns, for its store's own statements.
export function leasesOn(table: Leased) {
  return {
    // The row is still held under the lease.
    held: (lease: Lease): SQL =>
      and(eq(table.leaseOwner, lease.owner), eq(table.leaseEpoch, lease.epoch))!,
    // Nobody holds the row now: its lease ran out before `at`, or it never had one.
    expired: (at: Date): SQL => or(isNull(table.leaseExpiresAt), lt(table.leaseExpiresAt, at))!,
    // Sets the owner and expiry, and the next epoch.
    take: (owner: string, expiresAt: Date) => ({
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      leaseEpoch: sql`${table.leaseEpoch} + 1`,
    }),
    renew: (expiresAt: Date) => ({ leaseExpiresAt: expiresAt }),
    // Lets the row go: nobody holds it.
    release: () => ({ leaseOwner: null, leaseExpiresAt: null }),
    // Ends the lease now, for whoever comes next to take the row over at once.
    expire: () => ({ leaseExpiresAt: new Date(0) }),
  };
}

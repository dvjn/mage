// The column kinds every schema shares beyond the dialect's own: a moment in time with its zone,
// and raw bytes.

import { sql } from "drizzle-orm";
import { customType, timestamp } from "drizzle-orm/pg-core";

export function at(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

// The moment a row is written, where it is not given one: the clock's, not its transaction's
// start, so rows written one after another in one transaction keep the order they were made in.
export const NOW = sql`clock_timestamp()`;

export const bytes = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

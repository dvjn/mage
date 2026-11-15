// Leases on work one instance does at a time, such as a periodic pass: one row per name, held by
// the instance doing the work while it runs.

import { pgTable, text } from "drizzle-orm/pg-core";

import { leaseColumns } from "./lease.ts";

export const singleton = pgTable("singleton", {
  name: text("name").primaryKey(),
  ...leaseColumns(),
});

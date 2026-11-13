// The feed the server instances on one database leave the bus's messages in for each other: each
// row numbered as written, with the instance that wrote it. Writers take turns, so the numbers
// follow the order rows were committed in, and each instance reads on from the last it read.

import { and, gt, lt, ne, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Db } from "./db.ts";

export const busMessage = sqliteTable("bus_message", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  origin: text("origin").notNull(),
  channel: text("channel").notNull(),
  payload: text("payload", { mode: "json" }).$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

export function createBusFeed(db: Db, origin: string) {
  return {
    append(channel: string, payload: unknown) {
      db.insert(busMessage).values({ origin, channel, payload }).run();
    },

    after(seq: number) {
      return db
        .select({ seq: busMessage.seq, channel: busMessage.channel, payload: busMessage.payload })
        .from(busMessage)
        .where(and(gt(busMessage.seq, seq), ne(busMessage.origin, origin)))
        .orderBy(busMessage.seq)
        .all();
    },

    last() {
      return db.get<{ seq: number | null }>(sql`select max(seq) as seq from bus_message`)?.seq ?? 0;
    },

    prune(before: Date) {
      db.delete(busMessage).where(lt(busMessage.createdAt, before)).run();
    },
  };
}

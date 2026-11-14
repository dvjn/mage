import { and, eq, sql } from "drizzle-orm";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { openTestDatabase } from "@/server/testing/database.ts";

import { machine } from "./machine.ts";
import { createSync } from "./sync.ts";

const door = machine({
  states: ["open", "closed"],
  transitions: {
    close: { from: ["open"], to: "closed" },
    open: { from: ["closed"], to: "open" },
  },
});
const table = pgTable("door", { id: text("id").primaryKey(), status: text("status").notNull() });

async function setup() {
  const { db } = createSync({ db: openTestDatabase().db, logger: createLogger({ write() {} }) });
  const { sql: checked } = new PgDialect().sqlToQuery(
    sql`${door.check("door_status_check", table.status).value}`,
  );
  await db.execute(
    sql.raw(`create table door (id text primary key, status text not null, check (${checked}))`),
  );
  return db;
}

describe("a machine's table", () => {
  it("refuses a state that is not one of its states", async () => {
    const db = await setup();
    await db.insert(table).values({ id: "d", status: "open" });
    await expect(db.insert(table).values({ id: "e", status: "ajar" })).rejects.toThrow();
  });

  it("changes no row an event does not move from where it stands", async () => {
    const db = await setup();
    await db.insert(table).values({ id: "d", status: "open" });
    const move = async (event: "open" | "close") =>
      db
        .update(table)
        .set(door.to(event))
        .where(and(eq(table.id, "d"), door.from(event, table.status)))
        .returning();
    expect(await move("open")).toEqual([]);
    expect(await move("close")).toEqual([{ id: "d", status: "closed" }]);
  });
});

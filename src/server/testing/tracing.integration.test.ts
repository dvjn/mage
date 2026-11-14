import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setup } from "./workspace.ts";
import { queries } from "./tracing.ts";

describe.skipIf(!process.env.TEST_DATABASE_URL)("counting queries", () => {
  it("counts the queries of the work, in and out of transactions", async () => {
    const { db, transact } = setup();
    const { count, texts } = await queries(async () => {
      await db.execute(sql`select 1`);
      await transact(async () => {
        await db.execute(sql`select 2`);
      });
    });
    expect(texts.map((text) => text.toLowerCase())).toEqual([
      "select 1",
      "begin",
      "select 2",
      "commit",
    ]);
    expect(count).toBe(4);
  });

  it("counts none of work outside it, at once or on a timer", async () => {
    const { db, sync } = setup();
    const other = db.execute(sql`select 'elsewhere'`);
    const ticker = sync.ticker("tick", async () => db.execute(sql`select 'tick'`), 60_000);
    const { count } = await queries(async () => {
      await ticker.now();
      await db.execute(sql`select 'mine'`);
    });
    await other;
    await ticker.stop();
    // A pass is no part of the work that asked for it.
    expect(count).toBe(1);
  });
});

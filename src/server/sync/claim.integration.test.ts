import { asc, eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { openTestDatabase } from "@/server/testing/database.ts";

import { createSync } from "./sync.ts";

const job = pgTable("job", { id: text("id").primaryKey(), due: integer("due").notNull() });

async function setup() {
  const database = openTestDatabase();
  const make = () => createSync({ db: database.db, logger: createLogger({ write() {} }) });
  const a = make();
  await a.db.execute(sql`create table job (id text primary key, due integer not null)`);
  await a.db.insert(job).values([
    { id: "c", due: 3 },
    { id: "a", due: 1 },
    { id: "b", due: 2 },
    { id: "later", due: 9 },
  ]);
  return { a, b: make() };
}

const due = { where: sql`${job.due} < 5`, orderBy: asc(job.due) };

describe("due rows", () => {
  it("are claimed only inside a transaction", async () => {
    const { a } = await setup();
    await expect(a.claimDue(job, { ...due, limit: 1 })).rejects.toThrow("inside a transaction");
  });

  it("come in order, up to the limit", async () => {
    const { a } = await setup();
    const rows = await a.transact(async () => a.claimDue(job, { ...due, limit: 2 }));
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("due rows and singletons on Postgres", () => {
  it("keep a claimed row from others until its transaction ends", async () => {
    const { a, b } = await setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let claimed = () => {};
    const isClaimed = new Promise<void>((resolve) => (claimed = resolve));
    const first = a.transact(async () => {
      const rows = await a.claimDue(job, { ...due, limit: 1 });
      claimed();
      await held;
      return rows.map((row) => row.id);
    });
    await isClaimed;
    const second = await b.transact(async () =>
      (await b.claimDue(job, { ...due, limit: 3 })).map((row) => row.id),
    );
    release();
    expect(await first).toEqual(["a"]);
    expect(second).toEqual(["b", "c"]);
  });

  it("makes a ticker skip its pass while another instance holds the lock", async () => {
    const { a, b } = await setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken = () => {};
    const isTaken = new Promise<void>((resolve) => (taken = resolve));
    const first = a.singleton("sweep", async () => {
      taken();
      await held;
    });
    await isTaken;
    let passes = 0;
    const ticker = b.ticker("sweep", async () => void (passes += 1), 60_000, { singleton: true });
    await ticker.now();
    expect(passes).toBe(0);
    release();
    await first;
    await ticker.now();
    expect(passes).toBe(1);
    await ticker.stop();
  });

  it("is not run while another session holds its lock", async () => {
    const { a, b } = await setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken = () => {};
    const isTaken = new Promise<void>((resolve) => (taken = resolve));
    const first = a.singleton("sweep", async () => {
      taken();
      await held;
      return "a";
    });
    await isTaken;
    expect(await b.singleton("sweep", async () => "b")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, result: "a" });
    expect(await b.singleton("sweep", async () => "b")).toEqual({ ran: true, result: "b" });
    expect(await a.db.select().from(job).where(eq(job.id, "a"))).toHaveLength(1);
  });
});

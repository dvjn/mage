import { and, eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { expireLeases, openTestDatabase } from "@/server/testing/database.ts";

import { leaseColumns, leasesOn } from "./lease.ts";
import { createSync } from "./sync.ts";

const work = pgTable("work", { id: text("id").primaryKey(), ...leaseColumns() });
const leases = leasesOn(work);

async function setup() {
  const { db } = createSync({ db: openTestDatabase().db, logger: createLogger({ write() {} }) });
  await db.execute(
    sql`create table work (id text primary key, lease_owner text, lease_expires_at timestamptz, lease_epoch integer not null default 0)`,
  );
  await db.insert(work).values({ id: "w" });
  const update = async (set: Record<string, unknown>, where = eq(work.id, "w")) =>
    (await db.update(work).set(set).where(where).returning())[0] ?? null;
  const expired = async () =>
    (
      await db
        .select()
        .from(work)
        .where(and(eq(work.id, "w"), leases.expired()))
    ).length > 0;
  return { db, update, expired };
}

describe("leases", () => {
  afterEach(() => vi.useRealTimers());

  it("run out by the database's clock, whatever the instance's says", async () => {
    const { db, update, expired } = await setup();
    expect(await expired()).toBe(true);
    // This instance's clock is an hour ahead of the database's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await update(leases.take("me", 30_000));
    expect(await expired()).toBe(false);
    await expireLeases(db, "work");
    expect(await expired()).toBe(true);
  });

  it("are renewed, let go and ended", async () => {
    const { update, expired } = await setup();
    await update(leases.take("me", 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await expired()).toBe(true);
    await update(leases.renew(30_000));
    expect(await expired()).toBe(false);
    expect(await update(leases.release())).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await expired()).toBe(true);
    await update(leases.take("me", 30_000));
    await update(leases.expire());
    expect(await expired()).toBe(true);
  });

  it("go up an epoch on every take, and fence writes of an earlier one", async () => {
    const { update } = await setup();
    const first = await update(leases.take("me", 30_000));
    const second = await update(leases.take("other", 30_000));
    expect([first?.leaseEpoch, second?.leaseEpoch]).toEqual([1, 2]);
    const stale = { owner: "me", epoch: 1 };
    expect(
      await update({ leaseOwner: "me" }, and(eq(work.id, "w"), leases.held(stale))),
    ).toBeNull();
    expect(
      await update(
        leases.renew(30_000),
        and(eq(work.id, "w"), leases.held({ owner: "other", epoch: 2 })),
      ),
    ).not.toBeNull();
  });
});

// The instances kit on real Postgres: a killed instance reaches nothing, a deaf one hears nothing
// until restored, one whose listening connection is ended is told of the gap, and a write waits
// behind a thread's lock the test holds.

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deafen,
  dropListener,
  dropped,
  instances,
  kill,
  lockThread,
  restore,
} from "./instances.ts";

describe.skipIf(!process.env.TEST_DATABASE_URL)("instances", () => {
  it("end a killed one's connections at the server, and refuse what it tries after", async () => {
    const [a, b] = await instances(2);
    await b.db.execute(sql`select 1`);
    await kill(b);
    const left = await a.db.execute<{ count: string }>(
      sql`select count(*) from pg_stat_activity
           where datname = current_database() and application_name like 'i1%'`,
    );
    expect(left.rows[0]!.count).toBe("0");
    await expect(b.db.execute(sql`select 1`)).rejects.toMatchObject({
      cause: { message: "This instance was killed" },
    });
  });

  it("let a deaf one hear nothing, nor that it missed anything, until it is restored", async () => {
    const [a, b] = await instances(2);
    await b.sync.start();
    await a.sync.start();
    const heard: number[] = [];
    let gaps = 0;
    b.signals.subscribe(a.thread.id, (hint) => {
      if (hint.kind === "event") heard.push(hint.seq);
    });
    b.signals.onGap(() => (gaps += 1));
    deafen(b);
    a.signals.publish(a.thread.id, { kind: "event", seq: 1 });
    await vi.waitFor(() => expect(dropped(b)).toBe(1));
    restore(b);
    a.signals.publish(a.thread.id, { kind: "event", seq: 2 });
    await vi.waitFor(() => expect(heard).toEqual([2]));
    expect(gaps).toBe(0);
  });

  it("tell one whose listening connection was ended of the gap, once it listens again", async () => {
    const [, b] = await instances(2);
    await b.sync.start();
    let gaps = 0;
    b.signals.onGap(() => (gaps += 1));
    await dropListener(b);
    await vi.waitFor(() => expect(gaps).toBe(1), { timeout: 5000 });
  });

  it("hold a write on a thread behind the lock the test takes on it", async () => {
    const [a] = await instances(1);
    const release = await lockThread(a, a.thread.id);
    let posted = false;
    const post = a.post(a.ada, "Hello").then(() => (posted = true));
    await vi.waitFor(async () => {
      const waiting = await a.db.execute<{ count: string }>(
        sql`select count(*) from pg_locks where not granted`,
      );
      expect(Number(waiting.rows[0]!.count)).toBeGreaterThan(0);
    });
    expect(posted).toBe(false);
    await release();
    await post;
    expect(posted).toBe(true);
  });
});

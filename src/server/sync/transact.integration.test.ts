import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { openTestDatabase } from "@/server/testing/database.ts";

import { createSync } from "./sync.ts";

// An error as the driver gives it for a deadlock, or as drizzle wraps one.
function deadlock(wrapped = false) {
  const err = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  return wrapped ? new Error("Failed query", { cause: err }) : err;
}

async function setup() {
  const lines: { msg: string; err?: { message: string } }[] = [];
  const sync = createSync({
    db: openTestDatabase().db,
    logger: createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }),
  });
  const { db } = sync;
  await db.execute(sql`create table note (text text primary key)`);
  const add = (text: string) => db.execute(sql`insert into note values (${text})`);
  const notes = async () =>
    (await db.execute<{ text: string }>(sql`select text from note order by text`)).rows.map(
      (row) => row.text,
    );
  return { ...sync, lines, add, notes };
}

describe("transactions", () => {
  it("keep everything their work writes, or none of it when it fails", async () => {
    const { add, notes, transact } = await setup();
    await transact(async () => {
      await add("a");
      await add("b");
    });
    await expect(
      transact(async () => {
        await add("c");
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(await notes()).toEqual(["a", "b"]);
  });

  it("take in what is written however deep the calls go, a transaction inside as a savepoint", async () => {
    const { add, notes, transact } = await setup();
    await transact(async () => {
      await add("outer");
      await expect(
        transact(async () => {
          await add("inner");
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
      await transact(() => add("kept"));
      // Read inside, it sees its own writes.
      expect(await notes()).toEqual(["kept", "outer"]);
    });
    expect(await notes()).toEqual(["kept", "outer"]);
  });

  it("run what waits for the commit once the outermost commits, and never after a failure", async () => {
    const { add, notes, transact, afterCommit } = await setup();
    const ran: string[] = [];
    afterCommit(() => ran.push("outside"));
    expect(ran).toEqual(["outside"]);

    await transact(async () => {
      await add("a");
      afterCommit(() => ran.push("outer"));
      await transact(async () => afterCommit(() => ran.push("inner")));
      await expect(
        transact(async () => {
          afterCommit(() => ran.push("rolled back"));
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
      expect(ran).toEqual(["outside"]);
    });
    expect(ran).toEqual(["outside", "outer", "inner"]);

    await expect(
      transact(async () => {
        afterCommit(() => ran.push("failed"));
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(ran).toEqual(["outside", "outer", "inner"]);
    expect(await notes()).toEqual(["a"]);
  });

  it("send what work it did not wait for writes later to the database itself", async () => {
    const { add, notes, transact } = await setup();
    let late: Promise<unknown> = Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await transact(async () => {
      await add("in");
      late = held.then(() => add("late"));
    });
    release();
    await late;
    expect(await notes()).toEqual(["in", "late"]);
  });

  it("keep a commit whose after-commit step throws, and run the steps after it", async () => {
    const { add, notes, transact, afterCommit, lines } = await setup();
    const ran: string[] = [];
    await transact(async () => {
      await add("kept");
      afterCommit(() => {
        throw new Error("listener broke");
      });
      afterCommit(() => ran.push("after"));
    });
    expect(await notes()).toEqual(["kept"]);
    expect(ran).toEqual(["after"]);
    expect(lines).toMatchObject([
      { msg: "after-commit step failed", err: { message: "listener broke" } },
    ]);
  });

  it("refuse a transaction begun by work the transaction under way did not wait for", async () => {
    const { add, notes, transact } = await setup();
    await expect(
      transact(async () => {
        const both = await Promise.allSettled([
          transact(() => add("one")),
          transact(() => add("two")),
        ]);
        for (const one of both) if (one.status === "rejected") throw one.reason;
      }),
    ).rejects.toThrow("did not wait for");
    expect(await notes()).toEqual([]);
  });

  it("run the work again when it loses to a deadlock, without what the first attempt did", async () => {
    for (const wrapped of [false, true]) {
      const { add, notes, transact, afterCommit, stats } = await setup();
      const ran: string[] = [];
      let attempts = 0;
      await transact(async () => {
        attempts += 1;
        await add(`attempt ${attempts}`);
        afterCommit(() => ran.push(`after ${attempts}`));
        if (attempts === 1) throw deadlock(wrapped);
      });
      expect(attempts).toBe(2);
      expect(await notes()).toEqual(["attempt 2"]);
      expect(ran).toEqual(["after 2"]);
      expect(stats.retries).toBe(1);
    }
  });

  it("give up after three attempts with the last error", async () => {
    const { transact, stats } = await setup();
    let attempts = 0;
    await expect(
      transact(async () => {
        attempts += 1;
        throw Object.assign(new Error(`lost ${attempts}`), { code: "40001" });
      }),
    ).rejects.toThrow("lost 3");
    expect(attempts).toBe(3);
    expect(stats.retries).toBe(2);
  });

  it("run the outermost again when a savepoint loses, not the savepoint", async () => {
    const { add, notes, transact } = await setup();
    let outer = 0;
    let inner = 0;
    await transact(async () => {
      outer += 1;
      await add(`outer ${outer}`);
      await transact(async () => {
        inner += 1;
        if (inner === 1) throw deadlock();
      });
    });
    expect({ outer, inner }).toEqual({ outer: 2, inner: 2 });
    expect(await notes()).toEqual(["outer 2"]);
  });

  it("do not run the work again on other errors", async () => {
    const { transact, stats } = await setup();
    let attempts = 0;
    await expect(
      transact(async () => {
        attempts += 1;
        throw Object.assign(new Error("unique"), { code: "23505" });
      }),
    ).rejects.toThrow("unique");
    expect(attempts).toBe(1);
    expect(stats.retries).toBe(0);
  });

  it("tell whether the caller is inside one", async () => {
    const { transact, inTransaction } = await setup();
    expect(inTransaction()).toBe(false);
    await transact(async () => {
      expect(inTransaction()).toBe(true);
      await transact(async () => expect(inTransaction()).toBe(true));
    });
    expect(inTransaction()).toBe(false);
  });

  it("take locks in id order, counting one asked for below a lock held", async () => {
    const { transact, ordered, stats } = await setup();
    const taken: string[][] = [];
    const lock = async (ids: string[]) => void taken.push(ids);
    await transact(async () => {
      await ordered("thread", ["b", "a"], lock);
      await ordered("thread", ["b", "c"], lock);
    });
    expect(taken).toEqual([["a", "b"], ["c"]]);
    expect(stats.outOfOrder).toBe(0);
    await transact(async () => {
      await ordered("thread", ["b"], lock);
      await ordered("thread", ["a"], lock);
    });
    expect(stats.outOfOrder).toBe(1);
  });

  it("count calls made inside a transaction that must be made outside one", async () => {
    const { transact, outside, stats } = await setup();
    const call = outside("fetch", (n: number) => n + 1);
    expect(call(1)).toBe(2);
    expect(stats.insideCalls).toBe(0);
    await transact(async () => void call(1));
    expect(stats.insideCalls).toBe(1);
  });
});

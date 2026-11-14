import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";
import { openTestDatabase } from "@/server/testing/database.ts";

import type { Listen } from "./signals.ts";
import { createSync, type Sync } from "./sync.ts";

const started: Sync[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((sync) => sync.stop()));
});

// Two instances on one database, each hearing the other, and what each hears of a thread.
async function twoKernels(listen?: (base: Listen) => Listen) {
  const database = openTestDatabase();
  const make = async () => {
    const sync = createSync({
      db: database.db,
      listen: listen ? listen(database.listen) : database.listen,
      logger: createLogger({ write() {} }),
    });
    await sync.start();
    started.push(sync);
    const heard: number[] = [];
    sync.signals.subscribe("thread", (hint) => {
      if (hint.kind === "event") heard.push(hint.seq);
    });
    return { ...sync, heard };
  };
  return { a: await make(), b: await make() };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("signals", () => {
  it("are not heard before their transaction commits, here or on another instance", async () => {
    const { a, b } = await twoKernels();
    await a.transact(async () => {
      a.signals.publish("thread", { kind: "event", seq: 1 });
      await pause(50);
      expect(a.heard).toEqual([]);
      expect(b.heard).toEqual([]);
    });
    expect(a.heard).toEqual([1]);
    await vi.waitFor(() => expect(b.heard).toEqual([1]));
  });

  it("are never heard when their transaction rolls back, here or on another instance", async () => {
    const { a, b } = await twoKernels();
    await expect(
      a.transact(async () => {
        a.signals.publish("thread", { kind: "event", seq: 1 });
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    // One sent after shows that whatever was to arrive has.
    a.signals.publish("thread", { kind: "event", seq: 2 });
    await vi.waitFor(() => expect(b.heard).toEqual([2]));
    expect(a.heard).toEqual([2]);
  });

  it("die with a savepoint rolled back", async () => {
    const { a, b } = await twoKernels();
    await a.transact(async () => {
      await expect(
        a.transact(async () => {
          a.signals.publish("thread", { kind: "event", seq: 1 });
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
      a.signals.publish("thread", { kind: "event", seq: 2 });
    });
    await vi.waitFor(() => expect(b.heard).toEqual([2]));
    expect(a.heard).toEqual([2]);
  });

  it("keep their order within a transaction", async () => {
    const { a, b } = await twoKernels();
    await a.transact(async () => {
      for (const seq of [1, 2, 3]) a.signals.publish("thread", { kind: "event", seq });
    });
    await vi.waitFor(() => expect(b.heard).toEqual([1, 2, 3]));
    expect(a.heard).toEqual([1, 2, 3]);
  });

  it("keep their order outside a transaction", async () => {
    const { a, b } = await twoKernels();
    a.signals.publish("thread", { kind: "event", seq: 1 });
    a.signals.publish("thread", { kind: "event", seq: 2 });
    await vi.waitFor(() => expect(b.heard).toEqual([1, 2]));
    expect(a.heard).toEqual([1, 2]);
  });

  it("reach their sender once", async () => {
    const { a, b } = await twoKernels();
    a.signals.publish("thread", { kind: "event", seq: 1 });
    await a.transact(async () => a.signals.publish("thread", { kind: "event", seq: 2 }));
    // One sent in a transaction and one outside any keep no order between them.
    await vi.waitFor(() => expect(b.heard.toSorted((x, y) => x - y)).toEqual([1, 2]));
    await pause(50);
    expect(a.heard).toEqual([1, 2]);
  });

  it("too large for a hint go out smaller, for whoever hears them to read again", async () => {
    const { a, b } = await twoKernels();
    const heard: unknown[] = [];
    let gaps = 0;
    b.signals.onActivity((change) => heard.push(change));
    b.signals.onGap(() => (gaps += 1));
    // A change as one carrying hundreds of guests' ids would be.
    const gone = {
      spaceId: "s-1",
      guests: Array.from({ length: 300 }, (_, index) => `guest-${index}-0123456789abcdef`),
    };
    a.signals.activity({ threadId: "t-1", gone });
    a.signals.wake("w".repeat(8000));
    await vi.waitFor(() => expect(heard).toEqual([{ threadId: "t-1", gone: { spaceId: "s-1" } }]));
    await vi.waitFor(() => expect(gaps).toBe(1));
  });

  it("tell their listeners of a gap in what was heard", async () => {
    const gaps: (() => void)[] = [];
    const { a } = await twoKernels((base) => async (channel, onMessage, onGap) => {
      gaps.push(onGap);
      return base(channel, onMessage, onGap);
    });
    let told = 0;
    a.signals.onGap(() => (told += 1));
    gaps[0]!();
    expect(told).toBe(1);
  });
});

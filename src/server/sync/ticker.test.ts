import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";

import { createSync } from "./sync.ts";
import { createTicker } from "./ticker.ts";

function logged() {
  const lines: { msg: string; ticker?: string }[] = [];
  return {
    lines,
    logger: createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }),
  };
}

// A pass that waits until the test lets it end.
function heldPasses() {
  const ends: (() => void)[] = [];
  let running = 0;
  let most = 0;
  let passes = 0;
  const pass = () =>
    new Promise<void>((resolve) => {
      passes += 1;
      running += 1;
      most = Math.max(most, running);
      ends.push(() => {
        running -= 1;
        resolve();
      });
    });
  return {
    pass,
    end: () => ends.shift()?.(),
    get passes() {
      return passes;
    },
    get most() {
      return most;
    },
  };
}

describe("tickers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never run two passes at once", async () => {
    const held = heldPasses();
    const ticker = createTicker("t", held.pass, 100, logged().logger);
    const started = ticker.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(held.most).toBe(1);
    // The timer asked while the first ran: one more goes round, still alone.
    held.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(held.passes).toBe(2);
    expect(held.most).toBe(1);
    const stopping = ticker.stop();
    held.end();
    await started;
    await stopping;
  });

  it("go round once more when asked during a pass, and answer after it", async () => {
    const held = heldPasses();
    const ticker = createTicker("t", held.pass, 60_000, logged().logger);
    const first = ticker.now();
    let answered = false;
    const asked = ticker.now().then(() => (answered = true));
    void ticker.now();
    held.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(held.passes).toBe(2);
    expect(answered).toBe(false);
    held.end();
    await first;
    await asked;
    expect(held.passes).toBe(2);
  });

  it("log a pass that throws and run the next all the same", async () => {
    const { lines, logger } = logged();
    let passes = 0;
    const ticker = createTicker(
      "sweep",
      async () => {
        passes += 1;
        if (passes === 1) throw new Error("broke");
      },
      100,
      logger,
    );
    await ticker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);
    expect(lines).toMatchObject([{ msg: "periodic pass failed", ticker: "sweep" }]);
    await ticker.stop();
  });

  it("wait for the pass under way as they stop, and run no more", async () => {
    const held = heldPasses();
    const ticker = createTicker("t", held.pass, 100, logged().logger);
    void ticker.start();
    let stopped = false;
    const stopping = ticker.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    held.end();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(held.passes).toBe(1);
  });

  it("all stop with the kernel that made them", async () => {
    const sync = createSync({ db: {} as never, logger: logged().logger });
    let passes = 0;
    const tickers = ["a", "b"].map((name) =>
      sync.ticker(name, async () => void (passes += 1), 100),
    );
    for (const ticker of tickers) await ticker.start();
    await sync.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toBe(2);
  });
});

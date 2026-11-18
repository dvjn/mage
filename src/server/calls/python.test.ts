import { afterAll, describe, expect, it } from "vite-plus/test";

import { createPython, PythonError, PythonPause, SCRIPT_PARALLEL, toJson } from "./python.ts";

const python = createPython({ maxFeedDurationSecs: 1 });
afterAll(async () => python.close());

describe("python in the sandbox", () => {
  it("gives back its last expression as JSON, with what it printed", async () => {
    const outcome = await python.run({
      code: 'print("hi")\n{"a": {1, 2}, "b": (1, 2), "big": 2**70, "n": items[1]["n"]}',
      inputs: { items: [{ n: 1 }, { n: 2 }] },
      functions: {},
    });
    expect(outcome).toEqual({
      ok: true,
      value: { a: [1, 2], b: [1, 2], big: "1180591620717411303424", n: 2 },
      printed: "hi\n",
    });
  });

  it("calls the host's functions with JSON arguments, and raises what they raise", async () => {
    const seen: unknown[] = [];
    const outcome = await python.run({
      code: 'try:\n  await ask("x", {"k": [1]})\nexcept PermissionError as e:\n  r = str(e)\nr',
      functions: {
        ask: async (args) => {
          seen.push(args);
          return Promise.reject(new PythonError("PermissionError", "no"));
        },
      },
    });
    expect(seen).toEqual([["x", { k: [1] }]]);
    expect(outcome).toMatchObject({ ok: true, value: "no" });
  });

  it("knows no other names, files or network", async () => {
    const outcome = await python.run({ code: "other(1)", functions: {} });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("NameError") });
    const read = await python.run({ code: 'open("/etc/passwd").read()', functions: {} });
    expect(read.ok).toBe(false);
  });

  it("ends a script that runs past its limit", async () => {
    const outcome = await python.run({ code: "while True:\n  pass", functions: {} });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("TimeoutError") });
  });

  it("stops at once when asked, while it computes", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    const outcome = await python.run({
      code: "while True:\n  pass",
      functions: {},
      signal: stop.signal,
    });
    expect(outcome).toMatchObject({ ok: false, error: "The script was stopped." });
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("turns Python's values into JSON", () => {
    expect(toJson(new Map([[1, new Set(["a"])]]))).toEqual({ 1: ["a"] });
    expect(toJson(5n)).toBe(5);
  });

  it("gives dates, times and durations back as ISO 8601", async () => {
    const outcome = await python.run({
      code: [
        "import datetime",
        "[datetime.date(2026, 3, 4), datetime.datetime(2026, 3, 4, 5, 6, 7, 8, tzinfo=datetime.timezone.utc),",
        " datetime.time(5, 6, 7), datetime.timedelta(days=1, seconds=90)]",
      ].join("\n"),
      functions: {},
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: ["2026-03-04", "2026-03-04T05:06:07.000008Z", "05:06:07", "P1DT90S"],
    });
  });

  it("stops at once while it waits for a worker, and gives up waiting past a while", async () => {
    const one = createPython({ maxFeedDurationSecs: 30 }, { workers: 1, checkoutSecs: 0.5 });
    const busy = new AbortController();
    const running = one.run({ code: "while True:\n  pass", functions: {}, signal: busy.signal });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    expect(await one.run({ code: "1", functions: {}, signal: stop.signal })).toMatchObject({
      ok: false,
      error: "The script was stopped.",
    });
    expect(Date.now() - started).toBeLessThan(400);
    expect(await one.run({ code: "1", functions: {} })).toMatchObject({
      ok: false,
      error: "Too many scripts are running here; try again shortly.",
    });
    busy.abort();
    await running;
    expect(await one.run({ code: "1", functions: {} })).toMatchObject({ ok: true, value: 1 });
    await one.close();
  });

  it("pauses at a call, and goes on from there in another pool, still under its limits", async () => {
    const asked: unknown[] = [];
    const first = await python.run({
      code: 'print("one")\nx = await ask(1)\nprint("two", x)\nwhile x:\n  pass',
      functions: {
        ask: async (args) => {
          asked.push(args);
          return Promise.reject(new PythonPause("detail"));
        },
      },
    });
    expect(first).toMatchObject({
      ok: false,
      paused: { calls: [{ detail: "detail" }] },
      printed: "one\n",
    });
    if (!("paused" in first)) return;
    const other = createPython({ maxFeedDurationSecs: 1 });
    const answered: number[] = [];
    const second = await other.run({
      code: "",
      resume: {
        snapshot: first.paused.snapshot,
        printed: first.printed,
        answer: async (future) => {
          answered.push(future);
          return Promise.resolve(true);
        },
      },
      functions: {},
    });
    await other.close();
    // Answered where it stood, never asked again, then held to its time as it went on.
    expect(asked).toEqual([[1]]);
    expect(answered).toEqual([first.paused.calls[0]!.future]);
    expect(second).toMatchObject({
      ok: false,
      error: expect.stringContaining("TimeoutError"),
      printed: "one\ntwo True\n",
    });
  });

  it("raises in place of a pause too large to keep", async () => {
    const small = createPython({ maxFeedDurationSecs: 5 }, { pauseBytes: 1000 });
    const refused: unknown[] = [];
    const outcome = await small.run({
      code: 'big = "a" * 100000\ntry:\n  await ask()\nexcept RuntimeError as e:\n  r = str(e)\nr',
      functions: { ask: async () => Promise.reject(new PythonPause("d")) },
      tooLarge: async (detail) => {
        refused.push(detail);
        return Promise.resolve();
      },
    });
    await small.close();
    expect(refused).toEqual(["d"]);
    expect(outcome).toMatchObject({
      ok: true,
      value: expect.stringContaining("holds too much to pause"),
    });
  });

  it("runs the calls it gathers at once, and answers each as it settles", async () => {
    const started = Date.now();
    const outcome = await python.run({
      code: "import asyncio\nawait asyncio.gather(*[wait(i) for i in range(5)])",
      functions: {
        wait: async ([n]) => new Promise((resolve) => setTimeout(() => resolve(n), 200)),
      },
    });
    expect(outcome).toMatchObject({ ok: true, value: [0, 1, 2, 3, 4] });
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("pauses with the others settled where one gathered waits", async () => {
    const ran: number[] = [];
    const first = await python.run({
      code: "import asyncio\nawait asyncio.gather(work(1), work(2), work(3))",
      functions: {
        work: async ([n]) => {
          if (n === 2) return Promise.reject(new PythonPause(n));
          ran.push(n as number);
          return Promise.resolve(n);
        },
      },
    });
    expect(first).toMatchObject({ ok: false, paused: { calls: [{ detail: 2 }] } });
    if (!("paused" in first)) return;
    const second = await python.run({
      code: "",
      resume: { ...first.paused, printed: "", answer: async () => Promise.resolve("two") },
      functions: {},
    });
    expect(ran).toEqual([1, 3]);
    expect(second).toMatchObject({ ok: true, value: [1, "two", 3] });
  });

  it("tells a script that used a call it never awaited how to, and no other", async () => {
    const work = async () => Promise.resolve({ a: 1 });
    const used = await python.run({ code: 'x = work()\nx["a"]', functions: { work } });
    expect(used).toMatchObject({ ok: false, error: expect.stringContaining("await call_tool") });
    // A tool's own words about a future are its own.
    const failed = await python.run({
      code: "await fail()",
      functions: {
        fail: async () =>
          Promise.reject(new PythonError("RuntimeError", "no coroutine or future here")),
      },
    });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("no coroutine") });
    expect(failed).not.toMatchObject({ error: expect.stringContaining("await call_tool") });
  });

  it("goes on past calls it left behind, and gives back its result once they end", async () => {
    const ended: number[] = [];
    const outcome = await python.run({
      code: [
        "import asyncio",
        "try:",
        "  await asyncio.gather(fail(), slow(1))",
        "except RuntimeError:",
        '  r = "caught"',
        "slow(2)",
        "r",
      ].join("\n"),
      functions: {
        fail: async () => Promise.reject(new PythonError("RuntimeError", "no")),
        slow: async ([n]) =>
          new Promise((resolve) =>
            setTimeout(() => {
              ended.push(n as number);
              resolve(n);
            }, 50),
          ),
      },
    });
    expect(outcome).toMatchObject({ ok: true, value: "caught" });
    expect(ended.toSorted((x, y) => x - y)).toEqual([1, 2]);
  });

  it("runs no more of the calls it gathers at once than its limit", async () => {
    let running = 0;
    let most = 0;
    const outcome = await python.run({
      code: "import asyncio\nlen(await asyncio.gather(*[work(i) for i in range(20)]))",
      functions: {
        work: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 20));
          running -= 1;
          return null;
        },
      },
    });
    expect(outcome).toMatchObject({ ok: true, value: 20 });
    expect(most).toBe(SCRIPT_PARALLEL);
  });

  it("sleeps with time.sleep and asyncio.sleep, the time asleep not counted toward its limit", async () => {
    const started = Date.now();
    const outcome = await python.run({
      code: "import asyncio, time\ntime.sleep(0.6)\nawait asyncio.sleep(0.6)\n'woke'",
      functions: {},
    });
    expect(outcome).toMatchObject({ ok: true, value: "woke" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
  });

  it("runs a call it gathers with a sleep while it sleeps", async () => {
    let ranAt = 0;
    const started = Date.now();
    const outcome = await python.run({
      code: "import asyncio\n(await asyncio.gather(asyncio.sleep(0.5), work()))[1]",
      functions: {
        work: async () => {
          ranAt = Date.now() - started;
          return "done";
        },
      },
    });
    expect(outcome).toMatchObject({ ok: true, value: "done" });
    expect(ranAt).toBeLessThan(400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it("stops at once when asked, while it sleeps either way", async () => {
    for (const code of ["import time\ntime.sleep(30)", "import asyncio\nawait asyncio.sleep(30)"]) {
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 100);
      const started = Date.now();
      const outcome = await python.run({ code, functions: {}, signal: stop.signal });
      expect(outcome).toMatchObject({ ok: false, error: "The script was stopped." });
      expect(Date.now() - started).toBeLessThan(900);
    }
  });

  it("refuses a sleep past what it may sleep in all, before sleeping", async () => {
    const short = createPython({ maxFeedDurationSecs: 1 }, { sleepSecs: 1 });
    try {
      const started = Date.now();
      const outcome = await short.run({
        code: "import asyncio, time\ntime.sleep(0.5)\nawait asyncio.sleep(0.6)",
        functions: {},
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: expect.stringContaining("RuntimeError: A script sleeps at most 1 seconds in all"),
      });
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      await short.close();
    }
  });
});

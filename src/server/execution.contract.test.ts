// Execution as its clients meet it: when a thread's agent starts on what waits for it, and how its
// runs are stopped, tried again and recovered. Everything is arranged and read through the API and
// through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, world } from "@/server/testing/contract.ts";

// When a run starts: what arrives, by where the thread's agent stands. People's messages and
// notices differ on purpose: a limit holds back a start on a notice, never one on a person's
// message.
describe("the agent starts", () => {
  it("on a person's message when idle, but not on an aside", async () => {
    const w = await world();
    await w.post(w.ada, "// an aside");
    await w.settled();
    expect(w.modelCalls()).toBe(0);
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId);
    await w.settled();
    expect(w.modelCalls()).toBe(1);
  });

  it("on a notice that wakes it when idle", async () => {
    const w = await world();
    const hook = await w.webhook("Deploys", "Check the deploy");
    const before = w.modelCalls();
    expect(await w.hook(hook.url, '{"ref":"main"}')).toBe(200);
    const call = await w.answers(w.threadId, "Checked.");
    expect(call.texts.at(-1)).toContain(
      "[Notifications] From agents and tools, not from a person.",
    );
    await w.settled();
    expect(w.modelCalls()).toBe(before + 1);
    expect((await w.shown()).rows.slice(-2)).toEqual([
      expect.stringMatching(/^webhook\.received: /),
      "agent (completed): Checked.",
    ]);
  });

  it("not on a notice that is quiet, which it reads with what next starts it", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId);
    await w.settled();
    expect(await w.act(w.ada, "PATCH", "", { title: "Renamed by hand" })).toBe(200);
    await w.settled();
    expect(w.modelCalls()).toBe(1);
    // It shows at once as a row, not among what waits.
    const shown = await w.shown();
    expect(shown.rows.at(-1)).toMatch(/^change: /);
    expect(shown.waiting).toEqual([]);
    expect(shown.run).toBeNull();

    await w.post(w.ada, "What changed?");
    const call = await w.answers(w.threadId);
    expect(call.texts.slice(-2)).toEqual([
      "user: [Ada Lovelace] What changed?",
      "user: [Notifications] From agents and tools, not from a person.\n\nAda Lovelace renamed the thread to Renamed by hand",
    ]);
    await w.settled();
    expect((await w.shown()).waiting).toEqual([]);
  });

  it("only once while a run is under way: what arrives waits for a step or for the next run", async () => {
    const w = await world();
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();
    const during = w.modelCalls();

    expect(await w.hook(hook.url, "one")).toBe(200);
    await w.post(w.grace, "And me");
    expect(w.modelCalls()).toBe(during);
    expect((await w.shown()).waiting).toHaveLength(2);

    // The run ends without a step taking them in, so the next run starts on them.
    first.end();
    const next = await w.answers(w.threadId, "Both read.");
    // People's messages are read first, then what the agent was told.
    expect(next.texts.slice(-2)).toEqual([
      "user: [Grace Hopper] And me",
      expect.stringContaining("[Notifications]"),
    ]);
    await w.settled();
    expect(w.modelCalls()).toBe(during + 1);
    expect((await w.shown()).waiting).toEqual([]);
  });

  it("not while its run waits on a person: messages and notices wait with it", async () => {
    const w = await world();
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Do the guarded thing");
    const { ids } = await w.asks(w.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );
    const during = w.modelCalls();

    await w.post(w.grace, "While you wait");
    expect(await w.hook(hook.url, "one")).toBe(200);
    await w.settled();
    expect(w.modelCalls()).toBe(during);
    const waiting = await w.shown();
    expect(waiting.run).toBe("decision");
    expect(waiting.waiting).toEqual([
      "Grace Hopper (steer): While you wait [nothing]",
      expect.stringMatching(/^webhook\.received: /),
    ]);

    // Once decided, the run goes on, and takes them in before it next asks the model.
    expect(await w.decide(w.ada, ids[0]!, true)).toBe(200);
    const resumed = await w.next(w.threadId);
    expect(resumed.texts.slice(-3)).toEqual([
      'result probe.guarded: {"ok":true,"value":{"did":"a"}}',
      "user: [Grace Hopper] While you wait",
      expect.stringContaining('Webhook "Deploys" was posted to: Check the deploy'),
    ]);
    resumed.reply("Done.");
    await w.settled();
    expect((await w.shown()).waiting).toEqual([]);
  });
});

// A thread's subagents run only so many at once; the rest wait their turn. The limit holds a
// subagent back from starting on what it is told, and on nothing else.
describe("a subagent past its starter's running limit", () => {
  const LIMIT = 4;

  async function crowded() {
    const w = await world();
    await w.post(w.ada, "Get help");
    const names = Array.from({ length: LIMIT + 2 }, (_, index) => `H${index}`);
    await w.asks(
      w.threadId,
      ...names.map((name): [string, unknown] => [
        "subagents.start",
        { name, task: `Task ${name}` },
      ]),
    );
    await w.answers(w.threadId, "Started them.");
    const threads: string[] = [];
    for (const name of names) threads.push(await w.subagentNamed(name));
    await eventually(
      () => threads.filter((id) => w.modelCalls(id) > 0).length,
      (running) => running === LIMIT,
    );
    const started = () => threads.map((id) => w.modelCalls(id) > 0);
    return { w, threads, started };
  }

  it("does not start on its task, until one of the others ends", async () => {
    const { w, threads, started } = await crowded();
    expect(started()).toEqual([true, true, true, true, false, false]);
    expect((await w.activity()).map((item) => item.work.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "queued",
      "queued",
    ]);

    await w.answers(threads[0]!, "Done.");
    await eventually(started, (now) => now[4] === true);
    expect(started()).toEqual([true, true, true, true, true, false]);
  });

  it("starts on a person's message all the same", async () => {
    const { w, threads, started } = await crowded();
    expect((await w.post(w.ada, "Start now", "steer", threads[4]!)).status).toBe(202);
    await eventually(started, (now) => now[4] === true);
    // One more than the limit now runs, and the last still waits its turn.
    expect(started()).toEqual([true, true, true, true, true, false]);
    const call = await w.next(threads[4]!);
    // It reads the person's message and the task it was held back from.
    expect(call.texts).toEqual([
      "user: You are the subagent H4, started by the agent of the thread Get help.",
      "user: [Ada Lovelace] Start now",
      "user: [Notifications] From agents and tools, not from a person.\n\n[Agent of Get help] Task H4",
    ]);
  });
});

describe("stopping", () => {
  it("ends the run where it is, by anyone who may post", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const call = await w.next(w.threadId);
    call.startStep();
    call.delta("Working on");
    await call.drained();
    expect(await w.act(w.alan, "POST", "/stop")).toBe(403);
    expect(await w.act(w.grace, "POST", "/stop")).toBe(202);
    await w.settled();
    expect(await w.shown()).toEqual({
      rows: ["Ada Lovelace: Go", "agent (interrupted): Working on", "stopped by Grace Hopper"],
      waiting: [],
      run: null,
    });
    // There is nothing to stop any more.
    expect(await w.act(w.ada, "POST", "/stop")).toBe(409);
  });

  it("ends a run that waits on a person, and the call will not run", async () => {
    const w = await world();
    await w.post(w.ada, "Do the guarded thing");
    const { ids } = await w.asks(w.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );
    expect(await w.act(w.ada, "POST", "/stop")).toBe(202);
    await w.settled();
    expect(await w.shown()).toEqual({
      rows: [
        "Ada Lovelace: Do the guarded thing",
        "agent (completed): On it.",
        "probe.guarded stopped",
        "stopped by Ada Lovelace",
      ],
      waiting: [],
      run: null,
    });
    expect(await w.decide(w.ada, ids[0]!, true)).toBe(409);
  });

  it("keeps what was queued, which starts the next run", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.post(w.grace, "Afterwards", "queue");
    expect(await w.act(w.ada, "POST", "/stop")).toBe(202);
    const next = await w.answers(w.threadId, "Now this.");
    expect(next.texts.at(-1)).toBe("user: [Grace Hopper] Afterwards");
    await w.settled();
  });
});

describe("trying again", () => {
  it("runs a failed run's input again, when a person asks", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    (await w.next(w.threadId)).fail("boom");
    await w.settled();
    const failed = await w.detail();
    const failure = failed.rows.at(-1)!;
    expect(failure).toMatchObject({ kind: "failure", canRetry: true });
    expect((await w.listed(w.grace)).status).toBe("failed");
    const runId = failure.kind === "failure" ? failure.runId : "";

    expect(await w.act(w.alan, "POST", "/retry", { runId })).toBe(403);
    expect(await w.act(w.grace, "POST", "/retry", { runId })).toBe(202);
    const again = await w.answers(w.threadId, "This time.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] Go"]);
    await w.settled();
    expect((await w.shown()).rows).toEqual([
      "Ada Lovelace: Go",
      "failed (model_error)",
      "agent (completed): This time.",
    ]);
    // Only the last run, and only while nothing has run since.
    expect(await w.act(w.ada, "POST", "/retry", { runId })).toBe(409);
  });

  it("writes a reply again in a branch of its own", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    await w.answers(w.threadId, "First try.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    expect(reply.can).toContain("retry");
    expect(await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id })).toBe(200);
    const again = await w.answers(w.threadId, "Second try.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] Go"]);
    await w.settled();
    const detail = await w.detail();
    expect((await w.shown()).rows).toEqual(["Ada Lovelace: Go", "agent (completed): Second try."]);
    expect(detail.rows.at(-1)?.versions).toMatchObject({ at: 1 });
  });
});

describe("a server that stops mid-run", () => {
  it("leaves the run failed, and its input is run again", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.crash();
    const retry = await w.answers(w.threadId, "Hello again.");
    expect(retry.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    await w.settled();
    expect((await w.shown()).rows).toEqual([
      "Ada Lovelace: Hello",
      "agent (failed): ",
      "failed (interrupted)",
      "agent (completed): Hello again.",
    ]);
  });

  it("gives up on an input that stopped it too many times", async () => {
    const w = await world({ maxAttempts: 2 });
    await w.post(w.ada, "Hello");
    await w.next(w.threadId);
    await w.crash();
    await w.next(w.threadId);
    await w.crash();
    await w.settled();
    const shown = await w.shown();
    expect(shown.rows.at(-1)).toBe("failed (gave_up)");
    expect(shown.run).toBeNull();
    expect(w.modelCalls()).toBe(2);
  });
});

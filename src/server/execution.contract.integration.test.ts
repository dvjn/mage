// Execution as its clients meet it: when a thread's agent starts on what waits for it, and how its
// runs are stopped, tried again and recovered. Everything is arranged and read through the API and
// through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, rowWords, world } from "@/server/testing/contract.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";

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
    expect(call.texts.at(-1)).toContain("[Notices] From agents and tools, not from a person.");
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
      "user: [Notices] From agents and tools, not from a person.\n\nAda Lovelace renamed the thread to Renamed by hand",
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
      expect.stringContaining("[Notices]"),
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
      "user: [Notices] From agents and tools, not from a person.\n\n[Agent of Get help] Task H4",
    ]);
  });

  // Started on a person's message past the limit, then sent a message by its starter's agent.
  async function pastTheLimit() {
    const crowd = await crowded();
    const { w, threads, started } = crowd;
    await w.post(w.ada, "Start now", "steer", threads[4]!);
    await eventually(started, (now) => now[4] === true);
    return { ...crowd, h4: await w.next(threads[4]!) };
  }

  // The model is next asked with the notice: the run takes it in at its step boundary, so this
  // arrangement never leaves it for a next run.
  it("starts its next run on a notice at once when its run ends, though past the limit", async () => {
    const { w, threads, started, h4 } = await pastTheLimit();
    await w.post(w.ada, "Tell H4");
    await w.asks(w.threadId, ["subagents.send", { to: "H4", text: "One more thing" }]);
    await w.answers(w.threadId, "Told.");
    await eventually(
      () => w.shown(w.ada, threads[4]!),
      (shown) => shown.waiting.length === 1,
    );

    h4.reply("Done.");
    const next = await w.next(threads[4]!);
    expect(next.texts.at(-1)).toBe(
      "user: [Notices] From agents and tools, not from a person.\n\n[Agent of Get help] One more thing",
    );
    expect(started()).toEqual([true, true, true, true, true, false]);
  });

  it("starts its next run on a person's queued message at once when its run ends", async () => {
    const { w, threads, started, h4 } = await pastTheLimit();
    expect((await w.post(w.grace, "Then this", "queue", threads[4]!)).status).toBe(202);
    h4.reply("Done.");
    const next = await w.next(threads[4]!);
    expect(next.texts.at(-1)).toBe("user: [Grace Hopper] Then this");
    expect(started()).toEqual([true, true, true, true, true, false]);
  });

  it("holds back what else it is told while it waits, and starts on all of it, oldest first", async () => {
    const { w, threads, started } = await crowded();
    await w.post(w.ada, "Tell H5");
    await w.asks(w.threadId, ["subagents.send", { to: "H5", text: "Also this" }]);
    await w.answers(w.threadId, "Told.");
    await eventually(
      () => w.shown(w.ada, threads[5]!),
      (shown) => shown.waiting.length === 2,
    );
    expect(started()[5]).toBe(false);

    // Two places free: H4 takes the first, H5 the second.
    await w.answers(threads[0]!, "Done.");
    await eventually(started, (now) => now[4] === true);
    await w.answers(threads[1]!, "Done.");
    await eventually(started, (now) => now[5] === true);
    const call = await w.next(threads[5]!);
    expect(call.texts.slice(1)).toEqual([
      "user: [Notices] From agents and tools, not from a person.\n\n[Agent of Get help] Task H5\n\n[Agent of Get help] Also this",
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
        "probe.guarded cancelled",
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

  it("ends the run of the branch left when its author edits the message, and answers the edit", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const old = await w.next(w.threadId);
    old.startStep();
    old.delta("Working on");
    await old.drained();
    const before = await w.detail();
    const message = before.rows[0]!;
    expect(
      await w.act(w.ada, "POST", "/history", { action: "edit", rowId: message.id, text: "Went" }),
    ).toBe(200);
    const edited = await w.answers(w.threadId, "Gone.");
    expect(edited.texts).toEqual(["user: [Ada Lovelace] Went"]);
    await w.settled();
    expect(old.signal.aborted).toBe(true);
    expect((await w.shown()).rows).toEqual(["Ada Lovelace: Went", "agent (completed): Gone."]);
    const left = await w.json<ThreadDetail>(
      await w.api("GET", `/threads/${w.threadId}?branch=${before.branch.id}`, w.ada.cookie),
    );
    expect(left.rows.map(rowWords)).toEqual([
      "Ada Lovelace: Go",
      "agent (interrupted): Working on",
      "stopped by Ada Lovelace",
    ]);
  });

  it("ends a run that waits on a person when a reply before it is written again", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const before = await w.detail();
    const reply = before.rows.at(-1)!;
    await w.post(w.ada, "Do the guarded thing");
    const { ids } = await w.asks(w.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );
    expect(await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id })).toBe(200);
    const again = await w.answers(w.threadId, "Hi again.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    await w.settled();
    const left = await w.json<ThreadDetail>(
      await w.api("GET", `/threads/${w.threadId}?branch=${before.branch.id}`, w.ada.cookie),
    );
    expect(left.rows.map(rowWords).slice(2)).toEqual([
      "Ada Lovelace: Do the guarded thing",
      "agent (completed): On it.",
      "probe.guarded cancelled",
      "stopped by Ada Lovelace",
    ]);
    // The call is on a branch no longer current, where nothing is decided.
    expect(await w.decide(w.ada, ids[0]!, true)).toBe(404);
    expect(w.tool.running("a")).toBe(false);
  });

  it("ends the run, naming nobody, when its space is archived or put in trash", async () => {
    for (const leave of ["archive", "trash"] as const) {
      const w = await world();
      const team = await w.teamThread();
      expect(await team.post("Go")).toBe(202);
      const call = await w.next(team.threadId);
      call.startStep();
      call.delta("Working on");
      await call.drained();
      expect(await team[leave]()).toBe(200);
      await w.settled();
      expect(call.signal.aborted).toBe(true);
      if (leave === "trash") expect(await team.restore()).toBe(200);
      expect(await team.shown()).toEqual({
        rows: ["Grace Hopper: Go", "agent (interrupted): Working on", "stopped by null"],
        run: null,
      });
    }
  });

  it("ends a run that waits on a person when its space is put in trash, and the call will not run", async () => {
    const w = await world();
    const team = await w.teamThread();
    expect(await team.post("Do the guarded thing")).toBe(202);
    const { ids } = await w.asks(team.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => team.shown(),
      (shown) => shown.run === "decision",
    );
    expect(await team.trash()).toBe(200);
    await w.settled();
    expect(await team.restore()).toBe(200);
    expect(await team.shown()).toEqual({
      rows: [
        "Grace Hopper: Do the guarded thing",
        "agent (completed): On it.",
        "probe.guarded cancelled",
        "stopped by null",
      ],
      run: null,
    });
    expect(await team.decide(ids[0]!, true)).toBe(409);
  });

  it("drops a waiting message of someone who lost their place, and the run goes on", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.post(w.grace, "From Grace", "queue");
    await w.post(w.ada, "From Ada", "queue");
    expect((await w.shown()).waiting).toHaveLength(2);
    await w.loses(w.grace);
    expect(call.signal.aborted).toBe(false);

    call.delta("Done.");
    call.endStep();
    call.end();
    const next = await w.answers(w.threadId, "And done.");
    expect(next.texts.at(-1)).toBe("user: [Ada Lovelace] From Ada");
    await w.settled();
    expect(await w.shown()).toEqual({
      rows: [
        "Ada Lovelace: Go",
        "agent (completed): Done.",
        "Ada Lovelace: From Ada",
        "agent (completed): And done.",
      ],
      waiting: [],
      run: null,
    });
  });

  // Deleting the org stops its runs as any stop does: a model call under way is cut at once.
  it("deletes the org's threads with a run under way", async () => {
    const w = await world();
    const team = await w.teamThread();
    expect(await team.post("Go")).toBe(202);
    const call = await w.next(team.threadId);
    call.startStep();
    await call.drained();
    expect(await team.deleteOrg()).toBe(200);
    expect(await team.status()).toBe(404);
    await eventually(
      () => call.signal.aborted,
      (aborted) => aborted,
    );
  });

  // As above, for a run that waits on a person, which is queued again for a worker to end.
  it("deletes the org's threads with a run that waits on a person", async () => {
    const w = await world();
    const team = await w.teamThread();
    expect(await team.post("Do the guarded thing")).toBe(202);
    await w.asks(team.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => team.shown(),
      (shown) => shown.run === "decision",
    );
    expect(await team.deleteOrg()).toBe(200);
    expect(await team.status()).toBe(404);
  });
});

describe("a person's stop where the agent started subagents", () => {
  // Has the thread's agent start two subagents, each of which starts on its task and is left
  // writing; the starter's run is left writing too unless it is answered.
  async function helped(answered: boolean) {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(
      w.threadId,
      ["subagents.start", { name: "One", task: "Task one" }],
      ["subagents.start", { name: "Two", task: "Task two" }],
    );
    const own = await w.next(w.threadId);
    if (answered) own.reply("Started.");
    else {
      own.startStep();
      await own.drained();
    }
    const helpers = [await w.subagentNamed("One"), await w.subagentNamed("Two")];
    const calls = [];
    for (const helper of helpers) {
      const call = await w.next(helper);
      call.startStep();
      call.delta("Helping");
      await call.drained();
      calls.push(call);
    }
    if (answered)
      await eventually(
        () => w.shown(),
        (shown) => shown.run === null,
      );
    return { w, own, helpers, calls };
  }

  it("ends its own run and theirs, and the starter's agent is not told of theirs", async () => {
    const { w, own, helpers, calls } = await helped(false);
    expect(await w.act(w.ada, "POST", "/stop")).toBe(202);
    await w.settled();
    expect(own.signal.aborted).toBe(true);
    expect(calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    expect((await w.shown()).rows.slice(-1)).toEqual(["stopped by Ada Lovelace"]);
    for (const [index, helper] of helpers.entries()) {
      expect(await w.shown(w.ada, helper)).toEqual({
        rows: [
          `message: Task ${["one", "two"][index]}`,
          "agent (interrupted): Helping",
          "stopped by Ada Lovelace",
        ],
        waiting: [],
        run: null,
      });
    }
    expect((await w.shown()).waiting).toEqual([]);
    expect(w.waitsForModel()).toBe(false);
  });

  it("ends theirs while its own agent is idle", async () => {
    const { w, helpers, calls } = await helped(true);
    expect(await w.act(w.ada, "POST", "/stop")).toBe(202);
    await w.settled();
    expect(calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    for (const helper of helpers) expect((await w.shown(w.ada, helper)).run).toBeNull();
    expect((await w.shown()).rows.at(-1)).toBe("agent (completed): Started.");
  });

  it("is refused when nothing runs, neither its own nor theirs", async () => {
    const { w, helpers, calls } = await helped(true);
    for (const call of calls) call.reply("Helped.");
    for (const helper of helpers) {
      await eventually(
        () => w.shown(w.ada, helper),
        (shown) => shown.run === null,
      );
    }
    // The starter's agent is told of each, and answers.
    for (;;) {
      const { asked } = await eventually(
        async () => ({ asked: w.waitsForModel(), shown: await w.shown() }),
        ({ asked, shown }) => asked || (shown.run === null && shown.waiting.length === 0),
      );
      if (!asked) break;
      await w.answers(w.threadId, "Noted.");
    }
    await w.settled();
    const res = await w.api("POST", `/threads/${w.threadId}/stop`, w.ada.cookie);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 409,
      body: { error: "The agent is not replying" },
    });
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

  it("reads a quiet notice that came after a failed run at the first step of its retry", async () => {
    const w = await world();
    const schedule = await w.schedule("Daily", "0 9 * * *", "Report");
    await w.post(w.ada, "Go");
    (await w.next(w.threadId)).fail("boom");
    await w.settled();
    const failure = (await w.detail()).rows.at(-1)!;
    const runId = failure.kind === "failure" ? failure.runId : "";
    expect(await w.act(w.ada, "POST", `/schedules/${schedule.id}/pause`)).toBe(200);
    await w.settled();
    expect(w.modelCalls()).toBe(3);

    const res = await w.api("POST", `/threads/${w.threadId}/retry`, w.ada.cookie, { runId });
    expect(await w.json(res, 202)).toMatchObject({
      type: "run.created",
      data: { reason: "retry" },
    });
    const again = await w.answers(w.threadId, "This time.");
    expect(again.texts.slice(-2)).toEqual([
      "user: [Ada Lovelace] Go",
      expect.stringMatching(/^user: \[Notices\] .*paused/s),
    ]);
    await w.settled();
  });

  it("runs a stopped run's input again, when a person asks", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    expect(await w.act(w.ada, "POST", "/stop")).toBe(202);
    await w.settled();
    const stop = (await w.detail()).rows.at(-1)!;
    const runId = stop.kind === "stop" ? stop.runId : "";
    expect(await w.act(w.ada, "POST", "/retry", { runId })).toBe(202);
    const again = await w.answers(w.threadId, "This time.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] Go"]);
    await w.settled();
  });

  it("is refused while a run is under way, and for a run that is not the last", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    (await w.next(w.threadId)).fail("boom");
    await w.settled();
    const failure = (await w.detail()).rows.at(-1)!;
    const failed = failure.kind === "failure" ? failure.runId : "";

    await w.post(w.ada, "Again");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    const running = (await w.detail()).run!.id;
    expect(await w.act(w.ada, "POST", "/retry", { runId: running })).toBe(409);
    call.reply("Done.");
    await w.settled();
    expect(await w.act(w.ada, "POST", "/retry", { runId: failed })).toBe(409);
  });

  it("takes in the edited message with those taken in beside it", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();
    await w.post(w.ada, "One");
    await w.post(w.grace, "Two");
    first.end();
    await w.answers(w.threadId, "Both read.");
    await w.settled();
    const one = (await w.detail()).rows.find((row) => row.kind === "human" && row.text === "One")!;

    expect(
      await w.act(w.ada, "POST", "/history", {
        action: "edit",
        rowId: one.id,
        text: "One, edited",
      }),
    ).toBe(200);
    const again = await w.answers(w.threadId, "Read again.");
    expect(again.texts.slice(-2)).toEqual([
      "user: [Grace Hopper] Two",
      "user: [Ada Lovelace] One, edited",
    ]);
    await w.settled();
    expect((await w.shown()).rows.slice(-3)).toEqual([
      "Grace Hopper: Two",
      "Ada Lovelace: One, edited",
      "agent (completed): Read again.",
    ]);
  });

  it("leaves a person's message behind when a reply is written again, and tells again a notice whose webhook came before", async () => {
    const w = await world();
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.post(w.grace, "While you work");
    expect(await w.hook(hook.url, "one")).toBe(200);
    expect((await w.shown()).waiting).toHaveLength(2);

    expect(await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id })).toBe(200);
    const again = await w.next(w.threadId);
    again.startStep();
    expect(await w.boundary(again)).toEqual([]);
    again.delta("Hi again.");
    again.endStep();
    again.end();
    expect(again.texts.slice(-2)).toEqual([
      "user: [Ada Lovelace] Hello",
      expect.stringContaining('Webhook "Deploys" was posted to: Check the deploy'),
    ]);
    await w.settled();
    expect(await w.shown()).toMatchObject({
      rows: expect.arrayContaining(["agent (completed): Hi again."]),
      waiting: [],
      run: null,
    });
    expect(w.modelCalls()).toBe(5);
  });

  it("leaves a notice behind when what sent it was made after the reply written again", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.post(w.grace, "While you work");
    expect(await w.hook(hook.url, "one")).toBe(200);
    expect((await w.shown()).waiting).toHaveLength(2);

    expect(
      await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id, confirm: true }),
    ).toBe(200);
    expect((await w.shown()).waiting).toEqual([]);
    const again = await w.answers(w.threadId, "Hi again.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    await w.settled();
    expect((await w.shown()).waiting).toEqual([]);
  });

  it("tells again a person's quiet change when a reply is written again", async () => {
    const w = await world();
    const schedule = await w.schedule("Daily", "0 9 * * *", "Report");
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    expect(await w.act(w.ada, "POST", `/schedules/${schedule.id}/pause`)).toBe(200);
    expect((await w.shown()).rows.at(-1)).toMatch(/^change: /);

    expect(await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id })).toBe(200);
    expect((await w.shown()).rows.filter((row) => row.startsWith("change: "))).toHaveLength(1);
    const again = await w.answers(w.threadId, "Hi again.");
    expect(again.texts.slice(-2)).toEqual([
      "user: [Ada Lovelace] Hello",
      expect.stringMatching(/^user: \[Notices\] .*paused/s),
    ]);
    await w.settled();
  });

  it("tells again a person's change, and leaves behind a notice whose webhook came after", async () => {
    const w = await world();
    const schedule = await w.schedule("Daily", "0 9 * * *", "Report");
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    expect(await w.hook(hook.url, "one")).toBe(200);
    expect(await w.act(w.ada, "POST", `/schedules/${schedule.id}/pause`)).toBe(200);

    expect(
      await w.act(w.ada, "POST", "/history", { action: "retry", rowId: reply.id, confirm: true }),
    ).toBe(200);
    const shown = await w.shown();
    expect(shown.waiting).toEqual([]);
    expect(shown.rows.filter((row) => row.startsWith("change: "))).toHaveLength(1);
    const again = await w.answers(w.threadId, "Hi again.");
    expect(again.texts.at(-1)).toMatch(/^user: \[Notices\] .*paused/s);
    expect(again.texts.join("\n")).not.toContain("Deploys");
    await w.settled();
  });

  it("tells again a subagent's report when the conversation is restored to after its start, which starts the agent", async () => {
    const w = await world();
    await w.post(w.ada, "Start");
    await w.asks(w.threadId, ["subagents.start", { name: "Researcher", task: "Look into it" }]);
    await w.answers(w.threadId, "Started.");
    const child = await w.subagentNamed("Researcher");
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await eventually(
      () => w.shown(),
      (shown) => shown.run === null,
    );
    const reply = (await w.detail()).rows.at(-1)!;
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    await w.asks(child, ["subagents.send", { to: "agent", text: "Found it" }]);
    await w.answers(child, "Reported.");
    await eventually(
      () => w.shown(),
      (shown) => shown.waiting.length === 1,
    );
    const calls = w.modelCalls();

    expect(await w.act(w.ada, "POST", "/history", { action: "restore", rowId: reply.id })).toBe(
      200,
    );
    const told = await w.answers(w.threadId, "Read it.");
    expect(told.texts.at(-1)).toContain("Found it");
    await w.settled();
    expect(await w.shown()).toMatchObject({ waiting: [], run: null });
    expect(w.modelCalls()).toBe(calls + 1);
  });

  // The notice the new branch reads waits there, though the branch left took it in.
  it("restores to a reply before the step boundary that took a notice in", async () => {
    const w = await world();
    const hook = await w.webhook("Deploys", "Check the deploy");
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();
    expect(await w.hook(hook.url, "one")).toBe(200);
    expect(await w.boundary(first)).toEqual([expect.stringContaining("[Notices]")]);
    first.reply("Done.");
    await w.settled();
    const working = (await w.detail()).rows.find(
      (row) => row.kind === "agent" && row.text === "Working.",
    )!;
    expect(await w.act(w.ada, "POST", "/history", { action: "restore", rowId: working.id })).toBe(
      200,
    );
    // It wakes the agent on the new branch, which reads it.
    const told = await w.answers(w.threadId, "Read again.");
    expect(told.texts.at(-1)).toContain('Webhook "Deploys" was posted to');
    await w.settled();
  });

  // No arrangement leaves two messages waiting as a run starts, so they are always
  // taken in by two events.
  it("keeps only what was taken in by the same event when the first of two messages is edited", async () => {
    const w = await world();
    await w.whileStopped(async () => {
      await w.post(w.ada, "One");
      await w.post(w.ada, "Two");
    });
    const first = await w.answers(w.threadId, "Both read.");
    expect(first.texts).toEqual(["user: [Ada Lovelace] One", "user: [Ada Lovelace] Two"]);
    await w.settled();
    const one = (await w.detail()).rows.find((row) => row.kind === "human" && row.text === "One")!;
    expect(
      await w.act(w.ada, "POST", "/history", {
        action: "edit",
        rowId: one.id,
        text: "One, edited",
      }),
    ).toBe(200);
    const again = await w.answers(w.threadId, "Read again.");
    expect(again.texts).toEqual(["user: [Ada Lovelace] One, edited"]);
    await w.settled();
  });

  it("restores the conversation to an earlier row without starting a run", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    await w.post(w.ada, "More");
    await w.answers(w.threadId, "Sure.");
    await w.settled();
    const before = await w.detail();
    const res = await w.api("POST", `/threads/${w.threadId}/history`, w.ada.cookie, {
      action: "restore",
      rowId: before.rows[1]!.id,
    });
    const { branchId } = await w.json<{ branchId: string }>(res);
    await w.settled();
    expect(branchId).not.toBe(before.branch.id);
    expect((await w.detail()).branch).toEqual({ id: branchId, current: true });
    expect(w.modelCalls()).toBe(2);
    expect((await w.shown()).run).toBeNull();
  });

  it("writes a reply again with another model, while retrying a failed run keeps the thread's", async () => {
    const w = await world();
    await w.offers("codex/gpt-small");
    await w.post(w.ada, "Hello");
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const reply = (await w.detail()).rows.at(-1)!;
    expect(
      await w.act(w.ada, "POST", "/history", {
        action: "retry",
        rowId: reply.id,
        with: { model: "codex/gpt-small" },
      }),
    ).toBe(200);
    await w.answers(w.threadId, "Hi, smaller.");
    await w.settled();
    expect((await w.detail()).rows.at(-1)).toMatchObject({
      kind: "agent",
      model: "codex/gpt-small",
    });

    await w.post(w.ada, "Go");
    (await w.next(w.threadId)).fail("boom");
    await w.settled();
    const failure = (await w.detail()).rows.at(-1)!;
    const runId = failure.kind === "failure" ? failure.runId : "";
    expect(await w.act(w.ada, "POST", "/retry", { runId })).toBe(202);
    await w.answers(w.threadId, "This time.");
    await w.settled();
    expect((await w.detail()).rows.at(-1)).toMatchObject({ kind: "agent", model: "codex/gpt-big" });
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

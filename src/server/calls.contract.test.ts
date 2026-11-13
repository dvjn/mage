// A tool call as its clients meet it, from asked for to ended: who may decide it, what each
// decision does, how it becomes a job, and what the model is told each time. Everything is
// arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, type World, world } from "@/server/testing/contract.ts";

// The thread with a guarded call asked for and waiting for a decision.
async function waitingCall(tool = "probe.guarded") {
  const w = await world();
  await w.post(w.ada, "Do the guarded thing");
  const { ids } = await w.asks(w.threadId, [tool, { label: "a" }]);
  await waits(w, "decision");
  return { w, callId: ids[0]! };
}

function waits(w: World, on: "decision" | "answer") {
  return eventually(
    () => w.shown(),
    (shown) => shown.run === on,
  );
}

async function callRow(w: World, callId: string, who = w.ada) {
  const row = (await w.detail(who)).rows.find((one) => one.id === callId);
  if (row?.kind !== "tool") throw new Error(`no call ${callId}`);
  return row;
}

// The last thing the tools gave back in what the model was sent.
function lastResult(texts: string[]) {
  return texts.findLast((text) => text.startsWith("result "));
}

describe("a call that runs at once", () => {
  it("gives the model its result in the same run", async () => {
    const w = await world();
    await w.post(w.ada, "Start and wait");
    const { ids } = await w.asks(w.threadId, ["probe.wait", { label: "a" }]);
    await eventually(
      () => w.tool.running("a"),
      (running) => running,
    );
    expect(await callRow(w, ids[0]!)).toMatchObject({
      state: "pending",
      waits: false,
      risk: "normal",
      canBackground: true,
    });
    expect((await w.shown()).run).toBe("running");
    w.tool.finish("a", { answer: 42 });
    const told = await w.answers(w.threadId);
    expect(lastResult(told.texts)).toBe('result probe.wait: {"ok":true,"value":{"answer":42}}');
    await w.settled();
    expect(await callRow(w, ids[0]!)).toMatchObject({ state: "ran", decision: null });
  });

  it("fails without a tool of that name, or with input the tool does not take", async () => {
    const w = await world();
    await w.post(w.ada, "Try these");
    await w.asks(w.threadId, ["probe.nothing", {}], ["probe.wait", { label: 7 }]);
    const told = await w.answers(w.threadId);
    expect(told.texts.filter((text) => text.startsWith("result "))).toEqual([
      expect.stringMatching(/^result probe\.nothing: \{"ok":false/),
      expect.stringMatching(/^result probe\.wait: \{"ok":false/),
    ]);
    await w.settled();
    expect((await w.shown()).rows.slice(2, 4)).toEqual([
      "probe.nothing failed",
      "probe.wait failed",
    ]);
  });
});

describe("a call that needs approval", () => {
  it("waits, and shows each reader what they may decide", async () => {
    const { w, callId } = await waitingCall();
    expect(w.modelCalls()).toBe(1);
    expect(await callRow(w, callId, w.ada)).toMatchObject({
      state: "pending",
      waits: true,
      risk: "ask",
      actions: ["allow", "deny"],
    });
    expect((await callRow(w, callId, w.grace)).actions).toEqual(["allow", "deny"]);
    expect((await callRow(w, callId, w.alan)).actions).toEqual([]);
    expect(await w.decide(w.alan, callId, true)).toBe(403);
    expect((await w.shown()).run).toBe("decision");
  });

  it("runs once approved, by a messager as well as the owner", async () => {
    const { w, callId } = await waitingCall();
    expect(await w.decide(w.grace, callId, true)).toBe(200);
    const told = await w.answers(w.threadId);
    expect(lastResult(told.texts)).toBe('result probe.guarded: {"ok":true,"value":{"did":"a"}}');
    await w.settled();
    expect(await callRow(w, callId)).toMatchObject({
      state: "ran",
      decision: { allow: true, scope: "once", by: { name: "Grace Hopper" } },
    });
    // A decision is made once.
    expect(await w.decide(w.ada, callId, false)).toBe(409);
  });

  it("does not run once denied, and the model is told", async () => {
    const { w, callId } = await waitingCall();
    expect(await w.decide(w.ada, callId, false)).toBe(200);
    const told = await w.answers(w.threadId);
    expect(lastResult(told.texts)).toBe(
      'result probe.guarded: {"ok":false,"error":"This action was not approved."}',
    );
    await w.settled();
    expect(await callRow(w, callId)).toMatchObject({
      state: "denied",
      decision: { allow: false, by: { name: "Ada Lovelace" } },
    });
  });

  it("is never approved for now when its tool asks every time", async () => {
    const { w, callId } = await waitingCall();
    expect(await w.decide(w.ada, callId, true, "for_now")).toBe(400);
    expect((await w.shown()).run).toBe("decision");
  });
});

describe("a call steered by someone who may not run its tool", () => {
  // Grace asks, then loses her place in the space before the agent acts on her words.
  async function steered() {
    const w = await world();
    await w.post(w.grace, "Rename it");
    await w.loses(w.grace);
    const { ids } = await w.asks(w.threadId, ["thread.rename", { title: "One" }]);
    await waits(w, "decision");
    return { w, callId: ids[0]! };
  }

  it("waits for someone who may, though its tool runs at once for them", async () => {
    const { w, callId } = await steered();
    expect(await callRow(w, callId)).toMatchObject({
      state: "pending",
      waits: true,
      risk: "normal",
      actions: ["allow", "allow_for_now", "deny"],
    });
    expect(await w.decide(w.ada, callId, true)).toBe(200);
    await w.answers(w.threadId);
    await w.settled();
    expect((await w.detail()).thread.title).toBe("One");
  });

  it("approved for now lets later calls of the tool run without asking", async () => {
    const { w, callId } = await steered();
    expect(await w.decide(w.ada, callId, true, "for_now")).toBe(200);
    const { ids } = await w.asks(w.threadId, ["thread.rename", { title: "Two" }]);
    await w.answers(w.threadId);
    await w.settled();
    expect(await callRow(w, ids[0]!)).toMatchObject({
      state: "ran",
      waits: false,
      standingOn: callId,
      decision: { allow: true, scope: "for_now", by: { name: "Ada Lovelace" } },
    });
    expect((await w.detail()).thread.title).toBe("Two");
  });
});

describe("a call that asks questions", () => {
  const questions = {
    questions: [
      {
        question: "Which one?",
        header: "Pick",
        options: [{ label: "One" }, { label: "Two" }],
      },
    ],
  };

  async function asking() {
    const w = await world();
    await w.post(w.ada, "Ask me");
    const { ids } = await w.asks(w.threadId, ["thread.ask", questions]);
    await waits(w, "answer");
    return { w, callId: ids[0]! };
  }

  it("waits for an answer from anyone who may post, and tells the model what they said", async () => {
    const { w, callId } = await asking();
    expect(await callRow(w, callId, w.grace)).toMatchObject({ state: "pending", canAnswer: true });
    expect((await callRow(w, callId, w.alan)).canAnswer).toBeFalsy();
    expect(
      await w.act(w.alan, "POST", `/tools/${callId}/answer`, { answers: { "Which one?": "Two" } }),
    ).toBe(403);
    expect(
      await w.act(w.grace, "POST", `/tools/${callId}/answer`, { answers: { "Which one?": "Two" } }),
    ).toBe(200);
    const told = await w.answers(w.threadId);
    expect(lastResult(told.texts)).toContain('"Which one?":"Two"');
    await w.settled();
    expect(await callRow(w, callId)).toMatchObject({
      state: "ran",
      answers: { "Which one?": "Two" },
      decision: { by: { name: "Grace Hopper" } },
    });
  });

  it("goes on without answers when someone skips them", async () => {
    const { w, callId } = await asking();
    expect(await w.act(w.ada, "POST", `/tools/${callId}/answer`, { answers: null })).toBe(200);
    const told = await w.answers(w.threadId);
    expect(lastResult(told.texts)).toBe('result thread.ask: {"ok":true,"value":{"skipped":true}}');
    await w.settled();
    expect(await callRow(w, callId)).toMatchObject({ state: "skipped" });
  });
});

describe("a job", () => {
  it("started by the agent runs on beside its runs, and tells it when it ends", async () => {
    const w = await world();
    await w.post(w.ada, "Start a job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    const started = await w.answers(w.threadId, "Started.");
    expect(lastResult(started.texts)).toMatch(
      /^result jobs\.start: \{"ok":true,"value":\{"id":"[^"]+","status":"running"\}\}$/,
    );
    await w.settled();
    expect(await w.shown()).toMatchObject({
      rows: [
        "Ada Lovelace: Start a job",
        "agent (completed): On it.",
        "calls.start ran",
        "probe.wait pending [running]",
        "agent (completed): Started.",
      ],
      run: null,
    });
    expect(await w.activity()).toMatchObject([
      { title: "Wait", work: { kind: "call", status: "running", canCancel: true } },
    ]);
    expect((await w.activity(w.alan))[0]).toMatchObject({ work: { canCancel: false } });

    w.tool.finish("a", { answer: 42 });
    const told = await w.answers(w.threadId, "Noted.");
    expect(told.texts.at(-1)).toMatch(
      /Background call \S+ \(Wait\) finished\n\nResult:\n\n\{"answer":42\}$/,
    );
    await w.settled();
    expect((await w.shown()).rows.slice(3)).toEqual([
      "probe.wait ran [done]",
      "agent (completed): Started.",
      expect.stringMatching(/^call\.ended: /),
      "agent (completed): Noted.",
    ]);
  });

  it("is cancelled by someone who may post, and the agent is not told", async () => {
    const w = await world();
    await w.post(w.ada, "Start a job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await w.answers(w.threadId, "Started.");
    await w.settled();
    const [job] = await w.activity();
    expect(await w.act(w.alan, "POST", `/tools/${job!.rowId}/cancel`)).toBe(403);
    expect(await w.act(w.grace, "POST", `/tools/${job!.rowId}/cancel`)).toBe(200);
    await w.settled();
    expect(w.tool.aborted).toEqual(["a"]);
    expect(w.modelCalls()).toBe(2);
    expect((await w.shown()).rows).toContain("probe.wait stopped [cancelled]");
    expect(await w.act(w.grace, "POST", `/tools/${job!.rowId}/cancel`)).toBe(409);
  });

  it("is what a running call becomes when a person moves it there, and the run goes on", async () => {
    const w = await world();
    await w.post(w.ada, "Start and wait");
    const { ids } = await w.asks(w.threadId, ["probe.wait", { label: "a" }]);
    await eventually(
      () => w.tool.running("a"),
      (running) => running,
    );
    expect(await w.act(w.alan, "POST", `/tools/${ids[0]}/background`)).toBe(403);
    expect(await w.act(w.grace, "POST", `/tools/${ids[0]}/background`)).toBe(200);
    const moved = await w.answers(w.threadId, "Carrying on.");
    expect(lastResult(moved.texts)).toMatch(
      /^result probe\.wait: \{"ok":true,"value":\{"movedToBackground":true,"callId":"[^"]+"\}\}$/,
    );
    await w.settled();
    // Today the call it was is recorded as run, and the job has a row and an id of its own.
    const shown = await w.shown();
    expect(shown.rows).toEqual([
      "Ada Lovelace: Start and wait",
      "agent (completed): On it.",
      "probe.wait ran",
      "probe.wait pending [running]",
      "agent (completed): Carrying on.",
    ]);
    const [job] = await w.activity();
    expect(job).toMatchObject({ title: "Wait", work: { kind: "call", status: "running" } });
    expect(job!.rowId).not.toBe(ids[0]);

    w.tool.finish("a", { answer: 42 });
    const told = await w.answers(w.threadId, "Noted.");
    expect(told.texts.at(-1)).toContain('(Wait) finished\n\nResult:\n\n{"answer":42}');
    await w.settled();
  });

  it("is what a call waiting for approval becomes when a person moves it there, where it is then decided", async () => {
    const { w, callId } = await waitingCall("probe.guarded_wait");
    expect(await w.act(w.ada, "POST", `/tools/${callId}/background`)).toBe(200);
    const moved = await w.answers(w.threadId, "Carrying on.");
    expect(lastResult(moved.texts)).toMatch(/"movedToBackground":true/);
    await w.settled();
    const [job] = await w.activity();
    expect(job).toMatchObject({
      work: { kind: "approval", status: "pending", canDecide: true },
      attention: "approval",
    });
    expect((await w.activity(w.alan))[0]).toMatchObject({ work: { canDecide: false } });
    expect((await w.shown()).run).toBeNull();

    expect(await w.decide(w.grace, job!.rowId, true)).toBe(200);
    await eventually(
      () => w.tool.running("a"),
      (running) => running,
    );
    expect((await w.activity())[0]).toMatchObject({ work: { status: "running" } });
    w.tool.finish("a", "done");
    await w.answers(w.threadId, "Noted.");
    await w.settled();
  });

  it("left running by a server that stopped is interrupted, and the agent is told", async () => {
    const w = await world();
    await w.post(w.ada, "Start a job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await w.answers(w.threadId, "Started.");
    await w.settled();
    await w.crashJobs();
    const told = await w.answers(w.threadId, "Noted.");
    expect(told.texts.at(-1)).toMatch(
      /Background call \S+ \(probe\.wait\) was interrupted: the server stopped while it ran\.$/,
    );
    await w.settled();
    expect((await w.shown()).rows).toContain("probe.wait failed [interrupted]");
  });
});

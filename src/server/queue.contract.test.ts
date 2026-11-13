// The queue as its clients meet it: what people send a thread's agent and what it is told wait in
// one ordered list until the agent takes them in, and their authors may still change them there.
// Everything is arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, world } from "@/server/testing/contract.ts";

describe("a message to an idle agent", () => {
  it("is taken in at once and answered, whatever its delivery", async () => {
    for (const mode of ["steer", "queue", "interrupt"]) {
      const w = await world();
      const posted = await w.post(w.ada, "Hello", mode);
      expect(posted.status).toBe(202);
      const call = await w.answers(w.threadId, "Hi.");
      expect(call.texts).toEqual(["user: [Ada Lovelace] Hello"]);
      await w.settled();
      expect(await w.shown()).toEqual({
        rows: ["Ada Lovelace: Hello", "agent (completed): Hi."],
        waiting: [],
        run: null,
      });
    }
  });

  it("is not taken in when it is an aside between people, until the agent next runs", async () => {
    const w = await world();
    await w.post(w.ada, "// just between us");
    await w.settled();
    expect(w.modelCalls()).toBe(0);
    expect(await w.shown()).toEqual({
      rows: ["Ada Lovelace: // just between us"],
      waiting: [],
      run: null,
    });
    await w.post(w.grace, "And now for the agent");
    const call = await w.answers(w.threadId);
    expect(call.texts).toEqual([
      "user: [Ada Lovelace] // just between us",
      "user: [Grace Hopper] And now for the agent",
    ]);
  });

  it("is refused from a viewer and from someone outside the space", async () => {
    const w = await world();
    expect((await w.post(w.alan, "May I?")).status).toBe(403);
    const eve = await w.signUp("Eve Outsider", "eve@example.com");
    expect((await w.post(eve, "May I?")).status).toBe(404);
    expect(w.modelCalls()).toBe(0);
  });
});

describe("a message to a busy agent", () => {
  it("steers the run at its next step, waits for the next run, or interrupts", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();

    const steer = await w.post(w.grace, "Also this", "steer");
    const queued = await w.post(w.ada, "Then that", "queue");
    expect(await w.shown()).toMatchObject({
      waiting: [
        "Grace Hopper (steer): Also this [nothing]",
        "Ada Lovelace (queue): Then that [edit+mode+remove]",
      ],
      run: "running",
    });
    // Each author may change only their own.
    expect((await w.shown(w.grace)).waiting).toEqual([
      "Grace Hopper (steer): Also this [edit+mode+remove]",
      "Ada Lovelace (queue): Then that [nothing]",
    ]);
    expect((await w.shown(w.alan)).waiting).toEqual([
      "Grace Hopper (steer): Also this [nothing]",
      "Ada Lovelace (queue): Then that [nothing]",
    ]);

    // The steering message is taken in at the step boundary; the queued one starts the next run.
    expect(await w.boundary(first)).toEqual(["user: [Grace Hopper] Also this"]);
    expect((await w.shown()).waiting).toEqual([
      "Ada Lovelace (queue): Then that [edit+mode+remove]",
    ]);
    first.reply("Both seen.");
    const second = await w.answers(w.threadId, "And that.");
    expect(second.texts).toEqual([
      "user: [Ada Lovelace] Go",
      "assistant: Working.",
      "user: [Grace Hopper] Also this",
      "assistant: Both seen.",
      "user: [Ada Lovelace] Then that",
    ]);
    await w.settled();
    expect(await w.shown()).toEqual({
      rows: [
        "Ada Lovelace: Go",
        "agent (completed): Working.",
        "Grace Hopper: Also this",
        "agent (completed): Both seen.",
        "Ada Lovelace: Then that",
        "agent (completed): And that.",
      ],
      waiting: [],
      run: null,
    });
    expect(steer.body.id).toBeTruthy();
    expect(queued.body.id).toBeTruthy();
  });

  it("interrupts the run, which is cut short, and is answered by the next", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.startStep();
    first.delta("Working on");
    await first.drained();
    await w.post(w.grace, "Stop, do this", "interrupt");
    const second = await w.answers(w.threadId, "Doing that.");
    expect(second.texts).toEqual([
      "user: [Ada Lovelace] Go",
      "assistant: Working on",
      "user: [Grace Hopper] Stop, do this",
    ]);
    await w.settled();
    expect((await w.shown()).rows).toEqual([
      "Ada Lovelace: Go",
      "agent (interrupted): Working on",
      "stopped by Grace Hopper",
      "Grace Hopper: Stop, do this",
      "agent (completed): Doing that.",
    ]);
  });

  it("can be reworded, switched between steering and queueing, and taken back by its author", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();
    const one = (await w.post(w.ada, "First thought", "queue")).body.id!;
    const two = (await w.post(w.ada, "Second thought", "queue")).body.id!;
    const three = (await w.post(w.grace, "Grace's thought", "queue")).body.id!;

    expect(await w.act(w.ada, "PATCH", `/messages/${one}`, { text: "First, reworded" })).toBe(200);
    expect(await w.act(w.ada, "PATCH", `/messages/${one}`, { mode: "steer" })).toBe(200);
    expect(await w.act(w.ada, "DELETE", `/messages/${two}`)).toBe(200);
    // Nobody changes another's, and nothing changes what is gone.
    expect(await w.act(w.ada, "PATCH", `/messages/${three}`, { text: "Mine now" })).toBe(403);
    expect(await w.act(w.ada, "DELETE", `/messages/${three}`)).toBe(403);
    expect(await w.act(w.ada, "PATCH", `/messages/${two}`, { text: "Back again" })).toBe(409);
    expect((await w.shown()).waiting).toEqual([
      "Ada Lovelace (steer): First, reworded [edit+mode+remove]",
      "Grace Hopper (queue): Grace's thought [nothing]",
    ]);

    expect(await w.boundary(first)).toEqual(["user: [Ada Lovelace] First, reworded"]);
    first.reply("Seen.");
    const second = await w.answers(w.threadId, "Done.");
    expect(second.texts).toEqual([
      "user: [Ada Lovelace] Go",
      "assistant: Working.",
      "user: [Ada Lovelace] First, reworded",
      "assistant: Seen.",
      "user: [Grace Hopper] Grace's thought",
    ]);
    await w.settled();
    // Once taken in, a message is no longer its author's to change.
    expect(await w.act(w.ada, "PATCH", `/messages/${one}`, { text: "Too late" })).toBe(409);
  });
});

describe("a message whose author may no longer post", () => {
  it("is dropped when the run would take it in, and the rest go on", async () => {
    const w = await world();
    await w.post(w.ada, "Go");
    const first = await w.next(w.threadId);
    first.step("Working.");
    await first.drained();
    await w.post(w.grace, "From someone about to lose their place", "queue");
    await w.post(w.ada, "From someone who keeps theirs", "queue");
    await w.loses(w.grace);
    first.reply("Seen.");
    const second = await w.answers(w.threadId, "Done.");
    expect(second.texts.filter((text) => text.startsWith("user: "))).toEqual([
      "user: [Ada Lovelace] Go",
      "user: [Ada Lovelace] From someone who keeps theirs",
    ]);
    await w.settled();
    expect(await w.shown()).toEqual({
      rows: [
        "Ada Lovelace: Go",
        "agent (completed): Working.",
        "agent (completed): Seen.",
        "Ada Lovelace: From someone who keeps theirs",
        "agent (completed): Done.",
      ],
      waiting: [],
      run: null,
    });
  });
});

describe("what the agent is told", () => {
  it("waits in the same list as people's messages, oldest first", async () => {
    const w = await world();
    await w.post(w.ada, "Start a job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    const busy = await w.next(w.threadId);
    busy.step("Started.");
    await busy.drained();

    await w.post(w.ada, "One from a person", "queue");
    w.tool.finish("a", { answer: 42 });
    const waiting = await eventually(
      () => w.shown(),
      (shown) => shown.waiting.length === 2,
    );
    expect(waiting.waiting).toEqual([
      "Ada Lovelace (queue): One from a person [edit+mode+remove]",
      expect.stringMatching(/^call\.ended: .* \[nothing\]$/),
    ]);

    // The notice steers the run at its next step; the queued message starts the next run.
    const told = await w.boundary(busy);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("[Notifications] From agents and tools, not from a person.");
    expect(told[0]).toContain('(Wait) finished\n\nResult:\n\n{"answer":42}');
    busy.reply("Noted.");
    const next = await w.answers(w.threadId, "Done.");
    expect(next.texts.at(-1)).toBe("user: [Ada Lovelace] One from a person");
    await w.settled();
    expect((await w.shown()).rows.slice(-4)).toEqual([
      expect.stringMatching(/^call\.ended: Background call .* \(Wait\) finished$/),
      "agent (completed): Noted.",
      "Ada Lovelace: One from a person",
      "agent (completed): Done.",
    ]);
    expect((await w.shown()).waiting).toEqual([]);
  });
});

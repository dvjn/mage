import { sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { LeaseLost } from "@/ports/runs.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import { eventSummary } from "@/services/thread-log.ts";

import { setup } from "./workspace.ts";

async function agentThread(options: Parameters<typeof setup>[0] = {}) {
  const workspace = setup(options);
  workspace.org.defaultModel = "codex/gpt-big";
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  const grace = workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    space.id,
    "messager",
  );
  async function post(who: { cookie: string }, text: string) {
    const res = await workspace.api("POST", `/threads/${thread.id}/messages`, who.cookie, { text });
    expect(res.status).toBe(202);
  }
  function events() {
    return workspace.threadStore.eventsAfter(thread.id, 0).map(eventSummary);
  }
  function types() {
    return events().map((event) => event.type);
  }
  // The transcript as people see it: who wrote each row and its text.
  function transcript() {
    return transcriptOf(events()).rows.map((row) =>
      row.kind === "human"
        ? `${row.author.name}: ${row.text}`
        : row.kind === "agent"
          ? `Agent (${row.status}): ${row.text}`
          : `${row.kind}`,
    );
  }
  function runs() {
    return workspace.db.all<{ id: string; status: string; reason: string | null; attempt: number }>(
      "select id, status, reason, attempt from run order by id",
    );
  }
  function start(worker = workspace.worker) {
    worker.start();
    onTestFinished(() => worker.stop());
  }
  return { ...workspace, ada, grace, space, thread, post, events, types, transcript, runs, start };
}

describe("agent runs", () => {
  it("wake on a message and reply in the thread", async () => {
    const { ada, model, worker, post, types, transcript, runs, start, thread } =
      await agentThread();
    start();

    await post(ada, "How do engines compute?");
    const call = await model.next();
    call.reply("With gears.");
    await worker.idle();

    expect(types()).toEqual([
      "message",
      "run.created",
      "message.admitted",
      "message.started",
      "message.completed",
      "run.completed",
    ]);
    expect(transcript()).toEqual([
      "Ada Lovelace: How do engines compute?",
      "Agent (completed): With gears.",
    ]);
    expect(runs()).toEqual([expect.objectContaining({ status: "completed", reason: null })]);
    expect(call.texts).toEqual(["user: [Ada Lovelace] How do engines compute?"]);
    expect(call.request.instructions).toContain("Mage");
    expect(call.request.instructions).toContain("Ada Lovelace");
    expect(call.request.sessionId).toBe(thread.id);
  });

  it("stores quiet asides without waking the agent, and shows them to it later", async () => {
    const { ada, grace, model, worker, post, types, start } = await agentThread();
    start();

    await post(grace, "// Ada, ask it about looms");
    await worker.idle();
    expect(types()).toEqual(["message"]);

    await post(ada, "What about looms?");
    const call = await model.next();
    expect(call.texts).toEqual([
      "user: [Grace Hopper] // Ada, ask it about looms",
      "user: [Ada Lovelace] What about looms?",
    ]);
    call.reply("Punched cards.");
    await worker.idle();
    expect(model.calls).toHaveLength(1);
  });

  it("takes in messages from several people that arrive before its first model call", async () => {
    const { ada, grace, model, worker, post, transcript, start } = await agentThread();

    await post(ada, "Hello");
    await post(grace, "Hello too");
    start();
    const call = await model.next();
    call.reply("Hello both.");
    await worker.idle();

    expect(call.texts).toEqual(["user: [Ada Lovelace] Hello", "user: [Grace Hopper] Hello too"]);
    expect(transcript()).toEqual([
      "Ada Lovelace: Hello",
      "Grace Hopper: Hello too",
      "Agent (completed): Hello both.",
    ]);
    expect(model.calls).toHaveLength(1);
  });

  it("answers messages that arrived during a run in one run after it", async () => {
    const { ada, grace, model, worker, post, transcript, runs, start } = await agentThread();
    start();

    await post(ada, "First");
    const first = await model.next();
    first.startStep();
    await post(grace, "Second");
    await post(ada, "Third");
    first.delta("One.");
    first.endStep();
    first.end();
    const next = await model.next();
    next.reply("Two and three.");
    await worker.idle();

    expect(next.texts).toEqual([
      "user: [Ada Lovelace] First",
      "assistant: One.",
      "user: [Grace Hopper] Second",
      "user: [Ada Lovelace] Third",
    ]);
    expect(transcript()).toEqual([
      "Ada Lovelace: First",
      "Agent (completed): One.",
      "Grace Hopper: Second",
      "Ada Lovelace: Third",
      "Agent (completed): Two and three.",
    ]);
    const [one, two] = runs();
    expect(two).toMatchObject({ status: "completed", reason: "queued_input" });
    expect(one?.status).toBe("completed");
  });

  it("fails with a message when the thread has no model", async () => {
    const { ada, org, db, thread, worker, post, transcript, runs, events, start } =
      await agentThread();
    org.defaultModel = null;
    db.run(sql`update thread set model = null where id = ${thread.id}`);
    start();

    await post(ada, "Hello");
    await worker.idle();

    expect(transcript()).toEqual(["Ada Lovelace: Hello", "failure"]);
    expect(runs()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(events().at(-1)).toMatchObject({ data: { error: "Pick a model for this thread." } });
  }, 1000);

  it("keeps the partial reply when the model fails mid-reply", async () => {
    const { ada, model, worker, post, transcript, events, start } = await agentThread();
    start();

    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Hel");
    call.fail("upstream broke");
    await worker.idle();

    expect(transcript()).toEqual(["Ada Lovelace: Hello", "Agent (failed): Hel", "failure"]);
    expect(events().at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: "The model failed: upstream broke" },
    });
  });
});

describe("run leases", () => {
  it("stop a worker whose lease was taken from writing anything more", async () => {
    const { ada, model, worker, runStore, post, types, start } = await agentThread();
    start();

    await post(ada, "Hello");
    const call = await model.next();
    const [running] = runStore.stale();
    // Another worker takes the run over, as recovery would.
    const taken = runStore.takeOver(running!.id, "other-worker", new Date(Date.now() + 60_000));
    expect(taken?.leaseEpoch).toBe(running!.leaseEpoch + 1);
    call.reply("Too late.");
    await worker.idle();

    expect(types()).toEqual(["message", "run.created", "message.admitted"]);
    expect(() =>
      runStore.hold({
        runId: running!.id,
        owner: running!.leaseOwner!,
        epoch: running!.leaseEpoch,
      }),
    ).toThrow(LeaseLost);
  });

  it("fail runs a stopped server left running and try their input again", async () => {
    const workspace = await agentThread();
    const { ada, model, post, transcript, runs, start, makeWorker } = workspace;
    const crashed = makeWorker();
    start(crashed);
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await crashed.stop();

    const restarted = makeWorker();
    restarted.recover();
    expect(transcript()).toEqual(["Ada Lovelace: Hello", "Agent (failed): ", "failure"]);
    start(restarted);
    const retry = await model.next();
    retry.reply("Hello again.");
    await restarted.idle();

    expect(runs()).toEqual([
      expect.objectContaining({ status: "failed", attempt: 1 }),
      expect.objectContaining({ status: "completed", reason: "retry", attempt: 2 }),
    ]);
    expect(retry.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    expect(transcript().at(-1)).toBe("Agent (completed): Hello again.");
  });

  it("give up on an input that stopped the server too many times", async () => {
    const workspace = await agentThread({ maxAttempts: 2 });
    const { ada, model, post, runs, makeWorker, events } = workspace;
    await post(ada, "Hello");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const crashed = makeWorker();
      crashed.recover();
      crashed.start();
      await model.next();
      await crashed.stop();
    }

    makeWorker().recover();

    expect(runs().map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["failed", 2],
    ]);
    expect(events().at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: "The agent stopped 2 times on this input and gave up." },
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "./agent-thread.ts";

describe("steering", () => {
  it("puts a steer between the reply it arrived during and one more step of the same run", async () => {
    const { ada, grace, model, worker, post, transcript, runs, start } = await agentThread();
    start();

    await post(ada, "How do engines compute?");
    const first = await model.next();
    first.startStep();
    first.delta("With gears");
    await post(grace, "Mention looms too");
    first.delta(".");
    first.endStep();
    first.end();
    const second = await model.next();
    second.reply("And looms.");
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: How do engines compute?",
      "Agent (completed): With gears.",
      "Grace Hopper: Mention looms too",
      "Agent (completed): And looms.",
    ]);
    expect(second.texts).toEqual([
      "user: [Ada Lovelace] How do engines compute?",
      "assistant: With gears.",
      "user: [Grace Hopper] Mention looms too",
    ]);
    expect(runs()).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("hands a steer to the model at a boundary between its steps", async () => {
    const { ada, grace, model, worker, post, transcript, start } = await agentThread();
    start();

    await post(ada, "How do engines compute?");
    const call = await model.next();
    call.step("With gears.");
    await call.drained();
    await post(grace, "Mention looms too");
    expect(call.boundary()).toEqual([{ role: "user", text: "[Grace Hopper] Mention looms too" }]);
    call.reply("And looms.");
    await worker.idle();

    expect(model.calls).toHaveLength(1);
    expect(transcript()).toEqual([
      "Ada Lovelace: How do engines compute?",
      "Agent (completed): With gears.",
      "Grace Hopper: Mention looms too",
      "Agent (completed): And looms.",
    ]);
  });

  it("leaves queued messages for the next run while a steer joins this one", async () => {
    const { ada, grace, model, worker, post, transcript, pending, runs, start } =
      await agentThread();
    start();

    await post(ada, "First");
    const first = await model.next();
    first.startStep();
    await post(grace, "Later, please", "queue");
    await post(ada, "Now, please");
    expect(pending()).toEqual([
      "Grace Hopper (queue): Later, please",
      "Ada Lovelace (steer): Now, please",
    ]);
    first.delta("One.");
    first.endStep();
    first.end();
    (await model.next()).reply("Two.");
    (await model.next()).reply("Three.");
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: First",
      "Agent (completed): One.",
      "Ada Lovelace: Now, please",
      "Agent (completed): Two.",
      "Grace Hopper: Later, please",
      "Agent (completed): Three.",
    ]);
    expect(runs().map((run) => [run.status, run.reason])).toEqual([
      ["completed", null],
      ["completed", "queued_input"],
    ]);
  });

  it("never steers with a quiet aside", async () => {
    const { ada, grace, model, worker, post, transcript, start } = await agentThread();
    start();

    await post(ada, "First");
    const call = await model.next();
    call.startStep();
    await post(grace, "// it is slow today");
    call.delta("One.");
    call.endStep();
    call.end();
    await worker.idle();

    expect(model.calls).toHaveLength(1);
    // The aside sits where it was posted, after the reply that had already begun.
    expect(transcript()).toEqual([
      "Ada Lovelace: First",
      "Agent (completed): One.",
      "Grace Hopper: // it is slow today",
    ]);
  });
});

describe("interrupting and stopping", () => {
  it("interrupt & send keeps the partial reply and starts a run with the message and the queue", async () => {
    const { ada, grace, model, worker, post, transcript, runs, events, start } =
      await agentThread();
    start();

    await post(ada, "Tell me everything");
    const first = await model.next();
    first.startStep();
    first.delta("Once upon");
    await first.drained();
    await post(ada, "Also this", "queue");
    await post(grace, "Stop, shorter please", "interrupt");
    const second = await model.next();
    second.reply("Short.");
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: Tell me everything",
      "Agent (interrupted): Once upon",
      "stopped by Grace Hopper",
      "Ada Lovelace: Also this",
      "Grace Hopper: Stop, shorter please",
      "Agent (completed): Short.",
    ]);
    const [cut, next] = runs();
    expect(cut?.status).toBe("cancelled");
    expect(next).toMatchObject({ status: "completed", reason: "interrupt" });
    expect(events().find((event) => event.type === "run.created" && event.seq > 3)).toMatchObject({
      actor: { name: "Grace Hopper" },
      data: { reason: "interrupt", continuesRunId: cut?.id },
    });
  });

  it("stop ends the run with what it wrote and who stopped it", async () => {
    const { api, ada, grace, thread, model, worker, post, transcript, runs, start, db } =
      await agentThread();
    start();

    await post(ada, "Tell me everything");
    const call = await model.next();
    call.startStep();
    call.delta("Once upon");
    await call.drained();
    expect((await api("POST", `/threads/${thread.id}/stop`, grace.cookie)).status).toBe(202);
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: Tell me everything",
      "Agent (interrupted): Once upon",
      "stopped by Grace Hopper",
    ]);
    expect(runs()).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(db.all<{ by: string }>("select cancel_requested_by as by from run")).toEqual([
      { by: grace.userId },
    ]);
    expect((await api("POST", `/threads/${thread.id}/stop`, ada.cookie)).status).toBe(409);
  });

  it("stops a run before its first model call when asked while it waits", async () => {
    const { api, ada, thread, model, worker, post, runs, start } = await agentThread();

    await post(ada, "Hello");
    expect((await api("POST", `/threads/${thread.id}/stop`, ada.cookie)).status).toBe(202);
    start();
    await worker.idle();

    expect(model.calls).toHaveLength(0);
    expect(runs()).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});

describe("waiting messages", () => {
  async function busyThread() {
    const thread = await agentThread();
    thread.start();
    await thread.post(thread.ada, "First");
    const call = await thread.model.next();
    const message = await thread.post(thread.grace, "Later", "queue");
    return { ...thread, call, message };
  }

  it("can be edited, switched between steer and queue, and withdrawn by their author", async () => {
    const { api, grace, thread, message, pending, call, worker } = await busyThread();
    const path = `/threads/${thread.id}/messages/${message.id}`;

    expect((await api("PATCH", path, grace.cookie, { text: "Sooner" })).status).toBe(200);
    expect((await api("PATCH", path, grace.cookie, { mode: "steer" })).status).toBe(200);
    expect(pending()).toEqual(["Grace Hopper (steer): Sooner"]);
    expect((await api("DELETE", path, grace.cookie)).status).toBe(200);
    expect(pending()).toEqual([]);

    call.reply("One.");
    await worker.idle();
  });

  it("are changed by no one else, and by no one once taken in", async () => {
    const { api, ada, grace, thread, message, call, model, worker } = await busyThread();
    const path = `/threads/${thread.id}/messages/${message.id}`;

    expect((await api("PATCH", path, ada.cookie, { text: "Mine now" })).status).toBe(403);
    expect((await api("DELETE", path, ada.cookie)).status).toBe(403);
    expect((await api("PATCH", path, grace.cookie, {})).status).toBe(400);
    expect((await api("PATCH", path, grace.cookie, { mode: "interrupt" })).status).toBe(400);
    call.reply("One.");
    (await model.next()).reply("Two.");
    await worker.idle();

    expect((await api("PATCH", path, grace.cookie, { text: "Too late" })).status).toBe(409);
    expect((await api("DELETE", path, grace.cookie)).status).toBe(409);
  });
});

describe("roles in runs", () => {
  it("let a viewer read but not post, steer, queue or stop", async () => {
    const { api, ada, alan, thread, model, worker, post, start } = await agentThread();
    start();
    await post(ada, "First");
    const call = await model.next();

    const attempts = [
      api("POST", `/threads/${thread.id}/messages`, alan.cookie, { text: "Hi" }),
      api("POST", `/threads/${thread.id}/messages`, alan.cookie, { text: "Hi", mode: "queue" }),
      api("POST", `/threads/${thread.id}/messages`, alan.cookie, { text: "Hi", mode: "interrupt" }),
      api("POST", `/threads/${thread.id}/stop`, alan.cookie),
    ];
    expect((await Promise.all(attempts)).map((res) => res.status)).toEqual([403, 403, 403, 403]);
    expect((await api("GET", `/threads/${thread.id}`, alan.cookie)).status).toBe(200);

    call.reply("One.");
    await worker.idle();
  });

  it("let a messager stop someone else's run", async () => {
    const { api, ada, grace, thread, model, worker, post, runs, start } = await agentThread();
    start();
    await post(ada, "First");
    await model.next();

    expect((await api("POST", `/threads/${thread.id}/stop`, grace.cookie)).status).toBe(202);
    await worker.idle();

    expect(runs()).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});

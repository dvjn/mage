import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { ModelError } from "@/server/models/gateway.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import { threadDetailSchema } from "@/shared/threads/detail.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { namedOtherwise } from "@/server/testing/named-tools.ts";
import { expireLeases } from "@/server/testing/database.ts";

import { LeaseLost } from "./worker.ts";

describe("agent runs", () => {
  it("wake on a message and reply in the thread", async () => {
    const { ada, model, worker, post, types, transcript, runs, start, thread } =
      await agentThread();
    await start();

    await post(ada, "How do engines compute?");
    const call = await model.next();
    call.reply("With gears.");
    await worker.idle();

    expect(await types()).toEqual([
      "message",
      "run.created",
      "message.admitted",
      "message.started",
      "message.completed",
      "run.completed",
    ]);
    expect(await transcript()).toEqual([
      "Ada Lovelace: How do engines compute?",
      "Agent (completed): With gears.",
    ]);
    expect(await runs()).toEqual([expect.objectContaining({ status: "completed", reason: null })]);
    expect(call.texts).toEqual(["user: [Ada Lovelace] How do engines compute?"]);
    expect(call.request.instructions).toContain("You are the agent in a thread");
    expect(call.request.sessionId).toBe(thread.id);
  });

  it("names tools in the prompt and in tools' descriptions only as the model calls them", async () => {
    const { ada, model, worker, post, start, space, tools } = await agentThread();
    const inSpace = { id: space.id, orgId: ada.orgId };
    await start();

    await post(ada, "Hello");
    const call = await model.next();
    call.reply("Hi.");
    await worker.idle();

    const { request } = call;
    const offered = [...(request.tools ?? []), ...(request.searchable ?? [])];
    expect(namedOtherwise(request, await tools.ids(inSpace))).toEqual([]);
    // Text naming a tool the space does not have fails here, and is logged on a server.
    const named = tools.textNamer(await tools.modelNames(inSpace));
    expect(named("thread.set_model")).toBe("thread__set_model");
    expect(() => named("thread.nope")).toThrow("Text for the model names thread.nope");
    expect(request.instructions).toContain("jobs__start");
    expect(request.instructions).toContain("thread__add_tasks");
    expect(request.instructions).toContain("space__save_memory");
    expect(request.instructions).toContain("scripts__run");
    expect(offered.map((tool) => tool.id)).toContain("scripts.run");
    expect(offered.find((tool) => tool.id === "thread.set_model")?.description).toContain(
      "thread__list_models",
    );
  });

  it("names the model on each reply and counts its tokens, and the thread's in total", async () => {
    const { ada, model, worker, post, events, start } = await agentThread();
    await start();

    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("One.");
    call.endStep({ inputTokens: 10, outputTokens: 2 });
    call.startStep();
    call.delta("Two.");
    call.endStep({ inputTokens: 12, outputTokens: 3 });
    call.end();
    await worker.idle();

    const started = (await events()).filter((event) => event.type === "message.started");
    expect(started.map((event) => event.data)).toEqual([
      expect.objectContaining({ model: "codex/gpt-big" }),
      expect.objectContaining({ model: "codex/gpt-big" }),
    ]);
    const { rows, usage } = transcriptOf(await events());
    expect(rows.filter((row) => row.kind === "agent").map((row) => [row.model, row.usage])).toEqual(
      [
        ["codex/gpt-big", { inputTokens: 10, outputTokens: 2 }],
        ["codex/gpt-big", { inputTokens: 12, outputTokens: 3 }],
      ],
    );
    expect(usage).toEqual({ inputTokens: 22, outputTokens: 5 });
  });

  it("persists per-reply costs and cache usage and totals reported and estimated calls", async () => {
    const { ada, model, worker, post, events, start, api, thread } = await agentThread();
    await start();
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("One.");
    call.endStep({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      cost: { usd: 0.005, source: "provider" },
    });
    call.startStep();
    call.delta("Two.");
    call.endStep({
      inputTokens: 2000,
      outputTokens: 200,
      cost: { usd: 0.01, source: "estimated" },
    });
    call.end();
    await worker.idle();

    const folded = transcriptOf(await events());
    expect(folded.usage).toMatchObject({
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 500,
      cost: { usd: 0.015, source: "mixed" },
    });
    const response = await api("GET", `/threads/${thread.id}`, ada.cookie);
    const detail = threadDetailSchema.parse(await response.json());
    expect(detail.rows.filter((row) => row.kind === "agent").map((row) => row.usage)).toEqual([
      {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cost: { usd: 0.005, source: "provider" },
      },
      { inputTokens: 2000, outputTokens: 200, cost: { usd: 0.01, source: "estimated" } },
    ]);
  });

  it("asks the model for the thread's reasoning effort", async () => {
    const { ada, model, worker, post, start, api, thread } = await agentThread();
    await start();

    await post(ada, "Hello");
    const usual = await model.next();
    usual.reply("Hi.");
    await worker.idle();
    await api("PATCH", `/threads/${thread.id}`, ada.cookie, { effort: "low" });
    await post(ada, "Again");
    const low = await model.next();
    low.reply("Hi.");
    await worker.idle();

    // A model that can think, asked for no effort, is asked for medium.
    expect(usual.request.effort).toBe("medium");
    expect(low.request.effort).toBe("low");
  });

  it("stores quiet asides without waking the agent, and shows them to it later", async () => {
    const { ada, grace, model, worker, post, types, start } = await agentThread();
    await start();

    await post(grace, "// Ada, ask it about looms");
    await worker.idle();
    expect(await types()).toEqual(["message"]);

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
    await start();
    const call = await model.next();
    call.reply("Hello both.");
    await worker.idle();

    expect(call.texts).toEqual(["user: [Ada Lovelace] Hello", "user: [Grace Hopper] Hello too"]);
    expect(await transcript()).toEqual([
      "Ada Lovelace: Hello",
      "Grace Hopper: Hello too",
      "Agent (completed): Hello both.",
    ]);
    expect(model.calls).toHaveLength(1);
  });

  it("answers queued messages together in the run after the one under way", async () => {
    const { ada, grace, model, worker, post, transcript, runs, start } = await agentThread();
    await start();

    await post(ada, "First");
    const first = await model.next();
    first.startStep();
    await post(grace, "Second", "queue");
    await post(ada, "Third", "queue");
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
    expect(await transcript()).toEqual([
      "Ada Lovelace: First",
      "Agent (completed): One.",
      "Grace Hopper: Second",
      "Ada Lovelace: Third",
      "Agent (completed): Two and three.",
    ]);
    const [one, two] = await runs();
    expect(two).toMatchObject({ status: "completed", reason: "queued_input" });
    expect(one?.status).toBe("completed");
  });

  it("fails with a message when the thread has no model", async () => {
    const { ada, models, db, thread, worker, post, transcript, runs, events, start } =
      await agentThread();
    // With no model listed, nothing can reply in its place.
    await models.default(null);
    await models.set([]);
    await db.execute(sql`update thread set model = null where id = ${thread.id}`);
    await start();

    await post(ada, "Hello");
    await worker.idle();

    expect(await transcript()).toEqual(["Ada Lovelace: Hello", "failure"]);
    expect(await runs()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect((await events()).at(-1)).toMatchObject({ data: { kind: "no_model" } });
  });

  it("keeps the partial reply when the model fails mid-reply", async () => {
    const { ada, model, worker, post, transcript, events, start } = await agentThread();
    await start();

    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Hel");
    call.fail("upstream broke");
    await worker.idle();

    expect(await transcript()).toEqual(["Ada Lovelace: Hello", "Agent (failed): Hel", "failure"]);
    expect((await events()).at(-1)).toMatchObject({
      type: "run.failed",
      data: { kind: "model_error", error: "upstream broke" },
    });
  });
});

describe("failures", () => {
  it("say what kind of failure it was, through which connection, and what the provider said", async () => {
    const { ada, model, worker, post, events, start } = await agentThread();
    await start();

    await post(ada, "Hello");
    const call = await model.next();
    call.fail(
      new ModelError("limit", "429 (empty body)\nretry-after: 60", new Date(1792000000000)),
    );
    await worker.idle();

    expect((await events()).at(-1)).toMatchObject({
      type: "run.failed",
      data: {
        error: "",
        kind: "limit",
        connection: "codex",
        detail: "429 (empty body)\nretry-after: 60",
        resetsAt: new Date(1792000000000).toISOString(),
      },
    });
  });

  it("is a sign-in failure when the thread's model has no connection", async () => {
    const { ada, post, events, start, makeWorker } = await agentThread();
    const noConnection = makeWorker({
      models: {
        replyModel: (_space, own) => {
          const ok = { ref: own.model ?? "codex/gpt-big", name: "", status: "ok" as const };
          return Promise.resolve({ chosen: ok, used: ok, effort: null });
        },
        open: () =>
          Promise.reject(new ModelError("auth", "codex/gpt-big needs a Codex connection.")),
      },
    });
    await start(noConnection);

    await post(ada, "Hello");
    await noConnection.idle();

    expect((await events()).at(-1)).toMatchObject({
      type: "run.failed",
      data: {
        kind: "auth",
        connection: "codex",
        error: "",
      },
    });
  });
});

describe("retrying", () => {
  async function failedThread() {
    const workspace = await agentThread();
    const { ada, model, worker, post, start } = workspace;
    await start();
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Hel");
    call.fail(new ModelError("network", "503 upstream"));
    await worker.idle();
    return workspace;
  }

  function retry(
    workspace: Awaited<ReturnType<typeof agentThread>>,
    who: { cookie: string },
    runId: string,
  ) {
    return workspace.api("POST", `/threads/${workspace.thread.id}/retry`, who.cookie, { runId });
  }

  it("tries a failed run again without the reply it cut short", async () => {
    const workspace = await failedThread();
    const { ada, model, worker, runs, transcript } = workspace;
    const [failed] = await runs();

    const res = await retry(workspace, ada, failed!.id);
    expect(res.status).toBe(202);
    const call = await model.next();
    call.reply("Hello.");
    await worker.idle();

    expect(call.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    expect(await runs()).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "completed", reason: "retry", attempt: 1 }),
    ]);
    expect(
      (await workspace.db.execute<{ continues_run_id: string }>("select continues_run_id from run"))
        .rows[1],
    ).toEqual({ continues_run_id: failed!.id });
    expect(await transcript()).toEqual([
      "Ada Lovelace: Hello",
      "Agent (failed): Hel",
      "failure",
      "Agent (completed): Hello.",
    ]);
  });

  it("tries a stopped run again", async () => {
    const workspace = await agentThread();
    const { ada, model, worker, post, start, runs, api, thread } = workspace;
    await start();
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Hel");
    await call.drained();
    await api("POST", `/threads/${thread.id}/stop`, ada.cookie);
    await worker.idle();
    const [stopped] = await runs();
    expect(stopped?.status).toBe("cancelled");

    expect((await retry(workspace, ada, stopped!.id)).status).toBe(202);
    (await model.next()).reply("Hello.");
    await worker.idle();

    expect((await runs()).at(-1)).toMatchObject({ status: "completed", reason: "retry" });
  });

  it("refuses a run that is not the thread's last, or while the agent replies", async () => {
    const workspace = await failedThread();
    const { ada, alan, model, runs } = workspace;
    const [failed] = await runs();

    expect((await retry(workspace, alan, failed!.id)).status).toBe(403);
    expect((await retry(workspace, ada, "nope")).status).toBe(409);
    expect((await retry(workspace, ada, failed!.id)).status).toBe(202);
    expect((await retry(workspace, ada, failed!.id)).status).toBe(409);
    (await model.next()).reply("Hello.");
    await workspace.worker.idle();
    expect((await retry(workspace, ada, failed!.id)).status).toBe(409);
  });
});

describe("run leases", () => {
  it("stop a worker whose lease was taken from writing anything more", async () => {
    const { ada, model, worker, runStore, post, types, start, db } = await agentThread();
    await start();

    await post(ada, "Hello");
    const call = await model.next();
    // Another worker takes the run over once its lease has run out, as recovery would.
    expect(await runStore.stale()).toEqual([]);
    await expireLeases(db, "run");
    const [running] = await runStore.stale();
    const taken = await runStore.takeOver(running!.id, "other-worker", 60_000);
    expect(taken?.leaseEpoch).toBe(running!.leaseEpoch + 1);
    call.reply("Too late.");
    await worker.idle();

    expect(await types()).toEqual(["message", "run.created", "message.admitted"]);
    await expect(
      runStore.hold({
        runId: running!.id,
        owner: running!.leaseOwner!,
        epoch: running!.leaseEpoch,
      }),
    ).rejects.toThrow(LeaseLost);
  });

  it("fail runs a stopped server left running and try their input again", async () => {
    const workspace = await agentThread();
    const { ada, model, post, transcript, runs, start, makeWorker } = workspace;
    const crashed = makeWorker();
    await start(crashed);
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    await call.drained();
    await crashed.stop();

    const restarted = makeWorker();
    await restarted.recover();
    expect(await transcript()).toEqual(["Ada Lovelace: Hello", "Agent (failed): ", "failure"]);
    await start(restarted);
    const retry = await model.next();
    retry.reply("Hello again.");
    await restarted.idle();

    expect(await runs()).toEqual([
      expect.objectContaining({ status: "failed", attempt: 1 }),
      expect.objectContaining({ status: "completed", reason: "retry", attempt: 2 }),
    ]);
    expect(retry.texts).toEqual(["user: [Ada Lovelace] Hello"]);
    expect((await transcript()).at(-1)).toBe("Agent (completed): Hello again.");
  });

  it("give up on an input that stopped the server too many times", async () => {
    const workspace = await agentThread({ maxAttempts: 2 });
    const { ada, model, post, runs, makeWorker, events } = workspace;
    await post(ada, "Hello");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const crashed = makeWorker();
      await crashed.recover();
      await crashed.start();
      await model.next();
      await crashed.stop();
    }

    await makeWorker().recover();

    expect((await runs()).map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["failed", 2],
    ]);
    expect((await events()).at(-1)).toMatchObject({
      type: "run.failed",
      data: { kind: "gave_up" },
    });
  });
});

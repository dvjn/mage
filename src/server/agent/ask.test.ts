import { describe, expect, it } from "vite-plus/test";

import { EDITORS } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { agentThread } from "@/server/testing/agent-thread.ts";

const QUESTIONS = {
  questions: [
    {
      question: "Which quarter?",
      header: "Quarter",
      options: [{ label: "Q3" }, { label: "Q4", description: "The latest" }],
    },
    {
      question: "What should it include?",
      header: "Include",
      multiSelect: true,
      options: [{ label: "Revenue" }, { label: "Pipeline" }, { label: "Churn" }],
    },
  ],
};

const ANSWERS = { "Which quarter?": "Q4", "What should it include?": ["Revenue", "Pipeline"] };

// A thread where the agent asks Ada's space questions; Hedy is a guest of the thread.
async function askThread() {
  const workspace = await agentThread();
  const { signUp, guestStore, thread, api, ada, events, model } = workspace;
  const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
  guestStore.grant({
    threadId: thread.id,
    userId: hedy.userId,
    invitedBy: ada.userId,
    accessUntil: null,
  });

  // The model's next call, asking for the tool calls in one step.
  async function calls(...asked: [string, unknown][]) {
    const call = await model.next();
    call.startStep();
    call.delta("Let me check.");
    for (const [index, [toolId, input]] of asked.entries()) {
      call.toolCall(`call-${model.calls.length}-${index}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }
  function tools() {
    return transcriptOf(events()).rows.filter((row) => row.kind === "tool");
  }
  function answer(who: { cookie: string }, callId: string, answers: unknown) {
    return api("POST", `/threads/${thread.id}/tools/${callId}/answer`, who.cookie, { answers });
  }
  function decideCall(who: { cookie: string }, callId: string) {
    return api("POST", `/threads/${thread.id}/tools/${callId}/decision`, who.cookie, {
      allow: true,
    });
  }
  function policy(fields: {
    use: "everyone" | "some" | "none";
    users?: string[];
    approvers?: string[];
  }) {
    return workspace.toolPolicyStore.create({
      orgId: ada.orgId,
      spaceId: null,
      name: "Leads",
      color: "orange",
      users: [],
      approvers: [EDITORS],
      independent: false,
      ...fields,
    });
  }
  return { ...workspace, hedy, calls, tools, answer, decideCall, policy };
}

describe("asking questions", () => {
  it("waits for an answer from anyone who may post, then gives the model the answers", async () => {
    const { ada, grace, alan, post, calls, worker, start, runStore, thread, api, space } =
      await askThread();
    start();
    await post(ada, "Make me a report");
    const first = await calls(["thread.ask", QUESTIONS]);
    await worker.idle();

    expect(first.tools).toContain("thread.ask");
    expect(runStore.active(thread.id)).toMatchObject({ status: "waiting" });
    const activityFor = async (who: { cookie: string }) => {
      const list = (await (await api("GET", `/spaces/${space.id}/threads`, who.cookie)).json()) as {
        id: string;
        activity: unknown;
      }[];
      return list.find((item) => item.id === thread.id)?.activity;
    };
    expect(await activityFor(grace)).toMatchObject({
      run: { status: "waiting", toolId: "thread.ask" },
      canApprove: true,
    });
    expect(await activityFor(alan)).toMatchObject({ canApprove: false });
    const detail = (await (await api("GET", `/threads/${thread.id}`, grace.cookie)).json()) as {
      pendingTools: Record<string, { canDecide: boolean }>;
    };
    expect(Object.values(detail.pendingTools)).toEqual([
      expect.objectContaining({ canDecide: true }),
    ]);
  });

  it("lets the first answer win, and refuses viewers, other calls and decisions", async () => {
    const workspace = await askThread();
    const { ada, grace, alan, post, calls, model, worker, start, tools, answer, decideCall } =
      workspace;
    start();
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();
    const callId = tools()[0]!.id;

    expect((await decideCall(ada, callId)).status).toBe(409);
    expect((await answer(alan, callId, ANSWERS)).status).toBe(403);
    expect((await answer(grace, callId, ANSWERS)).status).toBe(200);
    expect((await answer(ada, callId, ANSWERS)).status).toBe(409);
    const next = await model.next();
    next.reply("Here it is.");
    await worker.idle();

    expect(workspace.transcript().slice(-2)).toEqual([
      "thread.ask (ran by Grace Hopper)",
      "Agent (completed): Here it is.",
    ]);
    expect(tools()[0]).toMatchObject({ answers: ANSWERS });
    expect(next.texts.at(-1)).toBe(
      `result thread.ask: ${JSON.stringify({ ok: true, value: { answers: ANSWERS } })}`,
    );

    // A call that asks nothing takes no answer.
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Report" }]);
    (await model.next()).reply("Renamed.");
    await worker.idle();
    expect((await answer(ada, tools()[1]!.id, ANSWERS)).status).toBe(409);
  });

  it("refuses answers that do not fit the questions", async () => {
    const { ada, post, calls, worker, start, tools, answer } = await askThread();
    start();
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();
    const callId = tools()[0]!.id;

    const refused = async (answers: unknown) => {
      const res = await answer(ada, callId, answers);
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    expect(await refused({ "Which quarter?": "Q4" })).toEqual({
      status: 400,
      error: "Answer: What should it include?",
    });
    expect(await refused({ ...ANSWERS, "Which quarter?": ["Q3", "Q4"] })).toMatchObject({
      status: 400,
      error: "Pick one answer to: Which quarter?",
    });
    expect(await refused({ ...ANSWERS, "Why?": "No" })).toMatchObject({ status: 400 });
    expect(await refused({ ...ANSWERS, "What should it include?": [] })).toMatchObject({
      status: 400,
    });
    // Anyone's own words are an answer.
    expect(
      (await answer(ada, callId, { ...ANSWERS, "Which quarter?": "Last year's" })).status,
    ).toBe(200);
  });

  it("lets someone skip the questions, and tells the model they were skipped", async () => {
    const workspace = await askThread();
    const { ada, grace, post, calls, model, worker, start, tools, answer } = workspace;
    start();
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();

    expect((await answer(grace, tools()[0]!.id, null)).status).toBe(200);
    const next = await model.next();
    next.reply("I'll pick for you.");
    await worker.idle();

    expect(tools()[0]).toMatchObject({ state: "skipped", decision: { allow: false } });
    expect(next.texts.at(-1)).toBe('result thread.ask: {"ok":true,"value":{"skipped":true}}');
    expect((await answer(ada, tools()[0]!.id, ANSWERS)).status).toBe(409);
  });

  it("is no longer needed once the run is stopped", async () => {
    const { ada, post, calls, worker, start, tools, answer, api, thread } = await askThread();
    start();
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();

    await api("POST", `/threads/${thread.id}/stop`, ada.cookie);
    await worker.idle();
    expect(tools()[0]).toMatchObject({ state: "stopped" });
    expect((await answer(ada, tools()[0]!.id, ANSWERS)).status).toBe(409);
  });

  it("lets anyone who can post answer, whatever policy was stored for it", async () => {
    const { ada, grace, post, calls, model, worker, start, tools, answer, toolSettings, policy } =
      await askThread();
    toolSettings.setInOrg(
      ada.orgId,
      ["thread.ask"],
      policy({ use: "none", approvers: [`user:${ada.userId}`] }).id,
    );
    start();
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();

    expect((await answer(grace, tools()[0]!.id, ANSWERS)).status).toBe(200);
    (await model.next()).reply("Thanks.");
    await worker.idle();
    expect(tools()[0]).toMatchObject({ state: "ran" });
  });

  it("counts an answer as its writer's words when later calls are decided", async () => {
    const { ada, grace, post, calls, worker, start, tools, answer, toolSettings, policy } =
      await askThread();
    // Only Ada uses renaming directly; anyone who can edit approves.
    toolSettings.setInOrg(
      ada.orgId,
      ["thread.rename"],
      policy({ use: "some", users: [`user:${ada.userId}`] }).id,
    );
    start();
    await post(ada, "Name it after what Grace picks");
    await calls(["thread.ask", QUESTIONS]);
    await worker.idle();

    expect((await answer(grace, tools()[0]!.id, ANSWERS)).status).toBe(200);
    await calls(["thread.rename", { title: "Q4 report" }]);
    await worker.idle();

    // Grace's answer is words the model read, and she may not rename directly.
    expect(tools()[1]).toMatchObject({ toolId: "thread.rename", state: "pending", waits: true });
  });

  it("lets a guest of the thread answer, and drops the answer once their access ends", async () => {
    const workspace = await askThread();
    const { ada, hedy, post, calls, model, start, makeWorker, tools, answer } = workspace;
    const first = makeWorker();
    start(first);
    await post(ada, "Make me a report");
    await calls(["thread.ask", QUESTIONS]);
    await first.idle();
    await first.stop();

    expect((await answer(hedy, tools()[0]!.id, ANSWERS)).status).toBe(200);
    workspace.guestStore.revoke(workspace.thread.id, hedy.userId, ada.userId, new Date());
    const second = makeWorker();
    start(second);
    const next = await model.next();
    next.reply("Fine.");
    await second.idle();

    expect(tools()[0]).toMatchObject({ state: "stale" });
    expect(next.texts.at(-1)).toBe(
      'result thread.ask: {"ok":false,"error":"This action was not approved."}',
    );
  });
});

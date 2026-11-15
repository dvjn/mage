import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { Influencer } from "@/shared/threads/events.ts";

import { NOTICES_HEADING } from "@/server/execution/context.ts";

import { type Notice, silentChange } from "./notices.ts";

// A thread whose agent is sent notifications, as any feature sends them.
async function notifiedThread() {
  const workspace = await agentThread();
  const { queue, thread } = workspace;
  const notices = {
    send: async (threadId: string, notice: Notice) =>
      queue.enqueue(threadId, { kind: "notice", notice }),
  };
  const note = (text: string, people: Influencer[] = []): Notice => ({
    kind: "agent.idle",
    source: { threadId: thread.id, name: "Watcher", main: true },
    text,
    influence: people,
  });
  const send = async (text: string, people?: Influencer[]) =>
    notices.send(thread.id, note(text, people));
  const sendQuietly = async (by: string, text: string) =>
    notices.send(thread.id, silentChange(thread.id, by, text));
  return { ...workspace, send, sendQuietly };
}

// What the model reads of notifications taken in together.
function notified(...lines: string[]) {
  return [NOTICES_HEADING, ...lines].join("\n\n");
}

describe("notifications", () => {
  it("start an idle agent", async () => {
    const { model, worker, start, send, transcript, runs } = await notifiedThread();
    await start();
    await send("All idle: Researcher");
    const call = await model.next();
    expect(call.texts).toEqual([`user: ${notified("All idle: Researcher")}`]);
    call.reply("Noted.");
    await worker.idle();
    expect(await transcript()).toEqual(["notice", "Agent (completed): Noted."]);
    expect(await runs()).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("wait for a busy agent's next pause, and are taken in together", async () => {
    const { ada, model, worker, start, post, send, transcript } = await notifiedThread();
    await start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    await send("Idle: Researcher");
    await send("Idle: Writer");
    expect(await call.boundary()).toEqual([
      { role: "user", text: notified("Idle: Researcher", "Idle: Writer") },
    ]);
    call.reply("Both noted.");
    await worker.idle();
    expect(model.calls).toHaveLength(1);
    expect(await transcript()).toEqual([
      "Ada Lovelace: Go",
      "Agent (completed): Working.",
      "notice",
      "notice",
      "Agent (completed): Both noted.",
    ]);
  });

  it("wait with people's messages in one list, oldest first, which only authors may change", async () => {
    const { ada, grace, api, thread, model, worker, start, post, send } = await notifiedThread();
    await start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    const postAs = (who: { cookie: string }, body: object) =>
      api("POST", `/threads/${thread.id}/messages`, who.cookie, body);
    expect((await postAs(ada, { text: "Then this", mode: "queue" })).status).toBe(202);
    await send("Idle: Researcher");
    expect((await postAs(grace, { text: "And this", mode: "steer" })).status).toBe(202);
    const waitingFor = async (who: { cookie: string }) =>
      ((await (await api("GET", `/threads/${thread.id}`, who.cookie)).json()) as ThreadDetail)
        .waiting;

    const forAda = await waitingFor(ada);
    expect(forAda.map((row) => [row.kind, row.waiting])).toEqual([
      ["human", { mode: "queue", can: ["edit", "mode", "remove"] }],
      ["notice", { can: [] }],
      ["human", { mode: "steer", can: [] }],
    ]);
    expect(forAda.map((row) => row.seq)).toEqual(
      forAda.map((row) => row.seq).toSorted((a, b) => a - b),
    );
    expect(forAda[1]).toMatchObject({ kind: "notice", text: "Idle: Researcher" });
    expect((await waitingFor(grace)).map((row) => row.waiting?.can)).toEqual([
      [],
      [],
      ["edit", "mode", "remove"],
    ]);

    await call.boundary();
    call.reply("Noted.");
    (await model.next()).reply("Done.");
    await worker.idle();
    expect(await waitingFor(ada)).toEqual([]);
  });

  it("wake an agent they reach just as its turn ends", async () => {
    const { ada, model, worker, start, post, send, runStore, runs } = await notifiedThread();
    // The notification is written as the run ends, after its last pause.
    const end = runStore.end.bind(runStore);
    let arrive = true;
    runStore.end = async (lease, outcome) => {
      if (arrive) await send("Idle: Researcher");
      arrive = false;
      return end(lease, outcome);
    };
    await start();
    await post(ada, "Go");
    (await model.next()).reply("Done.");
    const woken = await model.next();
    expect(woken.texts.at(-1)).toBe(`user: ${notified("Idle: Researcher")}`);
    woken.reply("Noted.");
    await worker.idle();
    expect((await runs()).map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("count the people whose words they carry as steering", async () => {
    const workspace = await notifiedThread();
    const { ada, grace, model, start, post, send, runStore, thread, transcript } = workspace;
    // Only Ada renames threads directly.
    const policy = await workspace.toolPolicyStore.create({
      orgId: ada.orgId,
      spaceId: null,
      name: "Ada only",
      color: "orange",
      use: "some",
      users: [`user:${ada.userId}`],
      approvers: [`user:${ada.userId}`],
      independent: false,
    });
    await workspace.toolSettings.setInOrg(ada.orgId, ["thread.rename"], policy.id);
    await start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    await send("Rename it", [{ userId: grace.userId, name: "Grace Hopper", via: ["Writer"] }]);
    await call.boundary();
    call.startStep();
    call.toolCall("rename", "thread.rename", { title: "Renamed" });
    call.endStep();
    call.end();
    // Grace's words came with it, so the call waits for Ada.
    for (let tries = 0; (await runStore.active(thread.id))?.status !== "waiting"; tries++) {
      if (tries > 2000) throw new Error("never waited");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((await transcript()).at(-1)).toBe("thread.rename (waiting)");
  });

  describe("that are silent", () => {
    it("start no run, show at once, and are read at the next run", async () => {
      const { ada, model, worker, start, post, sendQuietly, transcript, runs } =
        await notifiedThread();
      await start();
      await sendQuietly("Divya", "Divya paused schedule Weekly check");
      await worker.idle();
      expect(model.calls).toHaveLength(0);
      expect(await runs()).toEqual([]);
      expect(await transcript()).toEqual(["notice"]);

      await post(ada, "Go");
      const call = await model.next();
      expect(call.texts).toEqual([
        "user: [Ada Lovelace] Go",
        `user: ${notified("Divya paused schedule Weekly check")}`,
      ]);
      call.reply("Noted.");
      await worker.idle();
      // Shown once, where it was made, and read once.
      expect(await transcript()).toEqual([
        "notice",
        "Ada Lovelace: Go",
        "Agent (completed): Noted.",
      ]);

      await post(ada, "Again");
      const next = await model.next();
      expect(next.texts.filter((text) => text.includes("Divya paused"))).toHaveLength(1);
      next.reply("Ok.");
      await worker.idle();
    });

    it("are read at a busy agent's next model call, and never start a run when it ends", async () => {
      const { ada, model, worker, start, post, send, sendQuietly, runs } = await notifiedThread();
      await start();
      await post(ada, "Go");
      const call = await model.next();
      call.step("Working.");
      await call.drained();
      await sendQuietly("Divya", "Divya renamed the thread to Plan");
      await send("Idle: Researcher");
      await sendQuietly("Divya", "Divya switched the model to codex/gpt-6-luna");
      expect(await call.boundary()).toEqual([
        {
          role: "user",
          text: notified(
            "Divya renamed the thread to Plan",
            "Idle: Researcher",
            "Divya switched the model to codex/gpt-6-luna",
          ),
        },
      ]);
      call.reply("Done.");
      await worker.idle();
      expect(model.calls).toHaveLength(1);
      expect((await runs()).map((run) => run.status)).toEqual(["completed"]);
    });

    it("left during the last step do not keep the run going, and are read at the next run", async () => {
      const { ada, model, worker, start, post, sendQuietly, runs } = await notifiedThread();
      await start();
      await post(ada, "Go");
      const call = await model.next();
      call.startStep();
      call.delta("Working.");
      await call.drained();
      await sendQuietly("Divya", "Divya switched the model to codex/gpt-6-luna");
      call.endStep();
      call.end();
      await worker.idle();
      expect(model.calls).toHaveLength(1);
      expect((await runs()).map((run) => run.status)).toEqual(["completed"]);

      await post(ada, "Again");
      const next = await model.next();
      expect(next.texts.at(-1)).toBe(
        `user: ${notified("Divya switched the model to codex/gpt-6-luna")}`,
      );
      next.reply("Ok.");
      await worker.idle();
    });

    it("left while a run ends do not start another", async () => {
      const { ada, model, worker, start, post, sendQuietly, runs } = await notifiedThread();
      await start();
      await post(ada, "Go");
      const call = await model.next();
      call.reply("Done.");
      await worker.idle();
      await sendQuietly("Divya", "Divya renamed the thread to Plan");
      await worker.idle();
      expect(model.calls).toHaveLength(1);
      expect(await runs()).toHaveLength(1);
    });

    it("tell the agent who renamed the thread or switched its model, and start no run", async () => {
      const { ada, grace, models, api, thread, model, worker, start, post, transcript } =
        await notifiedThread();
      await models.offer(["codex/gpt-6-luna"]);
      await start();
      const patch = (who: { cookie: string }, body: object) =>
        api("PATCH", `/threads/${thread.id}`, who.cookie, body);
      expect((await patch(grace, { title: "Vendor plan" })).status).toBe(200);
      expect((await patch(ada, { model: "codex/gpt-6-luna", effort: "high" })).status).toBe(200);
      // Nothing changed, nothing said.
      expect((await patch(ada, { model: "codex/gpt-6-luna" })).status).toBe(200);
      await worker.idle();
      expect(model.calls).toHaveLength(0);
      expect(await transcript()).toEqual(["notice", "notice", "notice"]);
      // The card names the model as people know it, never its ref.
      const read = await api("GET", `/threads/${thread.id}`, ada.cookie);
      const { rows } = (await read.json()) as {
        rows: { change?: { action: string; to?: string } }[];
      };
      expect(
        rows.flatMap((row) => (row.change?.action === "model" ? [row.change.to] : [])),
      ).toEqual(["gpt-6-luna · ChatGPT"]);

      await post(ada, "Go");
      const call = await model.next();
      expect(call.texts.at(-1)).toBe(
        `user: ${notified(
          "Grace Hopper renamed the thread to Vendor plan",
          "Ada Lovelace switched the model to chatgpt/gpt-6-luna",
          "Ada Lovelace set the effort to high",
        )}`,
      );
      call.reply("Ok.");
      await worker.idle();
    });

    it("do not hold back a waking one that comes with them", async () => {
      const { model, worker, start, send, sendQuietly } = await notifiedThread();
      await start();
      await sendQuietly("Divya", "Divya paused schedule Weekly check");
      await send("Idle: Researcher");
      const call = await model.next();
      expect(call.texts).toEqual([
        `user: ${notified("Divya paused schedule Weekly check", "Idle: Researcher")}`,
      ]);
      call.reply("Noted.");
      await worker.idle();
    });
  });
});

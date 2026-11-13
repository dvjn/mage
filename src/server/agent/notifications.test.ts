import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { createTranscripts } from "@/server/threads/transcripts.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { Steering } from "@/shared/threads/events.ts";

import { NOTIFICATIONS_HEADING } from "./context.ts";
import { createNotifier, type Notification, silentChange } from "./notifications.ts";

// A thread whose agent is sent notifications, as any feature sends them.
async function notifiedThread() {
  const workspace = await agentThread();
  const { threadStore, runStore, log, bus, thread } = workspace;
  const notifier = createNotifier({
    transcripts: createTranscripts(threadStore),
    runs: runStore,
    log,
    bus,
  });
  const note = (text: string, people: Steering[] = []): Notification => ({
    kind: "agent.idle",
    source: { threadId: thread.id, name: "Watcher", main: true },
    text,
    people,
  });
  const send = (text: string, people?: Steering[]) => notifier.send(thread.id, note(text, people));
  const sendQuietly = (by: string, text: string) =>
    notifier.send(thread.id, silentChange(thread.id, by, text));
  return { ...workspace, send, sendQuietly };
}

// What the model reads of notifications taken in together.
function notified(...lines: string[]) {
  return [NOTIFICATIONS_HEADING, ...lines].join("\n\n");
}

describe("notifications", () => {
  it("start an idle agent", async () => {
    const { model, worker, start, send, transcript, runs } = await notifiedThread();
    start();
    send("All idle: Researcher");
    const call = await model.next();
    expect(call.texts).toEqual([`user: ${notified("All idle: Researcher")}`]);
    call.reply("Noted.");
    await worker.idle();
    expect(transcript()).toEqual(["relay", "Agent (completed): Noted."]);
    expect(runs()).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("wait for a busy agent's next pause, and are taken in together", async () => {
    const { ada, model, worker, start, post, send, transcript } = await notifiedThread();
    start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    send("Idle: Researcher");
    send("Idle: Writer");
    expect(call.boundary()).toEqual([
      { role: "user", text: notified("Idle: Researcher", "Idle: Writer") },
    ]);
    call.reply("Both noted.");
    await worker.idle();
    expect(model.calls).toHaveLength(1);
    expect(transcript()).toEqual([
      "Ada Lovelace: Go",
      "Agent (completed): Working.",
      "relay",
      "relay",
      "Agent (completed): Both noted.",
    ]);
  });

  it("wait with people's messages in one list, oldest first, which only authors may change", async () => {
    const { ada, grace, api, thread, model, worker, start, post, send } = await notifiedThread();
    start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    const postAs = (who: { cookie: string }, body: object) =>
      api("POST", `/threads/${thread.id}/messages`, who.cookie, body);
    expect((await postAs(ada, { text: "Then this", mode: "queue" })).status).toBe(202);
    send("Idle: Researcher");
    expect((await postAs(grace, { text: "And this", mode: "steer" })).status).toBe(202);
    const waitingFor = async (who: { cookie: string }) =>
      ((await (await api("GET", `/threads/${thread.id}`, who.cookie)).json()) as ThreadDetail)
        .waiting;

    const forAda = await waitingFor(ada);
    expect(forAda.map((row) => [row.kind, row.waiting])).toEqual([
      ["human", { mode: "queue", can: ["edit", "mode", "remove"] }],
      ["relay", { can: [] }],
      ["human", { mode: "steer", can: [] }],
    ]);
    expect(forAda.map((row) => row.seq)).toEqual(
      forAda.map((row) => row.seq).toSorted((a, b) => a - b),
    );
    expect(forAda[1]).toMatchObject({ kind: "relay", text: "Idle: Researcher" });
    expect((await waitingFor(grace)).map((row) => row.waiting?.can)).toEqual([
      [],
      [],
      ["edit", "mode", "remove"],
    ]);

    call.boundary();
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
    runStore.end = (lease, outcome) => {
      if (arrive) send("Idle: Researcher");
      arrive = false;
      return end(lease, outcome);
    };
    start();
    await post(ada, "Go");
    (await model.next()).reply("Done.");
    const woken = await model.next();
    expect(woken.texts.at(-1)).toBe(`user: ${notified("Idle: Researcher")}`);
    woken.reply("Noted.");
    await worker.idle();
    expect(runs().map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("count the people whose words they carry as steering", async () => {
    const workspace = await notifiedThread();
    const { ada, grace, model, start, post, send, runStore, thread, transcript } = workspace;
    // Only Ada renames threads directly.
    const policy = workspace.toolPolicyStore.create({
      orgId: ada.orgId,
      spaceId: null,
      name: "Ada only",
      color: "orange",
      use: "some",
      users: [`user:${ada.userId}`],
      approvers: [`user:${ada.userId}`],
      independent: false,
    });
    workspace.toolSettings.setInOrg(ada.orgId, ["thread.rename"], policy.id);
    start();
    await post(ada, "Go");
    const call = await model.next();
    call.step("Working.");
    await call.drained();
    send("Rename it", [{ userId: grace.userId, name: "Grace Hopper", via: ["Writer"] }]);
    call.boundary();
    call.startStep();
    call.toolCall("rename", "thread.rename", { title: "Renamed" });
    call.endStep();
    call.end();
    // Grace's words came with it, so the call waits for Ada.
    for (let tries = 0; runStore.active(thread.id)?.status !== "waiting"; tries++) {
      if (tries > 2000) throw new Error("never waited");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(transcript().at(-1)).toBe("thread.rename (pending)");
  });

  describe("that are silent", () => {
    it("start no run, show at once, and are read at the next run", async () => {
      const { ada, model, worker, start, post, sendQuietly, transcript, runs } =
        await notifiedThread();
      start();
      sendQuietly("Divya", "Divya paused schedule Weekly check");
      await worker.idle();
      expect(model.calls).toHaveLength(0);
      expect(runs()).toEqual([]);
      expect(transcript()).toEqual(["relay"]);

      await post(ada, "Go");
      const call = await model.next();
      expect(call.texts).toEqual([
        "user: [Ada Lovelace] Go",
        `user: ${notified("Divya paused schedule Weekly check")}`,
      ]);
      call.reply("Noted.");
      await worker.idle();
      // Shown once, where it was made, and read once.
      expect(transcript()).toEqual(["relay", "Ada Lovelace: Go", "Agent (completed): Noted."]);

      await post(ada, "Again");
      const next = await model.next();
      expect(next.texts.filter((text) => text.includes("Divya paused"))).toHaveLength(1);
      next.reply("Ok.");
      await worker.idle();
    });

    it("are read at a busy agent's next model call, and never start a run when it ends", async () => {
      const { ada, model, worker, start, post, send, sendQuietly, runs } = await notifiedThread();
      start();
      await post(ada, "Go");
      const call = await model.next();
      call.step("Working.");
      await call.drained();
      sendQuietly("Divya", "Divya renamed the thread to Plan");
      send("Idle: Researcher");
      sendQuietly("Divya", "Divya switched the model to codex/gpt-6-luna");
      expect(call.boundary()).toEqual([
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
      expect(runs().map((run) => run.status)).toEqual(["completed"]);
    });

    it("left while a run ends do not start another", async () => {
      const { ada, model, worker, start, post, sendQuietly, runs } = await notifiedThread();
      start();
      await post(ada, "Go");
      const call = await model.next();
      call.reply("Done.");
      await worker.idle();
      sendQuietly("Divya", "Divya renamed the thread to Plan");
      await worker.idle();
      expect(model.calls).toHaveLength(1);
      expect(runs()).toHaveLength(1);
    });

    it("tell the agent who renamed the thread or switched its model, and start no run", async () => {
      const { ada, grace, org, api, thread, model, worker, start, post, transcript } =
        await notifiedThread();
      org.models.push("codex/gpt-6-luna");
      org.slugs = { codex: "chatgpt" };
      start();
      const patch = (who: { cookie: string }, body: object) =>
        api("PATCH", `/threads/${thread.id}`, who.cookie, body);
      expect((await patch(grace, { title: "Vendor plan" })).status).toBe(200);
      expect((await patch(ada, { model: "codex/gpt-6-luna", effort: "high" })).status).toBe(200);
      // Nothing changed, nothing said.
      expect((await patch(ada, { model: "codex/gpt-6-luna" })).status).toBe(200);
      await worker.idle();
      expect(model.calls).toHaveLength(0);
      expect(transcript()).toEqual(["relay", "relay", "relay"]);
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
      start();
      sendQuietly("Divya", "Divya paused schedule Weekly check");
      send("Idle: Researcher");
      const call = await model.next();
      expect(call.texts).toEqual([
        `user: ${notified("Divya paused schedule Weekly check", "Idle: Researcher")}`,
      ]);
      call.reply("Noted.");
      await worker.idle();
    });
  });
});

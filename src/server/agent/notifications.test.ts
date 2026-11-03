import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Steering } from "@/shared/threads/events.ts";

import { NOTIFICATIONS_HEADING } from "./context.ts";
import { createNotifier, type Notification } from "./notifications.ts";

// A thread whose agent is sent notifications, as any feature sends them.
async function notifiedThread() {
  const workspace = await agentThread();
  const { threadStore, runStore, log, bus, thread } = workspace;
  const notifier = createNotifier({ threads: threadStore, runs: runStore, log, bus });
  const note = (text: string, people: Steering[] = []): Notification => ({
    kind: "agent.idle",
    source: { threadId: thread.id, name: "Watcher", main: true },
    text,
    people,
  });
  const send = (text: string, people?: Steering[]) => notifier.send(thread.id, note(text, people));
  return { ...workspace, send };
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
});

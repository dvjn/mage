// A thread busy with every kind of background work, arranged through the API and the model: tasks,
// timers and schedules (one paused), jobs running, waiting and ended, subagents working on a call
// that waits, idle and archived, a skill loaded, a webhook, a message sent to a subagent, and a
// call of its own that waits for a decision; and a thread whose subagents each wait on a call.

import { eventually, expect, type World, world } from "./contract.ts";

// The model's last result in the call, parsed.
function lastValue(texts: readonly string[]) {
  const text = texts.findLast((one) => one.startsWith("result "))!;
  return (JSON.parse(text.replace(/^result [^:]+: /, "")) as { value: any }).value;
}

// Answers the thread's agent until nothing runs or waits there.
export async function answered(w: World) {
  for (;;) {
    const shown = await eventually(
      async () => ({ asked: w.waitsForModel(), shown: await w.shown() }),
      ({ asked, shown }) => asked || (shown.run === null && shown.waiting.length === 0),
    );
    if (!shown.asked) return;
    await w.answers(w.threadId, "Noted.");
  }
}

export async function busyThread() {
  const w = await world();
  await w.post(w.ada, "Plan");
  await w.asks(w.threadId, [
    "tasks.add",
    { tasks: [{ title: "Rest well" }, { title: "Rest more" }] },
  ]);
  const planned = await w.answers(w.threadId, "Planned.");
  const taskIds = (lastValue(planned.texts).tasks as { id: string }[]).map((task) => task.id);
  await w.settled();

  await w.post(w.ada, "Set up");
  await w.asks(
    w.threadId,
    ["schedules.wake_at", { in_seconds: 3600, note: "Check in" }],
    ["schedules.add", { name: "Digest", cron: "0 9 * * *", prompt: "Digest" }],
    ["schedules.add", { name: "Weekly", cron: "0 9 * * 1", prompt: "Weekly" }],
    ["jobs.start", { tool: "probe.wait", input: { label: "running" } }],
    ["jobs.start", { tool: "probe.guarded", input: { label: "job-waits" } }],
    ["jobs.start", { tool: "probe.wait", input: { label: "ended" } }],
    ["subagents.start", { name: "Worker", task: "Work" }],
    ["subagents.start", { name: "Idle", task: "Rest", tasks: [taskIds[0]] }],
    ["subagents.start", { name: "Gone", task: "Leave" }],
    ["skills.load", { name: "page-design" }],
  );
  await w.answers(w.threadId, "Set up.");
  const worker = await w.subagentNamed("Worker");
  const idle = await w.subagentNamed("Idle");
  const gone = await w.subagentNamed("Gone");
  await w.asks(worker, ["probe.guarded", { label: "sub" }]);
  await eventually(
    () => w.shown(w.ada, worker),
    (shown) => shown.run === "decision",
  );
  // The task given to it is a notice its first run takes in with its task.
  await w.answers(idle, "Resting.");
  await w.answers(gone, "Gone.");
  await answered(w);
  await eventually(
    () => w.tool.running("ended"),
    (running) => running,
  );
  w.tool.finish("ended", { done: true });
  await answered(w);

  await w.webhook("Deploys", "Check the deploy");
  const weekly = (await w.activity()).find((item) => item.title === "Weekly")!;
  expect(await w.act(w.ada, "POST", `/schedules/${weekly.work.schedule!.id}/pause`)).toBe(200);
  await w.settled();

  await w.post(w.ada, "Tidy");
  await w.asks(
    w.threadId,
    ["subagents.archive", { subagent: "Gone" }],
    ["subagents.send", { to: "Idle", text: "Hello" }],
  );
  await w.answers(w.threadId, "Tidied.");
  await w.answers(idle, "Hi back.");
  await answered(w);

  await w.post(w.ada, "Guard");
  await w.asks(w.threadId, ["probe.guarded", { label: "main" }]);
  await eventually(
    () => w.shown(),
    (shown) => shown.run === "decision",
  );
  await w.settled();
  const guest = await w.guest("Joan Clarke", "joan@example.com");
  return { w, guest };
}

// The tray as the reader sees it.

// A thread whose agent started `count` subagents, each waiting on a call of its own for a decision.
export async function subagentsWaiting(count: number) {
  const w = await world();
  await w.post(w.ada, "Get help");
  const names = Array.from({ length: count }, (_, i) => `Helper${i + 1}`);
  await w.asks(
    w.threadId,
    ...names.map((name): [string, unknown] => ["subagents.start", { name, task: "Help" }]),
  );
  await w.answers(w.threadId, "Started.");
  for (const name of names) {
    const helper = await w.subagentNamed(name);
    await w.asks(helper, ["probe.guarded", { label: name }]);
    await eventually(
      () => w.shown(w.ada, helper),
      (shown) => shown.run === "decision",
    );
  }
  await w.settled();
  return w;
}

// A thread whose agent started `count` subagents, each idle once it answered its task; started
// four at a time, as many as run at once.
export async function subagentsIdle(count: number) {
  const w = await world();
  const names = Array.from({ length: count }, (_, i) => `Helper${i + 1}`);
  for (let at = 0; at < names.length; at += 4) {
    const batch = names.slice(at, at + 4);
    await w.post(w.ada, "Get help");
    await w.asks(
      w.threadId,
      ...batch.map((name): [string, unknown] => ["subagents.start", { name, task: "Help" }]),
    );
    await w.answers(w.threadId, "Started.");
    for (const name of batch) await w.answers(await w.subagentNamed(name), "Helped.");
    await answered(w);
  }
  await w.settled();
  return w;
}

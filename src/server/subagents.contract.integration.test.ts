// Subagents as their clients meet them: the limits on how many a thread keeps and what they are
// labelled, kept when they are started and brought back, and the task list a subagent shares with
// its starter. Everything is arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, type World, world } from "@/server/testing/contract.ts";

// Has the thread's agent start subagents in one step, answering their threads by label.
async function started(w: World, ...names: string[]) {
  await w.post(w.ada, `Start ${names.join(", ")}`);
  await w.asks(
    w.threadId,
    ...names.map((name): [string, unknown] => ["subagents.start", { name, task: `Task ${name}` }]),
  );
  const told = await w.answers(w.threadId, "Started.");
  const threads: Record<string, string> = {};
  for (const name of names) threads[name] = await w.subagentNamed(name);
  return { threads, told };
}

// Has the thread's agent call the subagents tool, answering what the call gave back.
async function calls(w: World, toolId: string, input: object) {
  await w.post(w.ada, "Go");
  await w.asks(w.threadId, [toolId, input]);
  const told = await w.answers(w.threadId, "Done.");
  return told.texts.at(-1);
}

async function unarchive(w: World, threadId: string) {
  const res = await w.api("POST", `/threads/${threadId}/unarchive`, w.ada.cookie);
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

const names = (count: number, prefix = "S") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("a thread's subagents", () => {
  it("are brought back by a person only while the limit and the label allow it", async () => {
    const w = await world();
    const { threads } = await started(w, ...names(12));
    expect(await calls(w, "subagents.archive", { subagent: "S0" })).toContain('"state":"archived"');
    await started(w, "S12");
    expect(await unarchive(w, threads.S0!)).toEqual({
      status: 409,
      body: { error: "The thread already has 12 subagents" },
    });
    expect(await unarchive(w, threads.S1!)).toEqual({
      status: 409,
      body: { error: "This subagent is not archived" },
    });
  });

  it("are not brought back while another live one has the label", async () => {
    const w = await world();
    const { threads } = await started(w, "Researcher");
    expect(await calls(w, "subagents.archive", { subagent: "Researcher" })).toContain(
      '"state":"archived"',
    );
    await started(w, "Researcher");
    expect(await unarchive(w, threads.Researcher!)).toEqual({
      status: 409,
      body: { error: "Another subagent is named Researcher" },
    });
  });

  it("are refused a thirteenth, and a label a live one has", async () => {
    const w = await world();
    await started(w, ...names(12));
    expect(await calls(w, "subagents.start", { name: "S12", task: "More" })).toBe(
      'result subagents.start: {"ok":false,"error":"This thread already has 12 subagents. Archive some you no longer need."}',
    );
    const few = await world();
    await started(few, "Researcher");
    expect(await calls(few, "subagents.start", { name: "researcher", task: "More" })).toBe(
      'result subagents.start: {"ok":false,"error":"A subagent is already labelled researcher."}',
    );
  });
});

describe("a subagent and its starter's task list", () => {
  it("is shared when it is started with tasks or given one later, and not otherwise", async () => {
    const w = await world();
    await w.post(w.ada, "Plan");
    await w.asks(w.threadId, [
      "tasks.add",
      { tasks: [{ title: "First" }, { title: "Second" }, { title: "Third" }] },
    ]);
    const planned = await w.answers(w.threadId, "Planned.");
    const added = JSON.parse(planned.texts.at(-1)!.replace(/^result [^:]+: /, "")) as {
      value: { tasks: { id: string; title: string }[] };
    };
    const [first, second] = added.value.tasks;

    await w.post(w.ada, "Start them");
    await w.asks(
      w.threadId,
      ["subagents.start", { name: "Given", task: "Do the first", tasks: [first!.id] }],
      ["subagents.start", { name: "Later", task: "Wait" }],
      ["subagents.start", { name: "Apart", task: "Work alone" }],
    );
    await w.answers(w.threadId, "Started.");
    const given = await w.subagentNamed("Given");
    const later = await w.subagentNamed("Later");
    const apart = await w.subagentNamed("Apart");

    await w.post(w.ada, "Hand over the second");
    await w.asks(w.threadId, ["tasks.update", { id: second!.id, assignee: "Later" }]);
    await w.answers(w.threadId, "Handed over.");

    // Each reads the list it works on, every task of it.
    const listed = async (threadId: string) => {
      await w.asks(threadId, ["tasks.list", { all: true }]);
      const call = await w.next(threadId);
      const text = call.texts.findLast((one) => /^result [^:]+list[^:]*: /.test(one))!;
      call.reply("Read.");
      return (
        JSON.parse(text.replace(/^result [^:]+: /, "")) as {
          value: { tasks: { title: string; status: string }[] };
        }
      ).value.tasks.map((task) => `${task.title} ${task.status}`);
    };
    // Each subagent's first run, which takes in its task, lists the tasks.
    expect(await listed(given)).toEqual(["First todo", "Second todo", "Third todo"]);
    expect(await listed(apart)).toEqual([]);

    // One given a task later reads and changes the same list.
    await eventually(
      () => w.shown(w.ada, later),
      (shown) => shown.run === "running" || shown.waiting.length > 0,
    );
    await w.asks(later, ["tasks.update", { id: second!.id, status: "done" }]);
    await w.answers(later, "Done it.");
    const list = await w.json<{ tasks: { title: string; status: string }[] }>(
      await w.api("GET", `/threads/${w.threadId}/tasks`, w.ada.cookie),
    );
    expect(list.tasks.map((task) => `${task.title} ${task.status}`)).toEqual([
      "First todo",
      "Second done",
      "Third todo",
    ]);
  });
});

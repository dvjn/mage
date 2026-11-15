import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import type { ThreadFollowItem } from "@/server/views/thread.ts";
import { eventSummary } from "@/server/threads/log.ts";
import type { TaskList } from "@/shared/tasks.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { NOTICES_HEADING } from "@/server/execution/context.ts";

async function taskThread() {
  const workspace = await agentThread();
  const { model, threadStore, thread, api, ada, worker } = workspace;
  const taken = new Set<Call>();
  let count = 0;

  async function callIn(threadId: string): Promise<Call> {
    for (;;) {
      const call = model.calls.find(
        (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
      );
      if (call) {
        taken.add(call);
        return call;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function calls(threadId: string, ...asked: [string, unknown][]) {
    const call = await callIn(threadId);
    call.startStep();
    call.delta("On it.");
    for (const [toolId, input] of asked) {
      count += 1;
      call.toolCall(`call-${count}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }

  async function answer(threadId: string, text = "Done.") {
    const call = await callIn(threadId);
    call.reply(text);
    return call;
  }

  async function tasksOf(threadId: string, who: { cookie: string } = ada) {
    const res = await api("GET", `/threads/${threadId}/tasks`, who.cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as TaskList;
  }

  async function rowsOf(threadId: string) {
    return transcriptOf((await threadStore.eventsAfter(threadId, 0)).map(eventSummary)).rows;
  }

  async function until(condition: () => boolean | Promise<boolean>) {
    for (let tries = 0; !(await condition()); tries++) {
      if (tries > 2000) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function subagentNamed(name: string) {
    const found = (await workspace.subagentStore.ofParents([thread.id])).find(
      (subagent) => subagent.name === name,
    );
    if (!found) throw new Error(`no subagent ${name}`);
    return found.threadId;
  }

  return { ...workspace, calls, answer, tasksOf, rowsOf, until, subagentNamed, worker };
}

// Whether the subagent works on its starter's list.
async function sharing(
  t: { db: { execute: (query: SQL) => Promise<{ rows: unknown[] }> } },
  threadId: string,
) {
  return (
    (await t.db.execute(sql`select 1 from task_share where thread_id = ${threadId}`)).rows.length >
    0
  );
}

describe("tasks", () => {
  it("are added, listed, updated and removed by the agent, who is shown as having done so", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Read" }, { title: "Write", assignee: "agent" }] },
    ]);
    const added = await t.answer(t.thread.id);
    expect(added.texts.at(-1)).toContain('"title":"Write"');
    const list = await t.tasksOf(t.thread.id);
    expect(
      list.tasks.map((task) => [task.title, task.status, task.assignee?.kind, task.order]),
    ).toEqual([
      ["Read", "todo", "agent", 0],
      ["Write", "todo", "agent", 1],
    ]);
    expect(list.tasks[0]!.createdBy).toEqual({ kind: "agent", name: "Agent" });
    expect(list.canEdit).toBe(true);

    await t.post(t.ada, "Go on");
    await t.calls(
      t.thread.id,
      ["thread.update_task", { id: list.tasks[0]!.id, status: "done" }],
      ["thread.remove_task", { ids: [list.tasks[1]!.id] }],
      ["thread.update_task", { id: list.tasks[0]!.id, assignee: "nobody" }],
    );
    const after = await t.answer(t.thread.id);
    expect(after.texts.at(-1)).toContain("nobody is not an assignee");
    const now = await t.tasksOf(t.thread.id);
    expect(now.tasks.map((task) => [task.title, task.status])).toEqual([["Read", "done"]]);
  });

  it("are changed by people who may post, and a change to one given to the agent tells it", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Write", assignee: "agent" }] },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [task] = (await t.tasksOf(t.thread.id)).tasks;

    // A reader may not change it.
    const denied = await t.api(
      "PATCH",
      `/threads/${t.thread.id}/tasks/${task!.id}`,
      t.alan.cookie,
      {
        status: "done",
      },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect((await t.tasksOf(t.thread.id, t.alan)).canEdit).toBe(false);

    const res = await t.api("PATCH", `/threads/${t.thread.id}/tasks/${task!.id}`, t.grace.cookie, {
      status: "done",
    });
    expect(res.status).toBe(200);
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toBe(
      `user: ${NOTICES_HEADING}\n\nGrace Hopper marked task "Write" as done.`,
    );
    const [done] = (await t.tasksOf(t.thread.id)).tasks;
    expect(done).toMatchObject({
      status: "done",
      updatedBy: { kind: "user", name: "Grace Hopper" },
    });

    // A person may add and remove tasks too; one given to nobody tells the agent quietly.
    expect(
      (await t.api("POST", `/threads/${t.thread.id}/tasks`, t.ada.cookie, { title: "Ship" }))
        .status,
    ).toBe(200);
    const list = await t.tasksOf(t.thread.id);
    expect(list.tasks.map((one) => one.title)).toEqual(["Write", "Ship"]);
    const mine = await t.api(
      "PATCH",
      `/threads/${t.thread.id}/tasks/${list.tasks[1]!.id}`,
      t.ada.cookie,
      {
        assignee: { kind: "me" },
      },
    );
    expect(mine.status).toBe(200);
    expect((await t.tasksOf(t.thread.id)).tasks[1]!.assignee).toMatchObject({
      kind: "person",
      name: "Ada Lovelace",
    });
    expect(
      (await t.api("DELETE", `/threads/${t.thread.id}/tasks/${list.tasks[1]!.id}`, t.ada.cookie))
        .status,
    ).toBe(200);
    expect((await t.tasksOf(t.thread.id)).tasks).toHaveLength(1);
  });

  it("tell the agent without waking it when a person or a subagent changes the list", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      {
        tasks: [
          { title: "Read", assignee: t.ada.userId },
          { title: "Part", assignee: t.ada.userId },
        ],
      },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const parentCalls = () =>
      t.model.calls.filter((call) => call.request.sessionId === t.thread.id).length;
    const [read, part] = (await t.tasksOf(t.thread.id)).tasks;
    const base = `/threads/${t.thread.id}/tasks`;
    const before = parentCalls();
    await t.api("PATCH", `${base}/${read!.id}`, t.grace.cookie, { title: "Read it" });
    await t.api("POST", base, t.grace.cookie, { title: "Ship" });
    await t.api("DELETE", `${base}/${read!.id}`, t.grace.cookie);
    await t.worker.idle();
    expect(parentCalls()).toBe(before);
    const told = async () =>
      (await t.rowsOf(t.thread.id)).flatMap((row) =>
        row.kind === "notice" && row.type === "change" ? [row.text] : [],
      );
    expect(await told()).toEqual([
      'Grace Hopper renamed task "Read" to "Read it".',
      'Grace Hopper added task "Ship".',
      'Grace Hopper removed task "Read it".',
    ]);
    // Each also carries what was done, in parts, for its card.
    expect(
      (await t.rowsOf(t.thread.id)).flatMap((row) =>
        row.kind === "notice" && row.type === "change" ? [row.change] : [],
      ),
    ).toEqual([
      { subject: { kind: "task", name: "Read it" }, action: "rename", from: "Read", to: "Read it" },
      { subject: { kind: "task", name: "Ship" }, action: "add" },
      { subject: { kind: "task", name: "Read it" }, action: "remove" },
    ]);

    await t.post(t.ada, "Hand over");
    await t.calls(t.thread.id, [
      "subagents.start",
      { name: "Scout", task: "Do the part", tasks: [part!.id] },
    ]);
    await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 1);
    const scout = await t.subagentNamed("Scout");
    await t.answer(t.thread.id);
    const quiet = parentCalls();
    await t.calls(scout, ["thread.update_task", { id: part!.id, status: "doing" }]);
    await t.answer(scout);
    expect(parentCalls()).toBe(quiet);
    expect((await told()).at(-1)).toBe('Scout marked task "Part" as doing.');
    expect(
      (await t.rowsOf(t.thread.id))
        .flatMap((row) => (row.kind === "notice" && row.type === "change" ? [row.change] : []))
        .at(-1),
    ).toEqual({
      subject: { kind: "task", name: "Part" },
      action: "status",
      from: "todo",
      to: "doing",
    });
  });

  it("tell a refused assignee that subagents become assignees once started", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Dig", assignee: "GitHub" }] },
    ]);
    const refused = await t.answer(t.thread.id);
    const text = refused.texts.at(-1)!;
    expect(text).toContain("GitHub is not an assignee");
    expect(text).toContain("once started");
    expect(text).toContain("subagents.start tasks");
  });

  it("are shared with a subagent that is given a task, which hears of it", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(
      t.thread.id,
      ["thread.add_tasks", { tasks: [{ title: "Part" }] }],
      ["subagents.start", { name: "Scout", task: "Wait for work" }],
    );
    await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 1);
    const scout = await t.subagentNamed("Scout");
    expect(await sharing(t, scout)).toBe(false);
    await t.answer(t.thread.id);
    await t.answer(scout, "Ready.");
    // Its report wakes the starter.
    await t.answer(t.thread.id, "Noted.");
    await t.worker.idle();
    const [part] = (await t.tasksOf(t.thread.id)).tasks;
    expect((await t.tasksOf(scout)).tasks).toEqual([]);

    await t.post(t.ada, "Hand it over");
    await t.calls(t.thread.id, ["thread.update_task", { id: part!.id, assignee: "Scout" }]);
    await t.answer(t.thread.id);
    expect(await sharing(t, scout)).toBe(true);
    // The idle subagent wakes on the task and sees the starter's list.
    const woken = await t.answer(scout, "On it.");
    expect(woken.texts.join("\n")).toContain(`gave you task "Part"`);
    expect((await t.tasksOf(scout)).tasks.map((task) => task.title)).toEqual(["Part"]);
  });

  it("show a subagent its own tasks unless it asks for all, and the starter everything", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Part" }, { title: "Rest" }] },
    ]);
    await t.answer(t.thread.id);
    const [part] = (await t.tasksOf(t.thread.id)).tasks;
    await t.post(t.ada, "Go");
    await t.calls(t.thread.id, [
      "subagents.start",
      { name: "Scout", task: "Do the part", tasks: [part!.id] },
    ]);
    await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 1);
    const scout = await t.subagentNamed("Scout");
    await t.answer(t.thread.id);

    await t.calls(scout, ["thread.list_tasks", {}], ["thread.list_tasks", { all: true }]);
    const read = (await t.answer(scout)).texts.join("\n");
    expect(read).toContain("1 more task on the list; all: true to see them");
    expect(read).toContain('"title":"Rest"');
    expect((await t.tasksOf(scout)).shared).toBe(true);
    expect((await t.tasksOf(t.thread.id)).shared).toBeUndefined();
  });

  // The start and the tasks it gives are one write, so the notice of the tasks given is there when
  // the subagent's first run begins.
  it("given at start are read by the subagent's first run, with its task", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, ["thread.add_tasks", { tasks: [{ title: "Part" }] }]);
    await t.answer(t.thread.id);
    const [part] = (await t.tasksOf(t.thread.id)).tasks;
    await t.post(t.ada, "Go");
    await t.calls(t.thread.id, [
      "subagents.start",
      { name: "Scout", task: "Do the part", tasks: [part!.id] },
    ]);
    await t.answer(t.thread.id);
    const scout = await t.subagentNamed("Scout");
    const first = await t.answer(scout, "On it.");
    expect(first.texts.join("\n")).toContain("Do the part");
    expect(first.texts.join("\n")).toContain(`gave you task "Part"`);
    await t.answer(t.thread.id, "Noted.");
    await t.worker.idle();
    const runs = await t.db.execute(sql`select id from run where thread_id = ${scout}`);
    expect(runs.rows).toHaveLength(1);
  });

  it("are given to a subagent at start by id, which shares the list", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, ["thread.add_tasks", { tasks: [{ title: "Part" }] }]);
    await t.answer(t.thread.id);
    const [part] = (await t.tasksOf(t.thread.id)).tasks;

    await t.post(t.ada, "Go");
    await t.calls(
      t.thread.id,
      ["subagents.start", { name: "Ghost", task: "Nothing", tasks: ["nope"] }],
      ["subagents.start", { name: "Scout", task: "Do the part", tasks: [part!.id] }],
    );
    const result = await t.answer(t.thread.id);
    expect(result.texts.join("\n")).toContain("No task nope");
    const scout = await t.subagentNamed("Scout");
    expect(await sharing(t, scout)).toBe(true);
    expect((await t.subagentStore.ofParents([t.thread.id])).map((one) => one.name)).toEqual([
      "Scout",
    ]);
    expect((await t.tasksOf(t.thread.id)).tasks[0]!.assignee).toMatchObject({
      kind: "subagent",
      threadId: scout,
      name: "Scout",
    });
    expect((await t.tasksOf(scout)).tasks.map((task) => task.title)).toEqual(["Part"]);
  });

  it("count on the starter's line for the subagent they were given to, and reach both feeds", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }] },
    ]);
    await t.answer(t.thread.id);
    const [one, two] = (await t.tasksOf(t.thread.id)).tasks;
    await t.post(t.ada, "Go");
    await t.calls(t.thread.id, [
      "subagents.start",
      { name: "Scout", task: "Do these", tasks: [one!.id, two!.id] },
    ]);
    await t.answer(t.thread.id);
    const scout = await t.subagentNamed("Scout");

    const asAda = { userId: t.ada.userId, orgId: t.ada.orgId, role: "member" as const };
    const parentSent: ThreadFollowItem[] = [];
    const scoutSent: ThreadFollowItem[] = [];
    const { stop: stopParent } = await t.views.thread.follow(
      asAda,
      t.thread.id,
      Number.MAX_SAFE_INTEGER,
      (item) => item !== "ended" && parentSent.push(item),
    );
    const { stop: stopScout } = await t.views.thread.follow(
      asAda,
      scout,
      Number.MAX_SAFE_INTEGER,
      (item) => item !== "ended" && scoutSent.push(item),
    );
    const line = async () =>
      (await t.views.activity.of(await t.access.require(asAda, t.thread.id))).items.find(
        (item) => item.work.subagent?.threadId === scout,
      )?.work.subagent;
    expect((await line())?.tasks).toEqual({ done: 0, total: 2 });

    // The subagent checks one off in the starter's list: the starter's line counts it, and the
    // starter's page is told.
    await t.calls(scout, ["thread.update_task", { id: one!.id, status: "done" }]);
    await t.until(async () => (await line())?.tasks?.done === 1);
    await t.until(() =>
      parentSent.some(
        (item) =>
          item.kind === "activity" &&
          item.list.items.some((entry) => entry.work.subagent?.tasks?.done === 1),
      ),
    );

    // A person changes the starter's list: the subagent's page is told.
    scoutSent.length = 0;
    const added = await t.api("POST", `/threads/${t.thread.id}/tasks`, t.ada.cookie, {
      title: "Four",
    });
    expect(added.status).toBeLessThan(300);
    await t.until(() => scoutSent.some((item) => item.kind === "tasks"));
    stopParent();
    stopScout();
    // Its own thread lists what is live there, apart from its starter's line.
    expect((await t.views.activity.of(await t.access.require(asAda, scout))).items).toEqual([]);
  });

  it("are shared with a subagent started to share them, and kept apart otherwise", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(
      t.thread.id,
      ["subagents.start", { name: "Scout", task: "Do the part", share_tasks: true }],
      ["subagents.start", { name: "Loner", task: "Do yours" }],
      ["thread.add_tasks", { tasks: [{ title: "Part" }] }],
    );
    await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 2);
    const scout = await t.subagentNamed("Scout");
    const loner = await t.subagentNamed("Loner");
    await t.until(async () => (await t.tasksOf(t.thread.id)).tasks.length === 1);
    const [part] = (await t.tasksOf(t.thread.id)).tasks;
    await t.calls(t.thread.id, ["thread.update_task", { id: part!.id, assignee: "Scout" }]);
    await t.answer(t.thread.id);

    // The subagent sees the list as its starter's and is given the task on it.
    await t.calls(scout, ["thread.list_tasks", {}]);
    // It checks the task off, and the starter's list shows who did.
    const read = await t.calls(scout, ["thread.update_task", { id: part!.id, status: "done" }]);
    expect(read.texts.join("\n")).toContain('"assignee":"Scout"');
    expect(read.texts.join("\n")).toContain("The task list is your starter's");
    expect((await t.tasksOf(scout)).tasks.map((task) => task.title)).toEqual(["Part"]);

    await t.answer(scout);
    const shared = await t.tasksOf(t.thread.id);
    expect(shared.tasks[0]).toMatchObject({
      status: "done",
      assignee: { kind: "subagent", threadId: scout, name: "Scout" },
      updatedBy: { kind: "agent", name: "Scout" },
    });

    // The other keeps a list of its own.
    await t.calls(loner, ["thread.add_tasks", { tasks: [{ title: "Mine" }] }]);
    await t.answer(loner);
    expect((await t.tasksOf(loner)).tasks.map((task) => task.title)).toEqual(["Mine"]);
    expect((await t.tasksOf(t.thread.id)).tasks.map((task) => task.title)).toEqual(["Part"]);
  });

  it("are given to a person who wrote in the thread, by name or id, and to no one else", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.answer(t.thread.id);
    await t.worker.idle();
    await t.post(t.grace, "I can help");
    await t.answer(t.thread.id);
    await t.worker.idle();

    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      {
        tasks: [
          { title: "Review", assignee: "grace hopper" },
          { title: "Ship", assignee: "Alan" },
        ],
      },
    ]);
    const refused = await t.answer(t.thread.id);
    // Alan never wrote here, so he is not offered, and nothing was added.
    expect(refused.texts.at(-1)).toContain(
      "Alan is not an assignee. Assignees: agent, Ada Lovelace",
    );
    expect(refused.texts.at(-1)).toContain(`Grace Hopper (${t.grace.userId})`);
    expect(refused.texts.at(-1)).not.toContain(t.alan.userId);
    expect((await t.tasksOf(t.thread.id)).tasks).toEqual([]);

    await t.post(t.ada, "Again");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Review", assignee: "grace hopper" }, { title: "Ship" }] },
    ]);
    const added = await t.answer(t.thread.id);
    expect(added.texts.at(-1)).toContain('"assignee":"Grace Hopper","assigneeKind":"person"');
    const [review, ship] = (await t.tasksOf(t.thread.id)).tasks;
    expect(review!.assignee).toEqual({
      kind: "person",
      userId: t.grace.userId,
      name: "Grace Hopper",
    });

    await t.post(t.ada, "Hand it over");
    await t.calls(t.thread.id, ["thread.update_task", { id: ship!.id, assignee: t.ada.userId }]);
    const handed = await t.answer(t.thread.id);
    expect(handed.texts.at(-1)).toContain('"assignee":"Ada Lovelace"');
    expect((await t.tasksOf(t.thread.id)).tasks[1]!.assignee).toMatchObject({
      kind: "person",
      userId: t.ada.userId,
    });
  });

  it("are archived by the agent when done, leaving the list and kept as history", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      {
        tasks: [
          { title: "Read", assignee: t.ada.userId },
          { title: "Write", assignee: t.ada.userId },
          { title: "Ship", assignee: t.ada.userId },
        ],
      },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [read, write] = (await t.tasksOf(t.thread.id)).tasks;
    for (const [task, status] of [
      [read, "done"],
      [write, "doing"],
    ] as const) {
      await t.api("PATCH", `/threads/${t.thread.id}/tasks/${task!.id}`, t.ada.cookie, { status });
    }

    // Named tasks must all be done, and the refusal says which are not.
    await t.post(t.ada, "Tidy");
    await t.calls(t.thread.id, ["thread.archive_tasks", { ids: [read!.id, write!.id] }]);
    const refused = (await t.answer(t.thread.id)).texts.at(-1)!;
    expect(refused).toContain(`Not done: ${write!.id} `);
    expect(refused).not.toContain(`${read!.id} `);
    expect((await t.tasksOf(t.thread.id)).tasks).toHaveLength(3);

    // With no ids, every done task goes, and the rest of the list comes back.
    await t.post(t.ada, "Tidy again");
    await t.calls(t.thread.id, ["thread.archive_tasks", {}]);
    const archived = (await t.answer(t.thread.id)).texts.join("\n");
    expect(archived).toContain(`"archived":["${read!.id}"]`);
    expect(archived).toContain('"title":"Write"');
    expect((await t.tasksOf(t.thread.id)).tasks.map((task) => task.title)).toEqual([
      "Write",
      "Ship",
    ]);

    await t.post(t.ada, "What was archived");
    await t.calls(
      t.thread.id,
      ["thread.list_tasks", { archived: true }],
      ["thread.update_task", { id: read!.id, status: "todo" }],
    );
    const history = (await t.answer(t.thread.id)).texts.join("\n");
    expect(history).toContain('"title":"Read"');
    expect(history).toContain(`No task ${read!.id}.`);
  });

  it("are archived by a person who may post, and the agent a task is for is told who", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      {
        tasks: [
          { title: "Write", assignee: "agent" },
          { title: "Test", assignee: t.ada.userId },
        ],
      },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [write] = (await t.tasksOf(t.thread.id)).tasks;
    const route = `/threads/${t.thread.id}/tasks/archive-done`;
    await t.api("PATCH", `/threads/${t.thread.id}/tasks/${write!.id}`, t.ada.cookie, {
      status: "done",
    });
    await t.answer(t.thread.id);
    await t.worker.idle();

    expect((await t.api("POST", route, t.alan.cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await t.tasksOf(t.thread.id)).tasks).toHaveLength(2);
    const res = await t.api("POST", route, t.grace.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 1 });
    // Archiving does not wake the agent; it reads who did it at its next run.
    const calls = t.model.calls.length;
    await t.worker.idle();
    expect(t.model.calls.length).toBe(calls);
    await t.post(t.ada, "Go on");
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toBe(
      `user: ${NOTICES_HEADING}\n\nGrace Hopper archived task "Write".`,
    );
    expect((await t.tasksOf(t.thread.id)).tasks.map((task) => task.title)).toEqual(["Test"]);
    // Nothing is left to archive.
    expect(await (await t.api("POST", route, t.grace.cookie)).json()).toEqual({ archived: 0 });
  });

  it("are archived by a subagent only when given to it", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Split it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      { tasks: [{ title: "Part" }, { title: "Rest" }] },
    ]);
    await t.answer(t.thread.id);
    const [part, rest] = (await t.tasksOf(t.thread.id)).tasks;
    await t.post(t.ada, "Go");
    await t.calls(t.thread.id, [
      "subagents.start",
      { name: "Scout", task: "Do the part", tasks: [part!.id] },
    ]);
    await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 1);
    const scout = await t.subagentNamed("Scout");
    await t.answer(t.thread.id);
    for (const task of [part, rest]) {
      await t.api("PATCH", `/threads/${t.thread.id}/tasks/${task!.id}`, t.ada.cookie, {
        status: "done",
      });
    }

    await t.calls(
      scout,
      ["thread.archive_tasks", { ids: [rest!.id] }],
      ["thread.archive_tasks", {}],
    );
    const read = (await t.answer(scout)).texts.join("\n");
    expect(read).toContain(`Not given to you: ${rest!.id} `);
    expect(read).toContain(`"archived":["${part!.id}"]`);
    expect((await t.tasksOf(t.thread.id)).tasks.map((task) => task.title)).toEqual(["Rest"]);
  });

  describe("watching", () => {
    const rows = async (t: Awaited<ReturnType<typeof taskThread>>) =>
      (
        await t.db.execute<{ id: string; until: string }>(
          "select id, until from thread_watch where kind = 'tasks'" as never,
        )
      ).rows;

    async function watching(args: unknown) {
      const t = await taskThread();
      await t.start();
      await t.post(t.ada, "Plan it");
      await t.calls(t.thread.id, [
        "thread.add_tasks",
        {
          tasks: [
            { title: "Write", assignee: t.ada.userId },
            { title: "Test", assignee: t.ada.userId },
          ],
        },
      ]);
      await t.answer(t.thread.id);
      await t.worker.idle();
      const [write, test] = (await t.tasksOf(t.thread.id)).tasks;
      await t.post(t.ada, "Wait for them");
      const ids = { write: write!.id, test: test!.id };
      await t.calls(t.thread.id, [
        "thread.watch_tasks",
        typeof args === "function" ? (args as (i: typeof ids) => unknown)(ids) : args,
      ]);
      const told = await t.answer(t.thread.id);
      await t.worker.idle();
      return { t, ids, told };
    }

    const patch = (t: Awaited<ReturnType<typeof taskThread>>, id: string, who: "grace" | "ada") =>
      t.api("PATCH", `/threads/${t.thread.id}/tasks/${id}`, t[who].cookie, { status: "done" });

    it("tells the agent once when a person finishes a task, and keeps watching until then", async () => {
      const { t, ids, told } = await watching({});
      expect(told.texts.join("\n")).toContain("You will be told once");
      expect(await rows(t)).toHaveLength(1);
      const calls = t.model.calls.length;
      // Changing a title is not done.
      await t.api("PATCH", `/threads/${t.thread.id}/tasks/${ids.write}`, t.grace.cookie, {
        title: "Write it",
      });
      await t.worker.idle();
      expect(t.model.calls.length).toBe(calls);
      expect(await rows(t)).toHaveLength(1);

      expect((await patch(t, ids.test, "grace")).status).toBe(200);
      const heard = await t.answer(t.thread.id);
      expect(heard.texts.at(-1)).toBe(
        `user: ${NOTICES_HEADING}\n\nGrace Hopper renamed task "Write" to "Write it".\n\nGrace Hopper marked task "Test" as done.`,
      );
      await t.worker.idle();
      expect(await rows(t)).toEqual([]);
      // Once only.
      const after = t.model.calls.length;
      await patch(t, ids.write, "grace");
      await t.worker.idle();
      expect(t.model.calls.length).toBe(after);
    });

    it("can wait for any change to the tasks it names", async () => {
      const { t, ids } = await watching((i: { write: string }) => ({
        ids: [i.write],
        until: "changed",
      }));
      await t.api("PATCH", `/threads/${t.thread.id}/tasks/${ids.test}`, t.grace.cookie, {
        title: "Other",
      });
      await t.worker.idle();
      expect(await rows(t)).toHaveLength(1);
      await t.api("PATCH", `/threads/${t.thread.id}/tasks/${ids.write}`, t.grace.cookie, {
        title: "Write more",
      });
      const heard = await t.answer(t.thread.id);
      expect(heard.texts.at(-1)).toContain('renamed task "Write" to "Write more"');
      expect(await rows(t)).toEqual([]);
    });

    it("hears of another agent's change but not its own", async () => {
      const t = await taskThread();
      await t.start();
      await t.post(t.ada, "Split it");
      await t.calls(
        t.thread.id,
        ["subagents.start", { name: "Scout", task: "Do the part", share_tasks: true }],
        ["thread.add_tasks", { tasks: [{ title: "Part" }, { title: "Mine" }] }],
      );
      await t.until(async () => (await t.subagentStore.ofParents([t.thread.id])).length === 1);
      const scout = await t.subagentNamed("Scout");
      await t.until(async () => (await t.tasksOf(t.thread.id)).tasks.length === 2);
      const [part, mine] = (await t.tasksOf(t.thread.id)).tasks;
      await t.calls(t.thread.id, ["thread.watch_tasks", {}]);
      await t.answer(t.thread.id);
      await t.until(async () => (await rows(t)).length === 1);

      // Its own change is not news to it.
      const status = async (id: string) =>
        (
          await t.db.execute<{ status: string }>(
            `select status from thread_task where id = '${id}'` as never,
          )
        ).rows[0]?.status;
      await t.post(t.ada, "Do yours");
      await t.calls(t.thread.id, ["thread.update_task", { id: mine!.id, status: "done" }]);
      await t.until(async () => (await status(mine!.id)) === "done");
      await t.answer(t.thread.id);
      expect(await rows(t)).toHaveLength(1);

      await t.calls(scout, ["thread.update_task", { id: part!.id, status: "done" }]);
      await t.until(async () => (await status(part!.id)) === "done");
      const heard = await t.answer(t.thread.id);
      expect(heard.texts.at(-1)).toContain('Scout marked task "Part" as done.');
      expect(await rows(t)).toEqual([]);
    });

    it("has nothing to wait on when the tasks are done, and a cap per thread", async () => {
      const { t, ids } = await watching({ ids: ["x"] });
      // An unknown id is refused.
      expect(await rows(t)).toEqual([]);
      await patch(t, ids.write, "ada");
      await t.worker.idle();
      await t.post(t.ada, "Again");
      await t.calls(t.thread.id, ["thread.watch_tasks", { ids: [ids.write] }]);
      const done = await t.answer(t.thread.id);
      expect(done.texts.at(-1)).toContain("already done");
      expect(await rows(t)).toEqual([]);

      await t.post(t.ada, "Lots");
      await t.calls(
        t.thread.id,
        ...Array.from(
          { length: 11 },
          () => ["thread.watch_tasks", { ids: [ids.test] }] as [string, unknown],
        ),
      );
      const capped = await t.answer(t.thread.id);
      expect(await rows(t)).toHaveLength(10);
      expect(capped.texts.at(-1)).toContain("10 watches at once");
    });
  });

  it("list who a task may be given to, give it to a person by id, and serve the archived list read-only", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, [
      "thread.add_tasks",
      {
        tasks: [
          { title: "Write", assignee: t.ada.userId },
          { title: "Test", assignee: t.ada.userId },
        ],
      },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    await t.post(t.grace, "I can help");
    await t.answer(t.thread.id);
    await t.worker.idle();

    // Alan only reads: he is not offered, and the reader may be given a task before they write.
    const list = await t.tasksOf(t.thread.id);
    const names = list.assignees.map((one) => one.name);
    expect(names).toContain("Grace Hopper");
    expect(names).not.toContain("Alan Turing");
    expect(list.assignees[0]).toMatchObject({ kind: "agent" });
    expect((await t.tasksOf(t.thread.id, t.alan)).assignees.map((one) => one.name)).not.toContain(
      "Alan Turing",
    );

    const [write, test] = list.tasks;
    const change = (id: string, who: { cookie: string }, assignee: unknown) =>
      t.api("PATCH", `/threads/${t.thread.id}/tasks/${id}`, who.cookie, { assignee });
    expect(
      (await change(write!.id, t.ada, { kind: "person", userId: t.grace.userId })).status,
    ).toBe(200);
    expect((await t.tasksOf(t.thread.id)).tasks[0]!.assignee).toEqual({
      kind: "person",
      userId: t.grace.userId,
      name: "Grace Hopper",
    });
    // Someone who is not in the thread cannot be given a task.
    expect((await change(write!.id, t.ada, { kind: "person", userId: t.alan.userId })).status).toBe(
      404,
    );

    // Archived tasks come back on request, and cannot be changed from there.
    await t.api("PATCH", `/threads/${t.thread.id}/tasks/${test!.id}`, t.ada.cookie, {
      status: "done",
    });
    await t.api("POST", `/threads/${t.thread.id}/tasks/archive-done`, t.ada.cookie);
    const archived = await t.api("GET", `/threads/${t.thread.id}/tasks?archived=1`, t.ada.cookie);
    expect(await archived.json()).toMatchObject({
      tasks: [{ title: "Test", status: "done" }],
      canEdit: false,
      assignees: [],
    });
    expect((await t.tasksOf(t.thread.id)).tasks.map((task) => task.title)).toEqual(["Write"]);
  });

  it("are always for someone: the creator by default, and never cleared", async () => {
    const t = await taskThread();
    await t.start();
    await t.post(t.ada, "Plan it");
    await t.calls(t.thread.id, ["thread.add_tasks", { tasks: [{ title: "Read" }] }]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const base = `/threads/${t.thread.id}/tasks`;
    await t.api("POST", base, t.ada.cookie, { title: "Write" });
    const [read, write] = (await t.tasksOf(t.thread.id)).tasks;
    // The agent's task is the agent's, a person's is theirs.
    expect(read!.assignee).toEqual({ kind: "agent" });
    expect(write!.assignee).toEqual({
      kind: "person",
      userId: t.ada.userId,
      name: "Ada Lovelace",
    });
    // A task cannot be given to nobody.
    const cleared = await t.api("PATCH", `${base}/${write!.id}`, t.ada.cookie, { assignee: null });
    expect(cleared.status).toBe(400);
    await t.post(t.ada, "Clear it");
    await t.calls(t.thread.id, ["thread.update_task", { id: write!.id, assignee: null }]);
    await t.answer(t.thread.id);
    expect((await t.tasksOf(t.thread.id)).tasks[1]!.assignee).toMatchObject({ kind: "person" });
  });
});

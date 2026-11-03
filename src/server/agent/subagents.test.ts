import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { eventSummary } from "@/server/threads/log.ts";
import type { ThreadListItem } from "@/shared/threads/list.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { LIVE_LIMIT, MESSAGE_LIMIT, RUNNING_LIMIT } from "./subagents.ts";

// A thread whose agent starts subagents, with the model's calls taken by the thread they are made
// in.
async function subagentThread() {
  const workspace = await agentThread();
  const { model, threadStore, subagentStore, thread, api } = workspace;
  const taken = new Set<Call>();
  let callCount = 0;

  // The next call the model is asked in the thread, once it is made.
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

  // The thread's next call, asking for the tool calls in one step.
  async function calls(threadId: string, ...asked: [string, unknown][]) {
    const call = await callIn(threadId);
    call.startStep();
    call.delta("On it.");
    for (const [toolId, input] of asked) {
      callCount += 1;
      call.toolCall(`call-${callCount}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }

  // The thread's next call, answered with the text.
  async function answer(threadId: string, text = "Done.") {
    const call = await callIn(threadId);
    call.reply(text);
    return call;
  }

  function rowsOf(threadId: string) {
    return transcriptOf(threadStore.eventsAfter(threadId, 0).map(eventSummary)).rows;
  }

  // The subagent's thread, by the name it was given.
  function subagentNamed(name: string) {
    const found = subagentStore.ofParents([thread.id]).find((subagent) => subagent.name === name);
    if (!found) throw new Error(`no subagent ${name}`);
    return found.threadId;
  }

  // Waits until the condition holds.
  async function until(condition: () => boolean) {
    for (let tries = 0; !condition(); tries++) {
      if (tries > 2000) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function sidebar(cookie: string) {
    const res = await api("GET", `/spaces/${workspace.space.id}/threads/sidebar`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { threads: ThreadListItem[] };
  }

  async function rowsShown(threadId: string, cookie: string) {
    const res = await api("GET", `/threads/${threadId}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { rows: ShownRow[]; subagent?: { state: string } | null };
  }

  // Answers every call made in the thread from now until the test ends.
  function keepAnswering(threadId: string) {
    let on = true;
    void (async () => {
      while (on) {
        const call = model.calls.find(
          (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
        );
        if (call) {
          taken.add(call);
          call.reply("Noted.");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    onTestFinished(() => {
      on = false;
    });
  }

  return {
    ...workspace,
    keepAnswering,
    callIn,
    calls,
    answer,
    rowsOf,
    subagentNamed,
    until,
    sidebar,
    rowsShown,
  };
}

// The rows of a thread as one line each.
function lines(rows: ReturnType<typeof transcriptOf>["rows"]) {
  return rows.map((row) => {
    switch (row.kind) {
      case "human":
        return `${row.author.name}: ${row.text}`;
      case "agent":
        return `Agent: ${row.text}`;
      case "tool":
        return `${row.toolId} (${row.state})`;
      case "relay":
        return `${row.from.name} → ${row.to}: ${row.text}`;
      case "notice":
        return `notice: ${row.subagents.map((subagent) => `${subagent.name} ${subagent.state}`).join(", ")}`;
      default:
        return row.kind;
    }
  });
}

describe("subagents", () => {
  it("start in threads of their own, work on their task, and go idle with a notice", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, rowsOf, subagentNamed, until } =
      workspace;
    start();
    await post(ada, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    // The start returns at once.
    await answer(thread.id, "Started.");
    const subagentId = subagentNamed("Researcher");
    const child = workspace.threadStore.find(subagentId)!;
    expect(child).toMatchObject({ parentThreadId: thread.id, rootThreadId: thread.id });
    expect(child.title).toBe("Researcher");

    const first = await callIn(subagentId);
    expect(first.texts).toEqual([`user: [Agent of Research queues] Compare queues`]);
    expect(first.request.instructions).toContain("You are a subagent labelled Researcher");
    expect(first.request.instructions).not.toContain("You can start subagents");
    first.reply("BullMQ wins.");
    await workspace.worker.idle();

    // Its reply stays in its own thread; its starter is told it went idle.
    expect(lines(rowsOf(subagentId))).toEqual([
      "Research queues → Researcher: Compare queues",
      "Agent: BullMQ wins.",
    ]);
    await until(() => rowsOf(thread.id).some((row) => row.kind === "notice"));
    expect(lines(rowsOf(thread.id))).toEqual([
      "Ada Lovelace: Research queues",
      "Agent: On it.",
      "subagents.start (ran)",
      "Agent: Started.",
      "notice: Researcher idle",
    ]);
    // The space lists the thread, not the subagent's, which shows under it.
    const { threads } = await workspace.sidebar(ada.cookie);
    expect(threads.map((item) => item.id)).toEqual([thread.id]);
    expect(threads[0]!.subagents).toEqual([
      expect.objectContaining({ threadId: subagentId, name: "Researcher", state: "idle" }),
    ]);
    // The line that started it shows where it stands.
    const shown = await workspace.rowsShown(thread.id, ada.cookie);
    expect(shown.rows.find((row) => row.kind === "tool")).toMatchObject({
      title: "Start · Researcher",
      subagent: { threadId: subagentId, state: "idle" },
    });
    expect((await workspace.rowsShown(subagentId, ada.cookie)).subagent).toMatchObject({
      state: "idle",
      parent: { id: thread.id, title: "Research queues" },
    });
  });

  it("send results to agent, which wakes on them, and are woken by messages", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, rowsOf, subagentNamed } = workspace;
    start();
    await post(ada, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    await answer(thread.id, "Started.");
    const subagentId = subagentNamed("Researcher");
    await calls(subagentId, ["subagents.send", { to: "agent", text: "BullMQ wins" }]);
    await answer(subagentId, "Sent.");

    // The message wakes the agent that started it.
    const woken = await callIn(thread.id);
    expect(woken.texts.at(-1)).toContain("user: [Subagent Researcher] BullMQ wins");
    // Nothing the subagent said goes along with it.
    expect(woken.texts.join("\n")).not.toContain("Sent.");
    woken.startStep();
    woken.delta("Ask more.");
    woken.toolCall("more", "subagents.send", { to: "Researcher", text: "And Graphile?" });
    woken.endStep();
    woken.end();
    await answer(thread.id, "Asked.");

    const again = await callIn(subagentId);
    expect(again.texts.at(-1)).toBe("user: [Agent of Research queues] And Graphile?");
    again.reply("Graphile too.");
    await workspace.worker.idle();
    expect(lines(rowsOf(thread.id))).toContain("Researcher → agent: BullMQ wins");
  });

  it("refuse messages to subagents they do not know, and to themselves", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, rowsOf, subagentNamed } = workspace;
    start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.send", { to: "Nobody", text: "Hi" }],
    );
    await answer(thread.id);
    const writer = subagentNamed("Writer");
    await calls(writer, ["subagents.send", { to: "Writer", text: "Hi" }]);
    await answer(writer);
    await workspace.worker.idle();
    const outputs = (threadId: string) =>
      rowsOf(threadId).flatMap((row) => (row.kind === "tool" && row.output ? [row.output] : []));
    expect(outputs(thread.id)[1]).toEqual({
      ok: false,
      error: "No live subagent is labelled Nobody. Subagents: Writer.",
    });
    expect(outputs(writer)[0]).toEqual({
      ok: false,
      error: "No live subagent is labelled Writer. Subagents: none.",
    });
  });

  it("take the messages sent while they work together at their next pause", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed } = workspace;
    start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Writer", task: "Write" }]);
    const main = await callIn(thread.id);
    const writer = subagentNamed("Writer");
    const busy = await callIn(writer);
    busy.startStep();
    // The main agent sends two messages while the subagent is mid-step.
    main.startStep();
    main.toolCall("one", "subagents.send", { to: "Writer", text: "First" });
    main.toolCall("two", "subagents.send", { to: "Writer", text: "Second" });
    main.endStep();
    main.end();
    await answer(thread.id, "Sent both.");
    await workspace.until(
      () => workspace.rowsOf(thread.id).filter((row) => row.kind === "tool").length === 3,
    );
    await workspace.until(() =>
      workspace
        .rowsOf(thread.id)
        .filter((row) => row.kind === "tool")
        .every((row) => row.state === "ran"),
    );
    busy.delta("Drafting.");
    busy.endStep();
    expect(busy.boundary()).toEqual([
      { role: "user", text: "[Agent of Go] First" },
      { role: "user", text: "[Agent of Go] Second" },
    ]);
    busy.reply("Done both.");
    await workspace.worker.idle();
  });

  it("have their starter's tools, but for those only it has", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, toolSettings } =
      workspace;
    toolSettings.setInSpace(workspace.space.id, ["thread.rename"], "off");
    start();
    await post(ada, "Go");
    const starter = await calls(thread.id, ["subagents.start", { name: "Whole", task: "Look" }]);
    await answer(thread.id);
    const whole = await callIn(subagentNamed("Whole"));
    const starterOnly = [
      "subagents.start",
      "subagents.wait",
      "subagents.stop",
      "subagents.archive",
    ];
    expect(whole.tools).toEqual(starter.tools.filter((id) => !starterOnly.includes(id)));
    expect(whole.tools).toContain("subagents.send");
    expect(whole.tools).toContain("subagents.list");
    expect(whole.tools).not.toContain("thread.rename");
    whole.reply("Looked.");
    await workspace.worker.idle();
  });

  it("started from a copy read the conversation before their own thread", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed } = workspace;
    start();
    await post(ada, "We chose Postgres");
    await answer(thread.id, "Noted.");
    await post(ada, "Now research queues");
    await calls(thread.id, [
      "subagents.start",
      { name: "Forked", task: "Compare queues", fork: true },
    ]);
    await answer(thread.id);
    const forked = await callIn(subagentNamed("Forked"));
    expect(forked.texts).toEqual([
      "user: [Ada Lovelace] We chose Postgres",
      "assistant: Noted.",
      "user: [Ada Lovelace] Now research queues",
      "assistant: On it.",
      "user: [Agent of We chose Postgres] Compare queues",
    ]);
    forked.reply("Done.");
    await workspace.worker.idle();
  });

  it(`run ${RUNNING_LIMIT} at once, queue the rest, and refuse more than ${LIVE_LIMIT}`, async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf } = workspace;
    start();
    await post(ada, "Go");
    const starts = Array.from({ length: LIVE_LIMIT + 1 }, (_, index) => [
      "subagents.start",
      { name: `H${index}`, task: "Work" },
    ]) as [string, unknown][];
    await calls(thread.id, ...starts);
    await answer(thread.id);
    const outputs = () =>
      rowsOf(thread.id).flatMap((row) => (row.kind === "tool" && row.output ? [row.output] : []));
    await workspace.until(() => outputs().length === LIVE_LIMIT + 1);
    expect(outputs().at(-1)).toEqual({
      ok: false,
      error: `This thread already has ${LIVE_LIMIT} subagents. Archive some you no longer need.`,
    });
    expect(
      outputs()
        .slice(0, LIVE_LIMIT)
        .map((output) => (output.ok ? (output.value as { state: string }).state : null)),
    ).toEqual([
      ...Array.from({ length: RUNNING_LIMIT }, () => "working"),
      ...Array.from({ length: LIVE_LIMIT - RUNNING_LIMIT }, () => "queued"),
    ]);
    // A place freed lets the next one run.
    (await callIn(subagentNamed("H0"))).reply("Done.");
    (await callIn(subagentNamed(`H${RUNNING_LIMIT}`))).reply("Done.");
    for (let index = 1; index < LIVE_LIMIT; index++) {
      if (index === RUNNING_LIMIT) continue;
      (await callIn(subagentNamed(`H${index}`))).reply("Done.");
    }
    await workspace.worker.idle();
    expect(workspace.subagents.summaryOf(subagentNamed(`H${LIVE_LIMIT - 1}`))?.state).toBe("idle");
  });

  it("stop and archive, refusing messages until a person brings them back", async () => {
    const workspace = await subagentThread();
    const { ada, alan, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, api } =
      workspace;
    start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Slow", task: "Work slowly" }]);
    await answer(thread.id);
    const slow = subagentNamed("Slow");
    const working = await callIn(slow);
    working.startStep();
    await post(ada, "Stop it");
    await calls(thread.id, ["subagents.stop", { subagent: "Slow" }]);
    await answer(thread.id);
    await workspace.worker.idle();
    expect(workspace.subagents.summaryOf(slow)?.state).toBe("stopped");
    await workspace.until(() =>
      lines(rowsOf(thread.id)).some((line) => line === "notice: Slow stopped"),
    );

    await post(ada, "Retire it");
    await calls(
      thread.id,
      ["subagents.archive", { subagent: "Slow" }],
      ["subagents.send", { to: "Slow", text: "More" }],
    );
    await answer(thread.id);
    await workspace.worker.idle();
    expect(workspace.subagents.summaryOf(slow)?.state).toBe("archived");
    const tools = rowsOf(thread.id).filter((row) => row.kind === "tool");
    expect(tools.at(-1)?.kind === "tool" && tools.at(-1)?.output).toEqual({
      ok: false,
      error: "No live subagent is labelled Slow. Subagents: none.",
    });
    // Its thread is read-only, and a person brings it back.
    expect((await workspace.rowsShown(slow, ada.cookie)).subagent).toMatchObject({
      state: "archived",
      canUnarchive: true,
    });
    const refused = await api("POST", `/threads/${slow}/messages`, ada.cookie, { text: "Hi" });
    expect(refused.status).toBe(409);
    expect((await api("POST", `/threads/${slow}/unarchive`, alan.cookie)).status).toBe(403);
    expect((await api("POST", `/threads/${slow}/unarchive`, ada.cookie)).status).toBe(200);
    expect(workspace.subagents.summaryOf(slow)?.state).toBe("stopped");
    // A person writing there resumes it.
    await workspace.api("POST", `/threads/${slow}/messages`, ada.cookie, { text: "Carry on" });
    const resumed = await callIn(slow);
    expect(resumed.texts.at(-1)).toBe("user: [Ada Lovelace] Carry on");
    resumed.reply("Carried on.");
    await workspace.worker.idle();
  });

  it("stop with the thread that started them", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, callIn, subagentNamed, api } = workspace;
    start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Slow", task: "Work" }]);
    const main = await callIn(thread.id);
    main.startStep();
    const working = await callIn(subagentNamed("Slow"));
    working.startStep();
    expect((await api("POST", `/threads/${thread.id}/stop`, ada.cookie)).status).toBe(202);
    await workspace.worker.idle();
    expect(workspace.runStore.active(thread.id)).toBeNull();
    expect(workspace.subagents.summaryOf(subagentNamed("Slow"))?.state).toBe("stopped");
  });

  it("wait until their subagents are done", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, callIn, subagentNamed, rowsOf } = workspace;
    start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.wait", { timeout: 30 }],
    );
    await workspace.until(() => workspace.subagentStore.ofParents([thread.id]).length === 1);
    const working = await callIn(subagentNamed("A"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = rowsOf(thread.id).filter((row) => row.kind === "tool")[1];
    expect(waiting?.kind === "tool" && waiting.state).toBe("pending");
    working.reply("Finished.");
    const after = await callIn(thread.id);
    expect(after.texts.join("\n")).toContain('"timedOut":false');
    expect(after.texts.join("\n")).toContain('"last":"Finished."');
    after.reply("Both done.");
    await workspace.worker.idle();
  });

  it("carry the people who steered them, so a call waits unless they all could make it", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, api } =
      workspace;
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
    await post(grace, "Rename the subagent's thread");
    await calls(thread.id, ["subagents.start", { name: "Namer", task: "Rename your thread" }]);
    await answer(thread.id);
    const namer = subagentNamed("Namer");
    await calls(namer, ["thread.rename", { title: "Named" }]);
    await workspace.until(() => workspace.runStore.active(namer)?.status === "waiting");
    // Grace steered it, so it waits; Ada may approve it, in the subagent's thread.
    const call = rowsOf(namer).find((row) => row.kind === "tool")!;
    expect(call.kind === "tool" && call.waits).toBe(true);
    // The thread that started it needs Ada, not Grace.
    expect((await workspace.sidebar(ada.cookie)).threads[0]!.status).toBe("waiting");
    expect((await workspace.sidebar(grace.cookie)).threads[0]!.status).toBe("paused");
    const decided = await api("POST", `/threads/${namer}/tools/${call.id}/decision`, ada.cookie, {
      allow: true,
      scope: "once",
    });
    expect(decided.status).toBe(200);
    await answer(namer, "Renamed.");
    await workspace.worker.idle();
    expect(workspace.threadStore.find(namer)?.title).toBe("Named");

    // Ada's words alone let the next subagent's call run directly.
    await post(ada, "Again");
    await callIn(thread.id).then((next) => {
      next.startStep();
      next.toolCall("again", "subagents.send", { to: "Namer", text: "Rename again" });
      next.endStep();
      next.end();
    });
    await answer(thread.id);
    await calls(namer, ["thread.rename", { title: "Renamed" }]);
    // Grace's words are still in the subagent's thread, so it waits again.
    await workspace.until(() => workspace.runStore.active(namer)?.status === "waiting");
  });

  it("message the others started with them, and read only theirs", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf } = workspace;
    start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.start", { name: "Critic", task: "Critique" }],
    );
    await answer(thread.id);
    const writer = subagentNamed("Writer");
    const critic = subagentNamed("Critic");
    (await callIn(writer)).reply("Waiting for notes.");
    await calls(
      critic,
      ["subagents.send", { to: ["Writer", "agent"], text: "Tighten the intro" }],
      ["subagents.send", { to: "Critic", text: "Hi" }],
      ["subagents.list", {}],
    );
    const woken = await callIn(writer);
    expect(woken.texts.at(-1)).toBe("user: [Subagent Critic] Tighten the intro");
    woken.reply("Tightened.");
    await answer(critic);
    (await callIn(thread.id)).reply("Noted.");
    await workspace.worker.idle();
    const outputs = rowsOf(critic).flatMap((row) =>
      row.kind === "tool" && row.output ? [row.output] : [],
    );
    expect(outputs[0]).toEqual({ ok: true, value: { sent: ["agent", "Writer"] } });
    expect(outputs[1]).toEqual({
      ok: false,
      error: "No live subagent is labelled Critic. Subagents: Writer.",
    });
    const listed = outputs[2]?.ok ? (outputs[2].value as { subagents: { name: string }[] }) : null;
    expect(listed?.subagents.map((subagent) => subagent.name)).toEqual(["Writer"]);
    // Each side counts the messages between them.
    expect(workspace.subagents.summaryOf(writer)?.talks).toEqual([{ with: "Critic", messages: 1 }]);
    expect(workspace.subagents.summaryOf(critic)?.talks).toEqual([{ with: "Writer", messages: 1 }]);
  });

  it(`send each other at most ${MESSAGE_LIMIT} messages, telling their starter once`, async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, subagentNamed, rowsOf, keepAnswering } =
      workspace;
    start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Quiet", task: "Listen" }],
      ["subagents.start", { name: "Chatty", task: "Talk" }],
    );
    await answer(thread.id);
    const quiet = subagentNamed("Quiet");
    keepAnswering(quiet);
    const sends = Array.from({ length: MESSAGE_LIMIT + 2 }, (_, index) => [
      "subagents.send",
      { to: "Quiet", text: `Note ${index}` },
    ]) as [string, unknown][];
    await calls(subagentNamed("Chatty"), ...sends);
    await answer(subagentNamed("Chatty"));
    keepAnswering(thread.id);
    await workspace.worker.idle();
    const outputs = rowsOf(subagentNamed("Chatty")).flatMap((row) =>
      row.kind === "tool" && row.output ? [row.output] : [],
    );
    expect(outputs.filter((output) => output.ok)).toHaveLength(MESSAGE_LIMIT);
    expect(outputs.at(-1)).toEqual({
      ok: false,
      error: `Your subagents have sent each other ${MESSAGE_LIMIT} messages, the most they may. Send what you have to agent instead.`,
    });
    expect(rowsOf(thread.id).filter((row) => row.kind === "limit")).toHaveLength(1);
  });

  it("carry whose words steered a message, and say so on the call it steered", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, callIn, subagentNamed, api } =
      workspace;
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
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.start", { name: "Critic", task: "Critique" }],
    );
    await answer(thread.id);
    const writer = subagentNamed("Writer");
    const critic = subagentNamed("Critic");
    (await callIn(writer)).reply("Ready.");
    (await callIn(critic)).reply("Ready.");
    await workspace.worker.idle();
    // Grace writes in the critic's thread; what the critic sends on carries her words.
    await api("POST", `/threads/${critic}/messages`, grace.cookie, { text: "Rename the draft" });
    await calls(critic, ["subagents.send", { to: "Writer", text: "Rename it" }]);
    await answer(critic);
    await calls(writer, ["thread.rename", { title: "Draft" }]);
    await workspace.until(() => workspace.runStore.active(writer)?.status === "waiting");
    const shown = await workspace.rowsShown(writer, ada.cookie);
    expect(shown.rows.find((row) => row.kind === "tool")).toMatchObject({
      steering: "Steered by Ada Lovelace via Agent → Writer, and Grace Hopper via Critic → Writer",
      actions: ["allow", "allow_for_now", "deny"],
    });
  });

  it("show a subagent's waiting call on the line that started it, to be decided from there", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, subagentNamed, rowsOf, api } =
      workspace;
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
    await post(grace, "Rename the subagent's thread");
    await calls(thread.id, ["subagents.start", { name: "Namer", task: "Rename your thread" }]);
    await answer(thread.id);
    const namer = subagentNamed("Namer");
    await calls(namer, ["thread.rename", { title: "Named" }]);
    await workspace.until(() => workspace.runStore.active(namer)?.status === "waiting");
    const waiting = rowsOf(namer).find((row) => row.kind === "tool")!;

    // Each reader sees the subagent's call with what they may decide on it, as in its own thread.
    const startLine = async (cookie: string) =>
      (await workspace.rowsShown(thread.id, cookie)).rows.find(
        (row) => row.kind === "tool" && row.toolId === "subagents.start",
      );
    expect(await startLine(ada.cookie)).toMatchObject({
      subagent: { threadId: namer, state: "working", needs: "approval" },
      subagentCall: {
        id: waiting.id,
        toolId: "thread.rename",
        state: "pending",
        steering: "Steered by Grace Hopper via Agent → Namer",
        actions: ["allow", "allow_for_now", "deny"],
      },
    });
    expect(await startLine(grace.cookie)).toMatchObject({
      subagentCall: { id: waiting.id, actions: [] },
    });
    expect((await workspace.sidebar(ada.cookie)).threads[0]!.status).toBe("waiting");

    // Deciding on it from there decides the subagent's call, which then leaves the line.
    const decided = await api(
      "POST",
      `/threads/${namer}/tools/${waiting.id}/decision`,
      ada.cookie,
      {
        allow: true,
        scope: "once",
      },
    );
    expect(decided.status).toBe(200);
    await answer(namer, "Renamed.");
    await workspace.worker.idle();
    expect(workspace.threadStore.find(namer)?.title).toBe("Named");
    expect(rowsOf(namer).find((row) => row.id === waiting.id)).toMatchObject({ state: "ran" });
    expect(await startLine(ada.cookie)).not.toHaveProperty("subagentCall");
  });

  it("go by their label, one used again picking the newest, whatever their threads are called", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, rowsOf, api, subagentStore } =
      workspace;
    start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Look" }]);
    await answer(thread.id);
    const [first] = subagentStore.ofParents([thread.id]);
    (await callIn(first!.threadId)).reply("Looked.");
    await workspace.worker.idle();

    await post(ada, "Again");
    await calls(
      thread.id,
      ["subagents.start", { name: "agent", task: "Look" }],
      ["subagents.archive", { subagent: "Scout" }],
      ["subagents.start", { name: "Scout", task: "Look again" }],
      ["subagents.list", { subagent: "scout" }],
    );
    await answer(thread.id);
    const second = subagentStore.ofParents([thread.id]).at(-1)!;
    (await callIn(second.threadId)).reply("Looked again.");
    await workspace.worker.idle();
    const outputs = rowsOf(thread.id).flatMap((row) =>
      row.kind === "tool" && row.output ? [row.output] : [],
    );
    expect(outputs.at(-4)).toEqual({ ok: false, error: "A subagent cannot be labelled agent." });
    const last = outputs.at(-1);
    const listed = last?.ok ? (last.value as { subagents: { id: string }[] }) : null;
    expect(listed?.subagents.map((one) => one.id)).toEqual([second.threadId]);

    // Renamed, its row in the sidebar still shows its label.
    const renamed = await api("PATCH", `/threads/${second.threadId}`, ada.cookie, {
      title: "Scouting notes",
    });
    expect(renamed.status).toBe(200);
    const [row] = (await workspace.sidebar(ada.cookie)).threads;
    expect(row!.subagents!.map((one) => one.title)).toEqual(["Scout", "Scout"]);
  });

  it("show calls made under their tools' former ids as theirs", async () => {
    const { tools, space, ada } = await subagentThread();
    const named = (toolId: string, input: unknown = {}) =>
      tools.namesIn({ id: space.id, orgId: ada.orgId })({ toolId, input, state: "ran" });
    expect(named("helpers.start", { name: "Scout" })).toEqual({
      title: "Start · Scout",
      toolset: "Subagents",
    });
    expect(named("helpers.message")).toEqual({ title: "Send", toolset: "Subagents" });
    expect(named("helpers.status")).toEqual({ title: "List", toolset: "Subagents" });
  });

  it("are never new to anyone, nor make the thread that started them new", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, api, until } =
      workspace;
    start();
    await post(ada, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    await answer(thread.id, "Started.");
    const subagentId = subagentNamed("Researcher");
    const first = await callIn(subagentId);
    await until(() => !workspace.runStore.active(thread.id));
    // Ada has read the thread before the subagent writes.
    const seq = workspace.threadStore.find(thread.id)!.lastEventSeq;
    expect((await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq })).status).toBe(200);
    first.reply("BullMQ wins.");
    await workspace.worker.idle();

    const [listed] = (await workspace.sidebar(ada.cookie)).threads;
    const [subagent] = listed!.subagents!;
    expect(subagent).toMatchObject({ threadId: subagentId, status: "read" });
    expect(subagent!.activity.lastNotableSeq).toBe(0);
    expect(listed!.status).toBe("read");
    // Its thread opens at the newest, with nothing marked new.
    const res = await api("GET", `/threads/${subagentId}`, ada.cookie);
    expect(((await res.json()) as { newFrom: string | null }).newFrom).toBeNull();
  });
});

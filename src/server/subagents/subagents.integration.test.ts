import { sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { eventSummary } from "@/server/threads/log.ts";
import type { ActivityItem } from "@/shared/jobs.ts";
import type { ThreadListItem } from "@/shared/threads/list.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";
import { type ToolRow, transcriptOf } from "@/shared/transcript.ts";

import { NOTICES_HEADING } from "@/server/execution/context.ts";
import { LIVE_LIMIT, MESSAGE_LIMIT, RUNNING_LIMIT } from "./subagents.ts";
import type { ToolSpec } from "@/server/tools/registry.ts";
import { influenceIn } from "@/server/calls/influence.ts";
import * as z from "zod";

// The notifications the model is given together, and that as the call's texts show it.
function notifications(...lines: string[]) {
  return [NOTICES_HEADING, ...lines].join("\n\n");
}

function notified(...lines: string[]) {
  return `user: ${notifications(...lines)}`;
}

// A thread whose agent starts subagents, with the model's calls taken by the thread they are made
// in.
async function subagentThread(
  options: Parameters<typeof agentThread>[0] = {},
  harness: Parameters<typeof agentThread>[1] = {},
) {
  const workspace = await agentThread(options, harness);
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

  async function rowsOf(threadId: string) {
    return transcriptOf((await threadStore.eventsAfter(threadId, 0)).map(eventSummary)).rows;
  }

  // The subagent's thread, by the name it was given.
  async function subagentNamed(name: string) {
    const found = (await subagentStore.ofParents([thread.id])).find(
      (subagent) => subagent.name === name,
    );
    if (!found) throw new Error(`no subagent ${name}`);
    return found.threadId;
  }

  // Waits until the condition holds.
  async function until(condition: () => boolean | Promise<boolean>) {
    for (let tries = 0; !(await condition()); tries++) {
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

  // Answers every call made in the thread from now until stopped, or until the test ends.
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
    return () => {
      on = false;
    };
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
      case "notice":
        return row.type === "message"
          ? `${row.from.name} → ${row.to}: ${row.text}`
          : `${row.type}: ${row.text.split("\n")[0]}`;
      default:
        return row.kind;
    }
  });
}

describe("subagents", () => {
  it("start in threads of their own, work on their task, and tell their starter when they end without reporting", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, rowsOf, subagentNamed } = workspace;
    await start();
    await post(ada, "Research queues");
    const starter = await calls(thread.id, [
      "subagents.start",
      { name: "Researcher", task: "Compare queues" },
    ]);
    expect(starter.request.instructions).toContain(
      "Subagents (`subagents__*`):\nUse a subagent to keep large work",
    );
    // The start returns at once.
    await answer(thread.id, "Started.");
    const subagentId = await subagentNamed("Researcher");
    const child = (await workspace.threadStore.find(subagentId))!;
    expect(child).toMatchObject({ parentThreadId: thread.id, rootThreadId: thread.id });
    expect(child.title).toBe("Researcher");

    const first = await callIn(subagentId);
    expect(first.texts).toEqual([
      "user: You are the subagent Researcher, started by the agent of the thread Research queues.",
      notified("[Agent of Research queues] Compare queues"),
    ]);
    expect(first.request.instructions).toContain("You are a subagent");
    expect(first.request.instructions).toContain("even if you found nothing");
    expect(first.request.instructions).toContain("with subagents__send");
    expect(first.request.instructions).not.toContain("Subagents (`subagents__*`):");
    first.reply("BullMQ wins.");

    // Its reply stays in its own thread; having sent nothing, its starter is told, with its last
    // message, and wakes on it.
    const told = await callIn(thread.id);
    expect(told.texts.at(-1)).toBe(
      notified("Researcher ended its run without reporting.\n\nIts last message:\n\nBullMQ wins."),
    );
    told.reply("Noted.");
    await workspace.worker.idle();
    expect(lines(await rowsOf(subagentId))).toEqual([
      "Research queues → Researcher: Compare queues",
      "Agent: BullMQ wins.",
    ]);
    expect(lines(await rowsOf(thread.id))).toEqual([
      "Ada Lovelace: Research queues",
      "Agent: On it.",
      "subagents.start (completed)",
      "Agent: Started.",
      "agent.ended: Researcher ended its run without reporting.",
      "Agent: Noted.",
    ]);
    // The notice links to the row it came of, and carries who steered the subagent.
    const notice = (await rowsOf(thread.id)).find((row) => row.kind === "notice");
    expect(notice).toMatchObject({
      from: { threadId: subagentId, name: "Researcher" },
      rowId: (await rowsOf(subagentId)).at(-1)!.id,
      influence: [{ userId: ada.userId, via: ["Agent", "Researcher"] }],
    });
    expect(
      (await workspace.rowsShown(thread.id, ada.cookie)).rows.find((row) => row.kind === "notice"),
    ).toMatchObject({
      type: "agent.ended",
      source: { threadId: subagentId, rowId: (await rowsOf(subagentId)).at(-1)!.id },
    });
    // The space lists the thread, not the subagent's, which shows under it.
    const { threads } = await workspace.sidebar(ada.cookie);
    expect(threads.map((item) => item.id)).toEqual([thread.id]);
    expect(threads[0]!.subagents).toEqual([
      expect.objectContaining({ threadId: subagentId, name: "Researcher", state: "idle" }),
    ]);
    // The line that started it shows where it stands.
    const shown = await workspace.rowsShown(thread.id, ada.cookie);
    expect(shown.rows.find((row) => row.kind === "tool")).toMatchObject({
      title: "Start",
      subagentName: "Researcher",
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
    await start();
    await post(ada, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    await answer(thread.id, "Started.");
    const subagentId = await subagentNamed("Researcher");
    await calls(subagentId, ["subagents.send", { to: "agent", text: "BullMQ wins" }]);
    await answer(subagentId, "Sent.");

    // The message wakes the agent that started it.
    const woken = await callIn(thread.id);
    expect(woken.texts.at(-1)).toBe(notified("[Subagent Researcher] BullMQ wins"));
    // Nothing the subagent said goes along with it.
    expect(woken.texts.join("\n")).not.toContain("Sent.");
    woken.startStep();
    woken.delta("Ask more.");
    woken.toolCall("more", "subagents.send", { to: "Researcher", text: "And Graphile?" });
    woken.endStep();
    woken.end();
    await answer(thread.id, "Asked.");

    const again = await callIn(subagentId);
    expect(again.texts.at(-1)).toBe(notified("[Agent of Research queues] And Graphile?"));
    again.reply("Graphile too.");
    await answer(thread.id, "Noted.");
    await workspace.worker.idle();
    // Having reported, its first run ends without a notice; its second, which did not, has one.
    expect(lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent."))).toEqual([
      "agent.ended: Researcher ended its run without reporting.",
    ]);
    expect(lines(await rowsOf(thread.id))).toContain("Researcher → agent: BullMQ wins");
  });

  it("refuse messages to subagents they do not know, and to themselves", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, rowsOf, subagentNamed } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.send", { to: "Nobody", text: "Hi" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const writer = await subagentNamed("Writer");
    await calls(writer, ["subagents.send", { to: "Writer", text: "Hi" }]);
    await answer(writer);
    await workspace.worker.idle();
    const outputs = async (threadId: string) =>
      (await rowsOf(threadId)).flatMap((row) =>
        row.kind === "tool" && row.output ? [row.output] : [],
      );
    expect((await outputs(thread.id))[1]).toEqual({
      ok: false,
      error: "No live subagent is labelled Nobody. Subagents: Writer.",
    });
    expect((await outputs(writer))[0]).toEqual({
      ok: false,
      error: "No live subagent is labelled Writer. Subagents: none.",
    });
  });

  it("take the messages sent while they work together at their next pause", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Writer", task: "Write" }]);
    const main = await callIn(thread.id);
    const writer = await subagentNamed("Writer");
    const busy = await callIn(writer);
    busy.startStep();
    // The main agent sends two messages while the subagent is mid-step.
    main.startStep();
    main.toolCall("one", "subagents.send", { to: "Writer", text: "First" });
    main.toolCall("two", "subagents.send", { to: "Writer", text: "Second" });
    main.endStep();
    main.end();
    await answer(thread.id, "Sent both.");
    workspace.keepAnswering(thread.id);
    await workspace.until(
      async () =>
        (await workspace.rowsOf(thread.id)).filter((row) => row.kind === "tool").length === 3,
    );
    await workspace.until(async () =>
      (await workspace.rowsOf(thread.id))
        .filter((row) => row.kind === "tool")
        .every((row) => row.state === "completed"),
    );
    busy.delta("Drafting.");
    busy.endStep();
    expect(await busy.boundary()).toEqual([
      { role: "user", text: notifications("[Agent of Go] First", "[Agent of Go] Second") },
    ]);
    busy.reply("Done both.");
    await workspace.worker.idle();
  });

  it("have their starter's tools, but for those only it has", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, toolSettings } =
      workspace;
    await toolSettings.setInSpace(workspace.space.id, ["thread.rename"], "off");
    await start();
    await post(ada, "Go");
    const starter = await calls(thread.id, ["subagents.start", { name: "Whole", task: "Look" }]);
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const whole = await callIn(await subagentNamed("Whole"));
    const starterOnly = [
      "subagents.start",
      "subagents.stop",
      "subagents.archive",
      "subagents.unarchive",
    ];
    expect(whole.tools).toEqual(starter.tools.filter((id) => !starterOnly.includes(id)));
    expect(starter.tools).not.toContain("subagents.wait");
    expect(whole.tools).toContain("subagents.send");
    expect(whole.tools).toContain("subagents.list");
    expect(whole.tools).toContain("subagents.watch");
    expect(whole.tools).not.toContain("thread.rename");
    whole.reply("Looked.");
    await workspace.worker.idle();
  });

  it("started from a copy read the conversation before their own thread", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed } = workspace;
    await start();
    await post(ada, "We chose Postgres");
    await answer(thread.id, "Noted.");
    await post(ada, "Now research queues");
    await calls(thread.id, [
      "subagents.start",
      { name: "Forked", task: "Compare queues", fork: true },
    ]);
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const forked = await callIn(await subagentNamed("Forked"));
    expect(forked.texts).toEqual([
      "user: You are the subagent Forked, started by the agent of the thread We chose Postgres.",
      "user: [Ada Lovelace] We chose Postgres",
      "assistant: Noted.",
      "user: [Ada Lovelace] Now research queues",
      "assistant: On it.",
      notified("[Agent of We chose Postgres] Compare queues"),
    ]);
    forked.reply("Done.");
    await workspace.worker.idle();
  });

  it(`run ${RUNNING_LIMIT} at once, queue the rest, and refuse more than ${LIVE_LIMIT}`, async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf } = workspace;
    await start();
    await post(ada, "Go");
    const starts = Array.from({ length: LIVE_LIMIT + 1 }, (_, index) => [
      "subagents.start",
      { name: `H${index}`, task: "Work" },
    ]) as [string, unknown][];
    await calls(thread.id, ...starts);
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const outputs = async () =>
      (await rowsOf(thread.id)).flatMap((row) =>
        row.kind === "tool" && row.output ? [row.output] : [],
      );
    await workspace.until(async () => (await outputs()).length === LIVE_LIMIT + 1);
    expect((await outputs()).at(-1)).toEqual({
      ok: false,
      error: `This thread already has ${LIVE_LIMIT} subagents. Archive some you no longer need.`,
    });
    expect(
      (await outputs())
        .slice(0, LIVE_LIMIT)
        .map((output) => (output.ok ? (output.value as { state: string }).state : null)),
    ).toEqual([
      ...Array.from({ length: RUNNING_LIMIT }, () => "working"),
      ...Array.from({ length: LIVE_LIMIT - RUNNING_LIMIT }, () => "queued"),
    ]);
    // One queued waits its turn, not on anyone.
    const res = await workspace.api("GET", `/threads/${thread.id}/activity`, ada.cookie);
    const items = ((await res.json()) as { items: ActivityItem[] }).items;
    const queued = items.find((item) => item.title === `H${RUNNING_LIMIT}`);
    expect(queued?.work.status).toBe("queued");
    expect(queued?.attention).toBeUndefined();
    // A place freed lets the next one run.
    (await callIn(await subagentNamed("H0"))).reply("Done.");
    (await callIn(await subagentNamed(`H${RUNNING_LIMIT}`))).reply("Done.");
    for (let index = 1; index < LIVE_LIMIT; index++) {
      if (index === RUNNING_LIMIT) continue;
      (await callIn(await subagentNamed(`H${index}`))).reply("Done.");
    }
    await workspace.worker.idle();
    expect(
      (await workspace.subagents.summaryOf(await subagentNamed(`H${LIVE_LIMIT - 1}`)))?.state,
    ).toBe("idle");
  });

  it("are unarchived by the agent that started them, to take messages again", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Scout", task: "Look" }],
      ["subagents.unarchive", { subagent: "Scout" }],
    );
    await answer(thread.id);
    const quiet = workspace.keepAnswering(thread.id);
    const scout = await subagentNamed("Scout");
    (await callIn(scout)).reply("Looked.");
    await workspace.worker.idle();
    quiet();

    await post(ada, "Archive it, then bring it back for more");
    await calls(
      thread.id,
      ["subagents.archive", { subagent: "Scout" }],
      ["subagents.unarchive", { subagent: "Scout" }],
      ["subagents.send", { to: "Scout", text: "Look again" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const again = await callIn(scout);
    expect(again.texts.at(-1)).toBe(notified("[Agent of Go] Look again"));
    again.reply("Looked again.");
    await workspace.worker.idle();
    expect((await workspace.subagents.summaryOf(scout))?.state).toBe("idle");
    const outputs = (await rowsOf(thread.id)).flatMap((row) =>
      row.kind === "tool" && row.output ? [row.output] : [],
    );
    // One that is live is not unarchived.
    expect(outputs[1]).toEqual({ ok: false, error: "Scout is not archived." });
    expect(outputs.slice(2)).toEqual([
      { ok: true, value: { id: scout, name: "Scout", state: "archived" } },
      { ok: true, value: { id: scout, name: "Scout", state: "idle" } },
      { ok: true, value: { sent: ["Scout"] } },
    ]);
  });

  it("stop and archive, refusing messages until a person brings them back", async () => {
    const workspace = await subagentThread();
    const { ada, alan, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, api } =
      workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Slow", task: "Work slowly" }]);
    await answer(thread.id);
    const slow = await subagentNamed("Slow");
    const working = await callIn(slow);
    working.startStep();
    await post(ada, "Stop it");
    await calls(thread.id, ["subagents.stop", { subagent: "Slow" }]);
    const quiet = workspace.keepAnswering(thread.id);
    await workspace.until(async () =>
      lines(await rowsOf(thread.id)).some((line) => line === "agent.stopped: Slow was stopped."),
    );
    await workspace.worker.idle();
    quiet();
    expect((await workspace.subagents.summaryOf(slow))?.state).toBe("stopped");

    await post(ada, "Retire it");
    await calls(
      thread.id,
      ["subagents.archive", { subagent: "Slow" }],
      ["subagents.send", { to: "Slow", text: "More" }],
    );
    await answer(thread.id);
    await workspace.worker.idle();
    expect((await workspace.subagents.summaryOf(slow))?.state).toBe("archived");
    // The start links to the task it gave, the stop and the archive to the subagent's thread, and
    // the refused send to nothing.
    const shown = (await workspace.rowsShown(thread.id, ada.cookie)).rows.flatMap((row) =>
      row.kind === "tool" ? [row.effects] : [],
    );
    expect(shown).toEqual([
      [{ kind: "task", threadId: slow, rowId: expect.any(String), name: "Slow" }],
      [{ kind: "thread", threadId: slow, name: "Slow" }],
      [{ kind: "thread", threadId: slow, name: "Slow" }],
      undefined,
    ]);
    const tools = (await rowsOf(thread.id)).filter((row) => row.kind === "tool");
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
    expect((await workspace.subagents.summaryOf(slow))?.state).toBe("stopped");
    // A person writing there resumes it.
    await workspace.api("POST", `/threads/${slow}/messages`, ada.cookie, { text: "Carry on" });
    const resumed = await callIn(slow);
    expect(resumed.texts.at(-1)).toBe("user: [Ada Lovelace] Carry on");
    workspace.keepAnswering(thread.id);
    resumed.reply("Carried on.");
    await workspace.worker.idle();
  });

  it("show in the thread's background list while not retired, with where each stands", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, api } = workspace;
    const background = async () => {
      const res = await api("GET", `/threads/${thread.id}/activity`, ada.cookie);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: ActivityItem[] }).items;
    };
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Slow", task: "Work slowly" }]);
    await answer(thread.id);
    const slow = await subagentNamed("Slow");
    const working = await callIn(slow);
    working.startStep();
    expect(await background()).toEqual([
      {
        rowId: slow,
        title: "Slow",
        work: {
          kind: "subagent",
          status: "running",
          subagent: { threadId: slow, state: "working" },
          startedAt: expect.any(String),
          canCancel: true,
        },
      },
    ]);
    // A person stops it, and it stays listed until it is retired.
    const quiet = workspace.keepAnswering(thread.id);
    expect((await api("POST", `/threads/${slow}/stop`, ada.cookie)).status).toBe(202);
    await workspace.until(
      async () => (await workspace.subagents.summaryOf(slow))?.state === "stopped",
    );
    await workspace.worker.idle();
    quiet();
    expect(await background()).toMatchObject([
      {
        title: "Slow",
        work: { status: "cancelled", subagent: { state: "stopped" }, canCancel: false },
      },
    ]);
    await post(ada, "Retire it");
    await calls(thread.id, ["subagents.archive", { subagent: "Slow" }]);
    await answer(thread.id);
    await workspace.worker.idle();
    expect(await background()).toEqual([]);
  });

  it("stop with the thread that started them", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, callIn, subagentNamed, api } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Slow", task: "Work" }]);
    const main = await callIn(thread.id);
    main.startStep();
    const working = await callIn(await subagentNamed("Slow"));
    working.startStep();
    expect((await api("POST", `/threads/${thread.id}/stop`, ada.cookie)).status).toBe(202);
    await workspace.worker.idle();
    expect(await workspace.runStore.active(thread.id)).toBeNull();
    expect((await workspace.subagents.summaryOf(await subagentNamed("Slow")))?.state).toBe(
      "stopped",
    );
    // Stopped with it, the subagent does not wake it again.
    expect((await workspace.rowsOf(thread.id)).filter((row) => row.kind === "notice")).toEqual([]);
  });

  it("watch their subagents, told once when all are idle, and at once when they already are", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, until } =
      workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.start", { name: "B", task: "Work" }],
      ["subagents.watch", { when: "all_idle" }],
    );
    await answer(thread.id, "Watching.");
    const quiet = workspace.keepAnswering(thread.id);
    const a = await subagentNamed("A");
    const b = await subagentNamed("B");
    const idleLines = async () =>
      lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent.idle"));
    await calls(a, ["subagents.send", { to: "agent", text: "A done" }]);
    await answer(a, "Sent.");
    await until(async () => (await workspace.subagents.summaryOf(a))?.state === "idle");
    expect(await idleLines()).toEqual([]);
    await calls(b, ["subagents.send", { to: "agent", text: "B done" }]);
    await answer(b, "Sent.");
    await workspace.worker.idle();
    expect(await idleLines()).toEqual(["agent.idle: All idle: A, B"]);
    // It carries who steered the subagents, and links back to the call that set it.
    expect(
      (await rowsOf(thread.id)).find((row) => row.kind === "notice" && row.type === "agent.idle"),
    ).toMatchObject({
      influence: [
        { userId: ada.userId, via: ["Agent", "A"] },
        { userId: ada.userId, via: ["Agent", "B"] },
      ],
      call: { threadId: thread.id, callId: "call-3" },
    });

    // It fires only once.
    await workspace.api("POST", `/threads/${a}/messages`, ada.cookie, { text: "Again" });
    await calls(a, ["subagents.send", { to: "agent", text: "A again" }]);
    await answer(a, "Sent.");
    await workspace.worker.idle();
    quiet();
    expect(await idleLines()).toHaveLength(1);

    // Set when its subagents are idle already, one fires at once.
    await post(ada, "Watch again");
    await calls(thread.id, ["subagents.watch", { when: "any_idle", subagents: ["B"] }]);
    const after = await callIn(thread.id);
    expect(after.texts.at(-1)).toBe(notified("Idle: B"));
    after.reply("Noted.");
    await workspace.worker.idle();
    const watches = (await rowsOf(thread.id)).flatMap((row) =>
      row.kind === "tool" && row.toolId === "subagents.watch" ? [row.output] : [],
    );
    expect(watches.at(-1)).toEqual({
      ok: true,
      value: { when: "any_idle", subagents: [{ id: b, name: "B" }] },
    });
  });

  async function watching(...watches: [string, Record<string, unknown>][]) {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, subagentNamed, rowsOf } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.start", { name: "B", task: "Work" }],
      ...watches,
    );
    await answer(thread.id, "Watching.");
    const quiet = workspace.keepAnswering(thread.id);
    const settle = async (name: string) => {
      const id = await subagentNamed(name);
      await calls(id, ["subagents.send", { to: "agent", text: `${name} done` }]);
      await answer(id, "Sent.");
      await workspace.until(
        async () => (await workspace.subagents.summaryOf(id))?.state === "idle",
      );
    };
    const idleLines = async () =>
      lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent.idle"));
    const outputs = async () =>
      (await rowsOf(thread.id)).flatMap((row) =>
        row.kind === "tool" && row.toolId === "subagents.watch" ? [row.output] : [],
      );
    return { workspace, settle, idleLines, outputs, quiet };
  }

  it("replace a pending watch set again on the same subagents", async () => {
    const { workspace, settle, idleLines, outputs, quiet } = await watching(
      ["subagents.watch", { when: "all_idle" }],
      ["subagents.watch", { when: "all_idle", subagents: ["B", "A"] }],
    );
    expect((await outputs())[0]).toMatchObject({ ok: true, value: { when: "all_idle" } });
    expect((await outputs())[1]).toMatchObject({
      ok: true,
      value: { note: "Already watching; replaced." },
    });
    await settle("A");
    await settle("B");
    await workspace.worker.idle();
    quiet();
    expect(await idleLines()).toEqual(["agent.idle: All idle: A, B"]);
  });

  it("fire a watch whose subagents settled before the checks at their run ends, once", async () => {
    // The checks at the subagents' run ends are held back, to stand for run ends that came while
    // the watch was being set.
    let live: { endKept: (run: never) => Promise<void> } | null = null;
    const heldEnds: unknown[] = [];
    const workspace = await subagentThread({
      endKept: async (run) => {
        if (live) await live.endKept(run as never);
        else heldEnds.push(run);
      },
    });
    const { ada, post, thread, start, calls, answer, subagentNamed, rowsOf, until } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.start", { name: "B", task: "Work" }],
      ["subagents.watch", { when: "all_idle" }],
    );
    await answer(thread.id, "Watching.");
    const quiet = workspace.keepAnswering(thread.id);
    for (const name of ["A", "B"]) {
      const id = await subagentNamed(name);
      await calls(id, ["subagents.send", { to: "agent", text: `${name} done` }]);
      await answer(id, "Sent.");
      await until(async () => (await workspace.subagents.summaryOf(id))?.state === "idle");
    }
    const idleLines = async () =>
      lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent.idle"));
    expect(await idleLines()).toEqual([]);
    live = { endKept: async (run) => workspace.subagents.endKept(run) };
    for (const run of heldEnds) await live.endKept(run as never);
    await workspace.worker.idle();
    expect(await idleLines()).toEqual(["agent.idle: All idle: A, B"]);
    for (const run of heldEnds) await live.endKept(run as never);
    await workspace.worker.idle();
    quiet();
    expect(await idleLines()).toHaveLength(1);
  });

  it("fire a watch only if its subagents are still idle in the write that fires it", async () => {
    let live: { endKept: (run: never) => Promise<void> } | null = null;
    const heldEnds: unknown[] = [];
    const workspace = await subagentThread({
      endKept: async (run) => {
        if (live) await live.endKept(run as never);
        else heldEnds.push(run);
      },
    });
    const { ada, post, thread, start, calls, answer, subagentNamed, rowsOf, until } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.watch", { when: "all_idle" }],
    );
    await answer(thread.id, "Watching.");
    const quiet = workspace.keepAnswering(thread.id);
    const id = await subagentNamed("A");
    await calls(id, ["subagents.send", { to: "agent", text: "A done" }]);
    await answer(id, "Sent.");
    await until(async () => (await workspace.subagents.summaryOf(id))?.state === "idle");
    // A is set working again between the check that found it idle and the write that fires.
    const write = workspace.log.write.bind(workspace.log);
    let busied = false;
    vi.spyOn(workspace.log, "write").mockImplementation(async (threadId, ...rest) => {
      if (threadId === thread.id && !busied) {
        busied = true;
        const seq = (await workspace.threadStore.find(id))!.lastEventSeq;
        await workspace.runStore.create({ threadId: id, wokenBySeq: seq, createdBy: null });
      }
      return write(threadId, ...rest);
    });
    live = { endKept: async (run) => workspace.subagents.endKept(run) };
    for (const run of heldEnds) await live.endKept(run as never);
    expect(busied).toBe(true);
    expect((await workspace.subagents.summaryOf(id))?.state).not.toBe("idle");
    quiet();
    expect(lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent.idle"))).toEqual(
      [],
    );
    vi.restoreAllMocks();
  });

  it("keep watches on a different set or condition", async () => {
    const { workspace, settle, idleLines, outputs, quiet } = await watching(
      ["subagents.watch", { when: "all_idle" }],
      ["subagents.watch", { when: "any_idle" }],
      ["subagents.watch", { when: "all_idle", subagents: ["A"] }],
    );
    for (const output of await outputs()) {
      expect(output).toMatchObject({ ok: true });
      expect((output as { value: { note?: string } }).value.note).toBeUndefined();
    }
    await settle("A");
    await settle("B");
    await workspace.worker.idle();
    quiet();
    expect((await idleLines()).toSorted()).toEqual([
      "agent.idle: All idle: A",
      "agent.idle: All idle: A, B",
      "agent.idle: Idle: A",
    ]);
  });

  it("send one notice when watches fire together with the same words", async () => {
    const { workspace, settle, idleLines, quiet } = await watching(
      ["subagents.watch", { when: "any_idle" }],
      ["subagents.watch", { when: "any_idle", subagents: ["A"] }],
    );
    await settle("A");
    await settle("B");
    await workspace.worker.idle();
    quiet();
    expect(await idleLines()).toEqual(["agent.idle: Idle: A"]);
    // The notice answers both calls, so neither fires again.
    expect(
      (await workspace.rowsOf(workspace.thread.id)).find(
        (row) => row.kind === "notice" && row.type === "agent.idle",
      ),
    ).toMatchObject({ call: { callId: "call-3" }, callIds: ["call-4"] });
  });

  it("watch the others started with them, any of them idle", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, until } =
      workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "A", task: "Work" }],
      ["subagents.start", { name: "B", task: "Work" }],
      ["subagents.watch", { when: "any_idle", subagents: ["Nobody"] }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const a = await subagentNamed("A");
    const b = await subagentNamed("B");
    const busy = await callIn(b);
    await calls(a, ["subagents.watch", { when: "any_idle" }]);
    await answer(a, "Watching.");
    await until(async () =>
      (await rowsOf(a)).some(
        (row) => row.kind === "tool" && row.toolId === "subagents.watch" && !!row.output,
      ),
    );
    busy.reply("Done.");
    const woken = await callIn(a);
    expect(woken.texts.at(-1)).toBe(notified("Idle: B"));
    woken.reply("Noted.");
    await workspace.worker.idle();
    const watched = (await rowsOf(a)).find(
      (row) => row.kind === "tool" && row.toolId === "subagents.watch",
    );
    expect(watched?.kind === "tool" && watched.output).toEqual({
      ok: true,
      value: { when: "any_idle", subagents: [{ id: b, name: "B" }] },
    });
    const refused = (await rowsOf(thread.id)).find(
      (row) => row.kind === "tool" && row.toolId === "subagents.watch",
    );
    expect(refused?.kind === "tool" && refused.output).toEqual({
      ok: false,
      error: "No live subagent is labelled Nobody. Subagents: A, B.",
    });
  });

  it("tell their starter when they fail, but not when they wait for a person", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, until } =
      workspace;
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
    await post(workspace.grace, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Faulty", task: "Work" }],
      ["subagents.start", { name: "Namer", task: "Rename your thread" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const namer = await subagentNamed("Namer");
    await calls(namer, ["thread.rename", { title: "Named" }]);
    await until(async () => (await workspace.runStore.active(namer))?.status === "waiting");
    (await callIn(await subagentNamed("Faulty"))).fail("boom");
    const notices = async () =>
      lines(await rowsOf(thread.id)).filter((line) => line.startsWith("agent."));
    await until(async () => (await notices()).length > 0);
    await until(async () => !(await workspace.runStore.active(thread.id)));
    expect(await notices()).toEqual(["agent.failed: Faulty failed: The model failed: boom"]);
  });

  it("carry the people who steered them, so a call waits unless they all could make it", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf, api } =
      workspace;
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
    await post(grace, "Rename the subagent's thread");
    await calls(thread.id, ["subagents.start", { name: "Namer", task: "Rename your thread" }]);
    await answer(thread.id);
    const quiet = workspace.keepAnswering(thread.id);
    const namer = await subagentNamed("Namer");
    await calls(namer, ["thread.rename", { title: "Named" }]);
    await workspace.until(
      async () => (await workspace.runStore.active(namer))?.status === "waiting",
    );
    // Grace steered it, so it waits; Ada may approve it, in the subagent's thread.
    const call = (await rowsOf(namer)).find((row) => row.kind === "tool")!;
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
    quiet();
    expect((await workspace.threadStore.find(namer))?.title).toBe("Named");

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
    await workspace.until(
      async () => (await workspace.runStore.active(namer))?.status === "waiting",
    );
  });

  it("message the others started with them, and read only theirs", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsOf } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.start", { name: "Critic", task: "Critique" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const writer = await subagentNamed("Writer");
    const critic = await subagentNamed("Critic");
    (await callIn(writer)).reply("Waiting for notes.");
    await calls(
      critic,
      ["subagents.send", { to: ["Writer", "agent"], text: "Tighten the intro" }],
      ["subagents.send", { to: "Critic", text: "Hi" }],
      ["subagents.list", {}],
    );
    const woken = await callIn(writer);
    expect(woken.texts.at(-1)).toBe(notified("[Subagent Critic] Tighten the intro"));
    woken.reply("Tightened.");
    await answer(critic);
    await workspace.worker.idle();
    const outputs = (await rowsOf(critic)).flatMap((row) =>
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
  });

  it("link each call to the messages it sent, and each message back to its call", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, rowsShown } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.start", { name: "Critic", task: "Critique" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const writer = await subagentNamed("Writer");
    const critic = await subagentNamed("Critic");
    (await callIn(writer)).reply("Waiting for notes.");
    await calls(critic, ["subagents.send", { to: ["Writer", "agent"], text: "Tighten it" }]);
    (await callIn(writer)).reply("Tightened.");
    await answer(critic);
    await workspace.worker.idle();

    // Each message records the call that sent it, in the thread it was made in.
    const sent = async (threadId: string) =>
      (await workspace.threadStore.eventsAfter(threadId, 0)).flatMap((event) =>
        event.type === "notice" && event.data.kind === "message" ? [event] : [],
      );
    const callOf = (event: Awaited<ReturnType<typeof sent>>[number]) => ({
      threadId: event.data.source.threadId,
      callId: event.data.source.callId,
    });
    expect((await sent(writer)).map(callOf)).toEqual([
      { threadId: thread.id, callId: "call-1" },
      { threadId: critic, callId: "call-3" },
    ]);
    const [toAgent] = await sent(thread.id);
    const [, toWriter] = await sent(writer);
    expect(callOf(toAgent!)).toEqual({ threadId: critic, callId: "call-3" });

    // The send links to each message it delivered, named as the reader sees its receiver; the
    // starts to the tasks they gave.
    const criticRows = (await rowsShown(critic, ada.cookie)).rows;
    expect(criticRows.find((row) => row.kind === "tool")).toMatchObject({
      effects: [
        { kind: "message", threadId: thread.id, rowId: toAgent!.id, name: "Agent" },
        { kind: "message", threadId: writer, rowId: toWriter!.id, name: "Writer" },
      ],
    });
    const [task] = await sent(critic);
    const mainRows = (await rowsShown(thread.id, ada.cookie)).rows;
    expect(mainRows.flatMap((row) => (row.kind === "tool" ? [row.effects] : []))).toEqual([
      [{ kind: "task", threadId: writer, rowId: (await sent(writer))[0]!.id, name: "Writer" }],
      [{ kind: "task", threadId: critic, rowId: task!.id, name: "Critic" }],
    ]);

    // Each message links back to the call that sent it, named as its line is.
    expect(mainRows.find((row) => row.id === toAgent!.id)).toMatchObject({
      kind: "notice",
      sentBy: { threadId: critic, rowId: "call-3", title: "Send", toolset: "Subagents" },
    });
    expect(
      (await rowsShown(writer, ada.cookie)).rows.filter((row) => row.kind === "notice"),
    ).toEqual([
      expect.objectContaining({
        sentBy: {
          threadId: thread.id,
          rowId: "call-1",
          title: "Start",
          toolset: "Subagents",
          thread: "Go",
        },
      }),
      expect.objectContaining({
        sentBy: expect.objectContaining({ threadId: critic, rowId: "call-3", thread: "Critic" }),
      }),
    ]);
    // What the message records stays the server's.
    expect(mainRows.find((row) => row.id === toAgent!.id)).not.toHaveProperty("call");
  });

  it(`send each other at most ${MESSAGE_LIMIT} messages, telling their starter once`, async () => {
    const workspace = await subagentThread();
    const {
      ada,
      post,
      thread,
      start,
      calls,
      answer,
      subagentNamed,
      rowsOf,
      rowsShown,
      keepAnswering,
    } = workspace;
    await start();
    await post(ada, "Go");
    await calls(
      thread.id,
      ["subagents.start", { name: "Quiet", task: "Listen" }],
      ["subagents.start", { name: "Chatty", task: "Talk" }],
    );
    await answer(thread.id);
    const quiet = await subagentNamed("Quiet");
    keepAnswering(quiet);
    const sends = Array.from({ length: MESSAGE_LIMIT + 2 }, (_, index) => [
      "subagents.send",
      { to: "Quiet", text: `Note ${index}` },
    ]) as [string, unknown][];
    await calls(await subagentNamed("Chatty"), ...sends);
    await answer(await subagentNamed("Chatty"));
    keepAnswering(thread.id);
    await workspace.worker.idle();
    const outputs = (await rowsOf(await subagentNamed("Chatty"))).flatMap((row) =>
      row.kind === "tool" && row.output ? [row.output] : [],
    );
    expect(outputs.filter((output) => output.ok)).toHaveLength(MESSAGE_LIMIT);
    expect(outputs.at(-1)).toEqual({
      ok: false,
      error: `Your subagents have sent each other ${MESSAGE_LIMIT} messages, the most they may. Send what you have to agent instead.`,
    });
    expect((await rowsOf(thread.id)).filter((row) => row.kind === "limit")).toHaveLength(1);

    // The limit links to the call first refused, named as its line is.
    const chatty = await subagentNamed("Chatty");
    const refused = (await rowsOf(chatty)).find(
      (row) => row.kind === "tool" && row.output?.ok === false,
    );
    const limit = (await rowsShown(thread.id, ada.cookie)).rows.find((row) => row.kind === "limit");
    expect(limit).toMatchObject({
      sentBy: {
        threadId: chatty,
        rowId: refused!.id,
        title: "Send",
        toolset: "Subagents",
        thread: "Chatty",
      },
    });
    expect(limit).not.toHaveProperty("call");
  });

  it("carry whose words steered a message, and say so on the call it steered", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, callIn, subagentNamed, api } =
      workspace;
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
    await calls(
      thread.id,
      ["subagents.start", { name: "Writer", task: "Write" }],
      ["subagents.start", { name: "Critic", task: "Critique" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const writer = await subagentNamed("Writer");
    const critic = await subagentNamed("Critic");
    (await callIn(writer)).reply("Ready.");
    (await callIn(critic)).reply("Ready.");
    await workspace.worker.idle();
    // Grace writes in the critic's thread; what the critic sends on carries her words.
    await api("POST", `/threads/${critic}/messages`, grace.cookie, { text: "Rename the draft" });
    await calls(critic, ["subagents.send", { to: "Writer", text: "Rename it" }]);
    await answer(critic);
    await calls(writer, ["thread.rename", { title: "Draft" }]);
    await workspace.until(
      async () => (await workspace.runStore.active(writer))?.status === "waiting",
    );
    const shown = await workspace.rowsShown(writer, ada.cookie);
    expect(shown.rows.find((row) => row.kind === "tool")).toMatchObject({
      influence: [
        { name: "Ada Lovelace", via: ["Agent", "Writer"] },
        { name: "Grace Hopper", via: ["Critic", "Writer"] },
      ],
      actions: ["allow", "allow_for_now", "deny"],
    });
  });

  it("show the agent by the name its space, else its org, gave it", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, subagentNamed, rowsOf, api } =
      workspace;
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
    const named = async () =>
      ((await (await api("GET", "/org/agent", grace.cookie)).json()) as { name: string }).name;
    expect(await named()).toBe("Agent");
    expect((await api("PATCH", "/org/agent", grace.cookie, { name: "Mira" })).status).toBe(403);
    expect((await api("PATCH", "/org/agent", ada.cookie, { name: "Mira" })).status).toBe(200);
    expect(await named()).toBe("Mira");

    await start();
    await post(grace, "Rename the subagent's thread");
    const first = await calls(thread.id, [
      "subagents.start",
      { name: "Namer", task: "Rename your thread" },
    ]);
    expect(first.request.instructions).toContain("You go by Mira here.");
    await answer(thread.id);
    const namer = await subagentNamed("Namer");
    const told = await calls(namer, ["thread.rename", { title: "Named" }]);
    expect(told.request.instructions).not.toContain("Mira");
    await workspace.until(
      async () => (await workspace.runStore.active(namer))?.status === "waiting",
    );
    const waiting = (await rowsOf(namer)).find((row) => row.kind === "tool")!;

    // Its thread and the subagent's say the name, as the line of whose words steered a call does.
    const shown = async (threadId: string) => {
      const res = await api("GET", `/threads/${threadId}`, ada.cookie);
      return (await res.json()) as { agentName: string; rows: ShownRow[] };
    };
    const steering = async () =>
      (await shown(namer)).rows.find((row) => row.id === waiting.id) as {
        influence?: { name: string; via: string[] }[];
      };
    expect((await shown(thread.id)).agentName).toBe("Mira");
    expect((await shown(namer)).agentName).toBe("Mira");
    expect((await steering()).influence).toEqual([
      { name: "Grace Hopper", via: ["Mira", "Namer"] },
    ]);

    // The space's name wins, and without one the org's shows again.
    const defaults = (agentName: string | null) =>
      api("PATCH", `/spaces/${workspace.space.id}/defaults`, ada.cookie, { agentName });
    expect((await defaults("Scribe")).status).toBe(200);
    expect((await shown(thread.id)).agentName).toBe("Scribe");
    expect((await steering()).influence).toEqual([
      { name: "Grace Hopper", via: ["Scribe", "Namer"] },
    ]);
    expect((await defaults(null)).status).toBe(200);
    expect((await shown(thread.id)).agentName).toBe("Mira");
  });

  it("show a subagent's waiting call on the line that started it, to be decided from there", async () => {
    const workspace = await subagentThread();
    const { ada, grace, post, thread, start, calls, answer, subagentNamed, rowsOf, api } =
      workspace;
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
    await post(grace, "Rename the subagent's thread");
    await calls(thread.id, ["subagents.start", { name: "Namer", task: "Rename your thread" }]);
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const namer = await subagentNamed("Namer");
    await calls(namer, ["thread.rename", { title: "Named" }]);
    await workspace.until(
      async () => (await workspace.runStore.active(namer))?.status === "waiting",
    );
    const waiting = (await rowsOf(namer)).find((row) => row.kind === "tool")!;

    // Each reader sees the subagent's call with what they may decide on it, as in its own thread.
    const startLine = async (cookie: string) =>
      (await workspace.rowsShown(thread.id, cookie)).rows.find(
        (row) => row.kind === "tool" && row.toolId === "subagents.start",
      );
    expect(await startLine(ada.cookie)).toMatchObject({
      subagent: { threadId: namer, state: "working", needs: "decision" },
      subagentCall: {
        id: waiting.id,
        toolId: "thread.rename",
        state: "waiting",
        influence: [{ name: "Grace Hopper", via: ["Agent", "Namer"] }],
        actions: ["allow", "allow_for_now", "deny"],
      },
    });
    expect(await startLine(grace.cookie)).toMatchObject({
      subagentCall: { id: waiting.id, actions: [] },
    });

    // The agent shows by the name its org gives it, and its space's where that names it too.
    const named = await api("PATCH", "/org/agent", ada.cookie, { name: "Mira" });
    expect(named.status).toBe(200);
    expect(await (await api("GET", "/org/agent", grace.cookie)).json()).toEqual({ name: "Mira" });
    expect((await api("PATCH", "/org/agent", grace.cookie, { name: "Nope" })).status).toBe(403);
    expect(await startLine(ada.cookie)).toMatchObject({
      subagentCall: { influence: [{ name: "Grace Hopper", via: ["Mira", "Namer"] }] },
    });
    const head = async (id: string) =>
      ((await (await api("GET", `/threads/${id}`, ada.cookie)).json()) as { agentName: string })
        .agentName;
    expect(await head(thread.id)).toBe("Mira");
    const spaced = await api("PATCH", `/spaces/${workspace.space.id}/defaults`, ada.cookie, {
      agentName: "Atlas",
    });
    expect(spaced.status).toBe(200);
    expect(await head(namer)).toBe("Atlas");
    expect(await startLine(ada.cookie)).toMatchObject({
      subagentCall: { influence: [{ name: "Grace Hopper", via: ["Atlas", "Namer"] }] },
    });
    // Emptied, the space follows the org again.
    await api("PATCH", `/spaces/${workspace.space.id}/defaults`, ada.cookie, { agentName: null });
    expect(await head(thread.id)).toBe("Mira");
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
    expect((await workspace.threadStore.find(namer))?.title).toBe("Named");
    expect((await rowsOf(namer)).find((row) => row.id === waiting.id)).toMatchObject({
      state: "completed",
    });
    expect(await startLine(ada.cookie)).not.toHaveProperty("subagentCall");
  });

  it("go by their label, one used again picking the newest, whatever their threads are called", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, rowsOf, api, subagentStore } =
      workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Look" }]);
    await answer(thread.id);
    const quiet = workspace.keepAnswering(thread.id);
    const [first] = await subagentStore.ofParents([thread.id]);
    (await callIn(first!.threadId)).reply("Looked.");
    await workspace.worker.idle();
    quiet();

    await post(ada, "Again");
    await calls(
      thread.id,
      ["subagents.start", { name: "agent", task: "Look" }],
      ["subagents.archive", { subagent: "Scout" }],
      ["subagents.start", { name: "Scout", task: "Look again" }],
      ["subagents.list", { subagent: "scout" }],
    );
    await answer(thread.id);
    workspace.keepAnswering(thread.id);
    const second = (await subagentStore.ofParents([thread.id])).at(-1)!;
    (await callIn(second.threadId)).reply("Looked again.");
    await workspace.worker.idle();
    const outputs = (await rowsOf(thread.id)).flatMap((row) =>
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
    const { tools, space, ada, access, thread } = await subagentThread();
    const reader = await access.require(ada, thread.id);
    // What the call's row shows it as: its names, and what its toolset's presenter adds.
    const named = async (toolId: string, input: unknown = {}) => {
      const row = { id: "c", toolId, input, state: "completed" } as ToolRow;
      return {
        ...(await tools.namesIn({ id: space.id, orgId: ada.orgId })(row)),
        ...(await tools.present(reader, [row]))(row).names,
      };
    };
    expect(await named("helpers.start", { name: "Scout" })).toEqual({
      title: "Start",
      subagentName: "Scout",
      toolset: "Subagents",
    });
    expect(await named("helpers.message")).toEqual({ title: "Send", toolset: "Subagents" });
    expect(await named("helpers.status")).toEqual({ title: "List", toolset: "Subagents" });
    // Waits, since removed, show as watches.
    expect(await named("subagents.wait")).toEqual({ title: "Watch", toolset: "Subagents" });
    expect(await named("helpers.wait")).toEqual({ title: "Watch", toolset: "Subagents" });
  });

  it("are never new to anyone", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, callIn, subagentNamed, api, until } =
      workspace;
    await start();
    await post(ada, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    await answer(thread.id, "Started.");
    const subagentId = await subagentNamed("Researcher");
    const first = await callIn(subagentId);
    await until(async () => !(await workspace.runStore.active(thread.id)));
    // Ada has read the thread before the subagent writes.
    const seq = (await workspace.threadStore.find(thread.id))!.lastEventSeq;
    expect((await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq })).status).toBe(200);
    workspace.keepAnswering(thread.id);
    first.reply("BullMQ wins.");
    await workspace.worker.idle();

    const [listed] = (await workspace.sidebar(ada.cookie)).threads;
    const [subagent] = listed!.subagents!;
    expect(subagent).toMatchObject({ threadId: subagentId, status: "read" });
    expect(subagent!.standing.lastNotableSeq).toBe(0);
    // Its thread opens at the newest, with nothing marked new.
    const res = await api("GET", `/threads/${subagentId}`, ada.cookie);
    expect(((await res.json()) as { newFrom: string | null }).newFrom).toBeNull();
  });

  it("are given a model of the agent's choosing only where the org lets it choose", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, rowsOf, api, space, threadStore } = workspace;
    await workspace.models.offer(["codex/gpt-mini"]);
    await workspace.models.plain(["codex/gpt-plain"]);
    const option = (path: string, enabled: boolean) =>
      api("PUT", `${path}/toolsets/subagents/options/choose_models`, ada.cookie, { enabled });
    const chosen = async (scope: string) => {
      const res = await api("GET", `${scope}/tools`, ada.cookie);
      const toolsets = (await res.json()) as {
        id: string;
        options?: { id: string; enabled: boolean; orgEnabled: boolean }[];
      }[];
      return toolsets.find((toolset) => toolset.id === "subagents")?.options;
    };
    const subagentThreadOf = async (name: string) =>
      threadStore.find(
        (await workspace.subagentStore.ofParents([thread.id])).findLast((one) => one.name === name)!
          .threadId,
      )!;
    // Starts the subagents in one step, each answered once.
    async function startAll(...inputs: object[]) {
      const call = await calls(
        thread.id,
        ...inputs.map((input) => ["subagents.start", input] as [string, unknown]),
      );
      await answer(thread.id);
      const quiet = workspace.keepAnswering(thread.id);
      await workspace.until(
        async () =>
          (await rowsOf(thread.id)).filter((row) => row.kind === "tool" && row.output).length >=
          startedSoFar + inputs.length,
      );
      startedSoFar += inputs.length;
      for (const subagent of await workspace.subagentStore.ofParents([thread.id])) {
        workspace.keepAnswering(subagent.threadId);
      }
      await workspace.worker.idle();
      quiet();
      return call;
    }
    let startedSoFar = 0;
    const parent = (await threadStore.find(thread.id))!;
    await start();

    // Off until the org turns it on: a start takes a model and an effort, but they are ignored.
    expect(await chosen("/org")).toEqual([
      {
        id: "choose_models",
        title: "Let the agent choose subagents' models",
        enabled: false,
        orgEnabled: false,
      },
    ]);
    await post(ada, "Go");
    const off = await startAll({ name: "Ignored", task: "Work", model: "codex/gpt-mini" });
    const startTool = JSON.stringify(
      off.request.tools?.find((tool) => tool.id === "subagents.start"),
    );
    expect(startTool).toContain('"model"');
    expect(startTool).toContain('"effort"');
    expect(await subagentThreadOf("Ignored")).toMatchObject({
      model: parent.model,
      effort: parent.effort,
    });

    // On, they are used where valid, and the start line names the model.
    expect((await option("/org", true)).status).toBe(200);
    expect(await chosen(`/spaces/${space.id}`)).toEqual([
      expect.objectContaining({ enabled: true, orgEnabled: true }),
    ]);
    await post(ada, "Again");
    await startAll(
      { name: "Mini", task: "Work", model: "codex/gpt-mini", effort: "low" },
      { name: "Same", task: "Work" },
      { name: "Nope", task: "Work", model: "codex/nope" },
      { name: "Plain", task: "Work", model: "codex/gpt-plain", effort: "high" },
    );
    // An alias names the model too; its thread stores the ref, which the start line shows.
    await workspace.models.slugs({ codex: "chatgpt" });
    await post(ada, "By alias");
    await startAll({ name: "Alias", task: "Work", model: "chatgpt/gpt-mini" });
    expect(await subagentThreadOf("Alias")).toMatchObject({ model: "codex/gpt-mini" });
    expect(await subagentThreadOf("Mini")).toMatchObject({
      model: "codex/gpt-mini",
      effort: "low",
    });
    // Not chosen, it is the starter's.
    expect(await subagentThreadOf("Same")).toMatchObject({
      model: parent.model,
      effort: parent.effort,
    });
    const refused = (await rowsOf(thread.id)).flatMap((row) =>
      row.kind === "tool" && row.output && !row.output.ok ? [row.output.error] : [],
    );
    expect(refused).toEqual([
      "codex/nope is not a model this space can use. Models: chatgpt/gpt-big, chatgpt/gpt-mini, chatgpt/gpt-plain.",
      "chatgpt/gpt-plain takes no effort.",
    ]);
    const starts = (await workspace.rowsShown(thread.id, ada.cookie)).rows.flatMap((row) =>
      row.kind === "tool" && row.title === "Start" ? [[row.subagentName, row.model]] : [],
    );
    expect(starts).toContainEqual(["Mini", "codex/gpt-mini"]);
    expect(starts).toContainEqual(["Alias", "codex/gpt-mini"]);
    expect(starts).toContainEqual(["Ignored", undefined]);

    // A space turns it off for itself, and a model given is ignored again.
    expect((await option(`/spaces/${space.id}`, false)).status).toBe(200);
    expect(await chosen(`/spaces/${space.id}`)).toEqual([
      expect.objectContaining({ enabled: false, orgEnabled: true }),
    ]);
    await post(ada, "Once more");
    await startAll({ name: "Here", task: "Work", model: "codex/gpt-mini" });
    expect(await subagentThreadOf("Here")).toMatchObject({ model: parent.model });
  });
});

describe("a subagent's calls", () => {
  it("run with whose words its agent read, and are offered no tool only its starter has", async () => {
    const seen: unknown[] = [];
    const see: ToolSpec<Record<string, never>> = {
      name: "seeing.see",
      title: "See",
      description: "Says whose words it runs with.",
      input: z.object({}).strict() as z.ZodType<Record<string, never>>,
      risk: () => "normal",
      run: (_input, ctx) => {
        seen.push(ctx.influence);
        return Promise.resolve({ ok: true, value: null });
      },
    };
    const toolset = { id: "seeing", title: "Seeing", source: "builtin" as const, tools: [see] };
    const workspace = await subagentThread({}, { toolsets: [toolset] });
    const { grace, post, thread, start, calls, answer, keepAnswering, rowsOf, subagentNamed } =
      workspace;
    const { until } = workspace;
    await start();
    await post(grace, "Research queues");
    await calls(thread.id, ["subagents.start", { name: "Researcher", task: "Compare queues" }]);
    await answer(thread.id, "Started.");
    const subagentId = await subagentNamed("Researcher");
    const first = await calls(
      subagentId,
      ["seeing.see", {}],
      ["subagents.start", { name: "Deeper", task: "Dig" }],
    );
    expect(first.request.tools?.map((tool) => tool.id)).not.toContain("subagents.start");
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(influenceIn(await rowsOf(subagentId)));
    const failed = (await rowsOf(subagentId)).find(
      (row): row is ToolRow => row.kind === "tool" && row.toolId === "subagents.start",
    );
    expect(failed?.output).toEqual({ ok: false, error: "No tool is named subagents.start here." });
    keepAnswering(thread.id);
    await answer(subagentId, "Looked.");
    await workspace.worker.idle();
  });
});

describe("a subagent under its starter's lock", () => {
  it("is not started by a notice told in a write that holds only its own thread; the pass starts it", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, subagentNamed, until, log, queue } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Wait" }]);
    await answer(thread.id, "Started.");
    const scout = await subagentNamed("Scout");
    await answer(scout, "Waiting.");
    workspace.keepAnswering(thread.id);
    await workspace.worker.idle();
    const runsOf = async () =>
      (
        await workspace.db.execute<{ id: string }>(
          sql`select id from run where thread_id = ${scout} order by id`,
        )
      ).rows.length;
    const before = await runsOf();
    await log.write(scout, async () => {
      await queue.enqueue(scout, {
        kind: "notice",
        notice: {
          kind: "agent.idle",
          source: { threadId: thread.id, name: "Agent", main: true },
          text: "Look again",
          influence: [],
        },
      });
      // Nothing started inside the write.
      expect(await runsOf()).toBe(before);
    });
    await answer(scout, "Looked.");
    await until(async () => (await runsOf()) === before + 1);
    await workspace.worker.idle();
  });

  it("is retired, and brought back, once however many ask at once", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, subagentNamed, api } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Wait" }]);
    await answer(thread.id, "Started.");
    const scout = await subagentNamed("Scout");
    await answer(scout, "Waiting.");
    workspace.keepAnswering(thread.id);
    await workspace.worker.idle();
    await workspace.subagentStore.archive(scout, new Date());
    expect(await workspace.subagentStore.archive(scout, new Date())).toBeNull();
    const statuses = await Promise.all(
      [1, 2].map(async () => (await api("POST", `/threads/${scout}/unarchive`, ada.cookie)).status),
    );
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect((await workspace.subagentStore.find(scout))?.archivedAt).toBeNull();
  });
});

describe("watches on subagents", () => {
  it("whose check was missed fire on the next pass, once however many passes run", async () => {
    const workspace = await subagentThread();
    const { ada, post, thread, start, calls, answer, subagentNamed, rowsOf } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Work" }]);
    await answer(thread.id, "Started.");
    const scout = await subagentNamed("Scout");
    await answer(scout, "Done.");
    workspace.keepAnswering(thread.id);
    await workspace.worker.idle();
    // Set while the subagent is idle, by a check no end of a run will make.
    await workspace.db.execute(
      sql`insert into thread_watch (id, thread_id, owner_id, kind, until, call_id)
          values ('w-missed', ${thread.id}, ${thread.id}, 'subagents', 'all_idle', null)`,
    );
    await workspace.db.execute(
      sql`insert into thread_watch_subject (watch_id, subject_id) values ('w-missed', ${scout})`,
    );
    const fired = await Promise.all([
      workspace.subagents.checkWatches(),
      workspace.subagents.checkWatches(),
    ]);
    expect(fired.reduce((sum, one) => sum + one, 0)).toBe(1);
    expect(await workspace.subagents.checkWatches()).toBe(0);
    await workspace.worker.idle();
    const idle = (await rowsOf(thread.id)).filter(
      (row) => row.kind === "notice" && row.type === "agent.idle",
    );
    expect(idle).toHaveLength(1);
  });
});

describe("a subagent's needs", () => {
  it("come from the calls that wait, with no transcript read", async () => {
    const toolset = {
      id: "held",
      title: "Held",
      source: "builtin" as const,
      tools: [
        {
          name: "held.ask",
          title: "Ask",
          description: "Needs approval.",
          input: z.object({}).strict(),
          risk: () => "ask" as const,
          run: async () => ({ ok: true as const, value: null }),
        } satisfies ToolSpec<Record<string, never>>,
      ],
    };
    const workspace = await subagentThread({}, { toolsets: [toolset] });
    const { ada, post, thread, start, calls, answer, subagentNamed, until } = workspace;
    await start();
    await post(ada, "Go");
    await calls(thread.id, ["subagents.start", { name: "Scout", task: "Ask" }]);
    await answer(thread.id, "Started.");
    const scout = await subagentNamed("Scout");
    await calls(scout, ["held.ask", {}]);
    await until(async () => (await workspace.subagents.summaryOf(scout))?.needs === "decision");
    const of = vi.spyOn(workspace.transcripts, "of");
    const [found] = await workspace.subagents.ofParents([thread.id]);
    expect(found?.summary).toMatchObject({ state: "working", needs: "decision" });
    expect(of).not.toHaveBeenCalled();
    of.mockRestore();
    await workspace.api("POST", `/threads/${scout}/stop`, ada.cookie);
    workspace.keepAnswering(thread.id);
    await workspace.worker.idle();
  });
});

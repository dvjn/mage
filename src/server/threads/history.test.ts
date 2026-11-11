import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { eventSummary } from "@/server/threads/log.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { Aside, AsideStreamItem } from "@/shared/threads/history.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";
import { transcriptOf } from "@/shared/transcript.ts";

// A thread where Ada asked twice and the agent answered each, with ways to act on its rows.
async function history() {
  const thread = await agentThread();
  const { ada, model, worker, post, start, api } = thread;
  thread.org.models.push("codex/gpt-small");
  start();
  async function exchange(who: { cookie: string }, text: string, reply: string) {
    await post(who, text);
    (await model.next()).reply(reply);
    await worker.idle();
  }
  await exchange(ada, "First?", "One.");
  await exchange(ada, "Second?", "Two.");
  async function read(who: { cookie: string }, branch?: string) {
    const res = await api(
      "GET",
      `/threads/${thread.thread.id}${branch ? `?branch=${branch}` : ""}`,
      who.cookie,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ThreadDetail;
  }
  function rowOf(detail: ThreadDetail, text: string) {
    const row = detail.rows.find(
      (each) => (each.kind === "human" || each.kind === "agent") && each.text === text,
    );
    if (!row) throw new Error(`no row ${text}`);
    return row as Extract<ShownRow, { kind: "human" | "agent" }>;
  }
  function act(who: { cookie: string }, body: object) {
    return api("POST", `/threads/${thread.thread.id}/history`, who.cookie, body);
  }
  function said(detail: ThreadDetail) {
    return detail.rows.flatMap((row) =>
      row.kind === "human" || row.kind === "agent" ? [`${row.kind}: ${row.text}`] : [],
    );
  }
  return { ...thread, exchange, read, rowOf, act, said };
}

// The JSON lines of a streamed answer, read one at a time; null once it ends.
function linesOf(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function next(): Promise<AsideStreamItem | null> {
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at !== -1) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        return JSON.parse(line) as AsideStreamItem;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
  }
  return Object.assign(next, { cancel: () => reader.cancel() });
}

function turnsOf(aside: Aside) {
  return aside.turns.map((turn) => [turn.role, turn.text]);
}

describe("thread history", () => {
  it("writes a reply again in a new current branch, the old one kept as a version", async () => {
    const { ada, model, worker, read, rowOf, act, said } = await history();
    const two = rowOf(await read(ada), "Two.");
    expect(two.can).toEqual(["retry", "fork", "aside"]);

    const res = await act(ada, { action: "retry", rowId: two.id });
    expect(res.status).toBe(200);
    const { branchId } = (await res.json()) as { branchId: string };
    const call = await model.next();
    // It reads the conversation up to the message the reply answered.
    expect(call.texts).toEqual([
      "user: [Ada Lovelace] First?",
      "assistant: One.",
      "user: [Ada Lovelace] Second?",
    ]);
    call.reply("Two again.");
    await worker.idle();

    const now = await read(ada);
    expect(now.branch).toEqual({ id: branchId, current: true });
    expect(said(now)).toEqual([
      "human: First?",
      "agent: One.",
      "human: Second?",
      "agent: Two again.",
    ]);
    const again = rowOf(now, "Two again.");
    expect(again.versions?.at).toBe(1);
    const older = again.versions!.branches[0]!;
    const before = await read(ada, older);
    expect(before.branch).toEqual({ id: older, current: false });
    expect(said(before).at(-1)).toBe("agent: Two.");
    expect(rowOf(before, "Two.").versions).toEqual({ at: 0, branches: [older, branchId] });
    // An older branch only restores, forks and asks aside.
    expect(rowOf(before, "Two.").can).toEqual(["restore", "fork", "aside"]);
  });

  it("sends a message again changed, and the agent reads only the new one", async () => {
    const { ada, model, worker, read, rowOf, act, said } = await history();
    const second = rowOf(await read(ada), "Second?");
    expect(second.can).toContain("edit");

    expect((await act(ada, { action: "edit", rowId: second.id, text: "Third?" })).status).toBe(200);
    const call = await model.next();
    expect(call.texts.at(-1)).toBe("user: [Ada Lovelace] Third?");
    expect(call.texts).not.toContain("user: [Ada Lovelace] Second?");
    call.reply("Three.");
    await worker.idle();

    const now = await read(ada);
    expect(said(now)).toEqual(["human: First?", "agent: One.", "human: Third?", "agent: Three."]);
    expect(rowOf(now, "Third?").versions?.at).toBe(1);
  });

  it("lets only its author edit a message", async () => {
    const { grace, read, rowOf, act } = await history();
    const second = rowOf(await read(grace), "Second?");
    expect(second.can).not.toContain("edit");
    expect((await act(grace, { action: "edit", rowId: second.id, text: "Mine" })).status).toBe(409);
  });

  it("restores past other people's messages only for the space's owners, and offers others a fork", async () => {
    const { ada, grace, read, rowOf, act, exchange, said } = await history();
    await exchange(grace, "Grace here", "Hi Grace.");
    const one = rowOf(await read(grace), "One.");
    expect(one.can).toContain("fork");
    expect(one.can).not.toContain("restore");
    expect((await act(grace, { action: "restore", rowId: one.id })).status).toBe(403);

    // Grace may go back to her own message, with nobody else's after it.
    const hers = rowOf(await read(grace), "Grace here");
    expect(hers.can).toContain("restore");

    const res = await act(ada, { action: "restore", rowId: rowOf(await read(ada), "One.").id });
    expect(res.status).toBe(200);
    const { branchId } = (await res.json()) as { branchId: string };
    const restored = await read(ada);
    expect(said(restored)).toEqual(["human: First?", "agent: One."]);

    // A line says where it was restored, and carries the versions of what came after, the branch
    // restored from at once among them.
    const line = restored.rows.at(-1)!;
    expect(line).toMatchObject({ kind: "restore", by: { name: "Ada Lovelace" } });
    const versions = line.versions!;
    expect(versions).toEqual({ at: 1, branches: [expect.any(String), branchId] });
    expect(rowOf(restored, "One.").versions).toBeUndefined();
    const left = await read(ada, versions.branches[0]);
    expect(said(left).at(2)).toBe("human: Second?");
    expect(rowOf(left, "Second?").versions).toEqual({ ...versions, at: 0 });

    // What is said next follows the line, which keeps the versions; the agent never reads it.
    await exchange(ada, "Third?", "Three.");
    const now = await read(ada);
    expect(now.rows.map((row) => row.kind)).toEqual([
      "human",
      "agent",
      "restore",
      "human",
      "agent",
    ]);
    expect(now.rows[2]!.versions).toEqual(versions);
    expect(rowOf(now, "Third?").versions).toBeUndefined();
  });

  it("offers no restore from the last message of the current branch, but from an older one's", async () => {
    const { ada, model, worker, read, rowOf, act } = await history();
    const two = rowOf(await read(ada), "Two.");
    expect(two.can).toEqual(["retry", "fork", "aside"]);
    expect((await act(ada, { action: "restore", rowId: two.id })).status).toBe(409);
    expect(rowOf(await read(ada), "Second?").can).toContain("restore");

    const res = await act(ada, { action: "retry", rowId: two.id });
    const { branchId } = (await res.json()) as { branchId: string };
    (await model.next()).reply("Two again.");
    await worker.idle();
    expect(rowOf(await read(ada), "Two again.").can).not.toContain("restore");
    const older = rowOf(await read(ada), "Two again.").versions?.branches[0];
    expect(older).toBeDefined();
    expect(older).not.toBe(branchId);
    expect(rowOf(await read(ada, older), "Two.").can).toContain("restore");
  });

  it("keeps the versions of the row restored from as they were, the restore's on its line", async () => {
    const { ada, model, worker, post, read, rowOf, act, exchange, said } = await history();
    const two = rowOf(await read(ada), "Two.");
    await act(ada, { action: "retry", rowId: two.id });
    (await model.next()).reply("Two again.");
    await worker.idle();
    const retried = rowOf(await read(ada), "Two again.").versions!;
    expect(retried.at).toBe(1);
    await exchange(ada, "Third?", "Three.");

    const res = await act(ada, {
      action: "restore",
      rowId: rowOf(await read(ada), "Two again.").id,
    });
    const { branchId } = (await res.json()) as { branchId: string };
    const now = await read(ada);
    expect(said(now).at(-1)).toBe("agent: Two again.");
    const again = rowOf(now, "Two again.").versions!;
    expect(again.at).toBe(1);
    expect(again.branches[1]).toBe(branchId);
    const line = now.rows.at(-1)!;
    expect(line.kind).toBe("restore");
    expect(line.versions).toEqual({ at: 1, branches: [expect.any(String), branchId] });

    // The agent reads the conversation without the line.
    await post(ada, "Fourth?");
    const call = await model.next();
    expect(call.texts).toEqual([
      "user: [Ada Lovelace] First?",
      "assistant: One.",
      "user: [Ada Lovelace] Second?",
      "assistant: Two again.",
      "user: [Ada Lovelace] Fourth?",
    ]);
    call.reply("Four.");
    await worker.idle();
  });

  it("finds the branch that holds a row: the current one, else the newest", async () => {
    const { ada, grace, model, worker, read, rowOf, act, api, thread } = await history();
    const branchOf = async (rowId: string) => {
      const res = await api("GET", `/threads/${thread.id}/rows/${rowId}/branch`, ada.cookie);
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    const first = await read(ada);
    const two = rowOf(first, "Two.");
    expect(await branchOf(two.id)).toEqual({
      status: 200,
      body: { id: first.branch.id, current: true },
    });

    await act(ada, { action: "retry", rowId: two.id });
    (await model.next()).reply("Two again.");
    await worker.idle();
    const retried = await read(ada);
    expect(await branchOf(two.id)).toEqual({
      status: 200,
      body: { id: first.branch.id, current: false },
    });

    // Once the first message is sent again changed, both older branches hold it, and the newer
    // one shows it.
    const asked = rowOf(retried, "First?");
    expect((await act(ada, { action: "edit", rowId: asked.id, text: "Zero?" })).status).toBe(200);
    (await model.next()).reply("Zero.");
    await worker.idle();
    expect(await branchOf(asked.id)).toEqual({
      status: 200,
      body: { id: retried.branch.id, current: false },
    });
    expect(await branchOf(rowOf(await read(ada), "Zero.").id)).toMatchObject({
      body: { current: true },
    });
    expect((await branchOf("nothing")).status).toBe(404);
    const theirs = await api("GET", `/threads/${thread.id}/rows/${two.id}/branch`, grace.cookie);
    expect(theirs.status).toBe(200);
  });

  it("asks before going past calls that changed something, and lists them", async () => {
    const { ada, model, worker, post, read, rowOf, act } = await history();
    await post(ada, "Rename it");
    const call = await model.next();
    call.startStep();
    call.toolCall("rename-1", "thread.rename", { title: "Renamed" });
    call.endStep();
    call.end();
    (await model.next()).reply("Renamed.");
    await worker.idle();

    const two = rowOf(await read(ada), "Two.");
    const asked = await act(ada, { action: "restore", rowId: two.id });
    expect(await asked.json()).toEqual({ confirm: [{ title: "Rename", toolset: "Thread" }] });
    expect((await read(ada)).rows.at(-1)).toMatchObject({ kind: "agent", text: "Renamed." });

    const done = await act(ada, { action: "restore", rowId: two.id, confirm: true });
    expect(await done.json()).toEqual({ branchId: expect.any(String) });
    expect((await read(ada)).rows.at(-2)).toMatchObject({ kind: "agent", text: "Two." });
  });

  it("stops the run under way in the branch that stops being current", async () => {
    const { ada, model, worker, post, read, rowOf, act, runs, events, threadStore, thread } =
      await history();
    await post(ada, "Slowly");
    const slow = await model.next();
    slow.startStep();
    slow.delta("Half");
    await slow.drained();

    const one = rowOf(await read(ada), "One.");
    expect((await act(ada, { action: "restore", rowId: one.id })).status).toBe(200);
    await worker.idle();

    expect(runs().at(-1)).toMatchObject({ status: "cancelled" });
    const old = threadStore.branches(thread.id)[0]!;
    const ended = transcriptOf(threadStore.eventsAfter(thread.id, 0, old.id).map(eventSummary));
    expect(ended.rows.at(-1)).toMatchObject({ kind: "stop" });
    // The current branch takes no part in it.
    expect(transcriptOf(events()).rows.map((row) => row.kind)).toEqual([
      "human",
      "agent",
      "restore",
    ]);
  });

  it("writes a reply again with another model and effort, leaving the thread's as they were", async () => {
    const { ada, model, worker, read, rowOf, act, thread, threadStore } = await history();
    const two = rowOf(await read(ada), "Two.");
    const res = await act(ada, {
      action: "retry",
      rowId: two.id,
      with: { model: "codex/gpt-small", effort: "high" },
    });
    expect(res.status).toBe(200);
    const call = await model.next();
    expect(call.request.effort).toBe("high");
    call.reply("Small.");
    await worker.idle();

    expect(rowOf(await read(ada), "Small.")).toMatchObject({ model: "codex/gpt-small" });
    expect(threadStore.find(thread.id)).toMatchObject({ model: "codex/gpt-big", effort: null });
    const refused = await act(ada, {
      action: "retry",
      rowId: rowOf(await read(ada), "Small.").id,
      with: { model: "codex/none" },
    });
    expect(refused.status).toBe(400);
  });

  it("forks a new thread from a row, keeping who wrote what and saying where it came from", async () => {
    const { ada, grace, read, rowOf, api, thread, exchange, said } = await history();
    await exchange(grace, "Grace here", "Hi Grace.");
    const hi = rowOf(await read(ada), "Hi Grace.");
    const res = await api("POST", `/threads/${thread.id}/fork`, ada.cookie, { rowId: hi.id });
    expect(res.status).toBe(200);
    const forked = (await res.json()) as { id: string };

    const detail = (await (
      await api("GET", `/threads/${forked.id}`, ada.cookie)
    ).json()) as ThreadDetail;
    expect(said(detail)).toEqual([
      "human: First?",
      "agent: One.",
      "human: Second?",
      "agent: Two.",
      "human: Grace here",
      "agent: Hi Grace.",
    ]);
    expect(rowOf(detail, "Grace here")).toMatchObject({ author: { name: "Grace Hopper" } });
    expect(detail.rows.at(-1)).toMatchObject({
      kind: "fork",
      from: { threadId: thread.id, rowId: hi.id },
      linked: true,
    });
  });

  it("answers a side question from the thread up to the row, never in the thread", async () => {
    const { ada, grace, model, read, rowOf, api, thread, types } = await history();
    const one = rowOf(await read(ada), "One.");
    const before = types();
    const res = await api("POST", `/threads/${thread.id}/asides`, ada.cookie, {
      rowId: one.id,
      text: "Why one?",
    });
    expect(res.status).toBe(200);
    const next = linesOf(res);
    expect(await next()).toMatchObject({
      type: "aside",
      aside: { turns: [{ role: "question", text: "Why one?" }] },
    });
    const call = await model.next();
    expect(call.request.answerOnly).toBe(true);
    expect(call.request.maxSteps).toBe(1);
    expect(call.texts.slice(0, 2)).toEqual(["user: [Ada Lovelace] First?", "assistant: One."]);
    expect(call.texts.at(-1)).toContain("Why one?");

    // Each piece arrives as it is written.
    call.startStep();
    call.delta("Be");
    expect(await next()).toEqual({ type: "delta", text: "Be" });
    call.delta("cause.");
    expect(await next()).toEqual({ type: "delta", text: "cause." });
    call.endStep();
    call.end();
    const last = await next();
    expect(last?.type === "aside" && turnsOf(last.aside)).toEqual([
      ["question", "Why one?"],
      ["answer", "Because."],
    ]);
    expect(await next()).toBeNull();
    expect(types()).toEqual(before);

    // Grace sees none of Ada's.
    const theirs = await api("GET", `/threads/${thread.id}/asides`, grace.cookie);
    expect(await theirs.json()).toHaveLength(0);
  });

  it("stops an answer, keeping what was written, and keeps a failure as the answer", async () => {
    const { ada, model, read, rowOf, api, thread } = await history();
    const one = rowOf(await read(ada), "One.");
    const asides = `/threads/${thread.id}/asides`;
    const next = linesOf(await api("POST", asides, ada.cookie, { rowId: one.id, text: "Why?" }));
    const asked = await next();
    const id = asked?.type === "aside" ? asked.aside.id : "";
    const call = await model.next();
    call.startStep();
    call.delta("Half");
    expect(await next()).toEqual({ type: "delta", text: "Half" });

    // Nothing more is asked until the answer is done.
    const early = await api("POST", `${asides}/${id}/messages`, ada.cookie, { text: "More?" });
    expect(early.status).toBe(409);
    expect((await api("POST", `${asides}/${id}/stop`, ada.cookie)).status).toBe(200);
    const stopped = await next();
    expect(stopped?.type === "aside" && turnsOf(stopped.aside)).toEqual([
      ["question", "Why?"],
      ["answer", "Half"],
    ]);

    const again = linesOf(
      await api("POST", `${asides}/${id}/messages`, ada.cookie, { text: "More?" }),
    );
    await again();
    (await model.next()).fail("Overloaded");
    const failed = await again();
    expect(failed?.type === "aside" && failed.aside.turns.at(-1)).toMatchObject({
      role: "answer",
      text: "",
      failure: "error",
      error: "Overloaded",
    });
  });

  it("stops an answer once the asker goes", async () => {
    const { ada, model, read, rowOf, api, thread } = await history();
    const one = rowOf(await read(ada), "One.");
    const asides = `/threads/${thread.id}/asides`;
    const res = await api("POST", asides, ada.cookie, { rowId: one.id, text: "Why?" });
    const next = linesOf(res);
    await next();
    const call = await model.next();
    await next.cancel();
    while (!call.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
    let kept: Aside[] = [];
    while (kept[0]?.turns.length !== 2) {
      kept = (await (await api("GET", asides, ada.cookie)).json()) as Aside[];
    }
    expect(kept[0]!.turns[1]).toMatchObject({ role: "answer", text: "", failure: "stopped" });
  });
});

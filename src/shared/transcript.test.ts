import { describe, expect, it } from "vite-plus/test";

import type { AnyThreadEvent } from "@/shared/threads/events.ts";
import { agentTurnOf, createFold, type TranscriptRow } from "@/shared/transcript.ts";

const row = (kind: string, extra: object = {}) => ({ kind, id: kind, ...extra }) as TranscriptRow;
const human = row("human");
const tool = row("tool");
const words = row("agent", { status: "completed", text: "Done", reasoning: null, model: "a/b" });
const thinking = row("agent", { status: "streaming", text: "", reasoning: "Hm", model: "a/c" });
const callsOnly = row("agent", { status: "completed", text: "", reasoning: null, model: "a/d" });

describe("agentTurnOf", () => {
  it("opens a turn with a call after a person's message or at the start", () => {
    expect(agentTurnOf([tool], 0)?.continued).toBe(false);
    expect(agentTurnOf([human, tool], 1)?.continued).toBe(false);
    expect(agentTurnOf([human, callsOnly, tool], 2)?.continued).toBe(false);
  });

  it("opens a turn with a reply after a person's message", () => {
    expect(agentTurnOf([human, words], 1)).toEqual({ continued: false, model: "a/b" });
    expect(agentTurnOf([human, thinking], 1)).toEqual({ continued: false, model: "a/c" });
  });

  it("continues a turn after the agent's words or a call, past a step that only called tools", () => {
    expect(agentTurnOf([human, words, tool], 2)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, tool], 2)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, callsOnly, tool], 3)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, words], 2)?.continued).toBe(true);
  });

  it("names the model of the turn's reply from its first call", () => {
    expect(agentTurnOf([human, callsOnly, tool, tool, words], 2)?.model).toBe("a/b");
    expect(agentTurnOf([human, callsOnly, tool, tool, words], 3)?.model).toBe("a/b");
    expect(agentTurnOf([human, callsOnly, tool, thinking], 2)?.model).toBe("a/c");
  });

  it("has no model for a turn whose reply has not begun or that a person's message ends", () => {
    expect(agentTurnOf([human, callsOnly, tool], 2)?.model).toBeNull();
    expect(agentTurnOf([human, tool, human, words], 1)?.model).toBeNull();
    expect(agentTurnOf([human, tool, row("failure")], 1)?.model).toBeNull();
  });

  it("is null for a person's message, a step that only called tools, and the rest", () => {
    expect(agentTurnOf([human, words], 0)).toBeNull();
    expect(agentTurnOf([human, callsOnly, tool], 1)).toBeNull();
    expect(agentTurnOf([human, row("failure")], 1)).toBeNull();
    expect(agentTurnOf([human, row("stop")], 1)).toBeNull();
    expect(agentTurnOf([human], 1)).toBeNull();
  });
});

describe("createFold", () => {
  const ada = { kind: "user", userId: "ada", name: "Ada Lovelace" };
  const agent = { kind: "agent" };
  let seq = 0;
  function event(type: string, data: object, actor: object = agent): AnyThreadEvent {
    seq += 1;
    return {
      id: `e${seq}`,
      threadId: "t",
      seq,
      type,
      data,
      actor: actor as AnyThreadEvent["actor"],
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    };
  }
  const message = (text: string, quiet = false) =>
    event("message", { parts: [{ type: "text", text }], quiet, mode: "steer" }, ada);
  const run = { runId: "r1" };

  // The fold of the events, and for each row its kind, place and the seq that last changed it.
  function folded(...events: AnyThreadEvent[]) {
    const fold = createFold();
    const changes: [string, number][][] = [];
    for (const each of events) {
      fold.add(each);
      changes.push(fold.transcript().rows.map((row, index) => [row.kind, fold.changedAt(index)]));
    }
    return { fold, changes };
  }

  it("keeps each row's place, and the last event that changed it", () => {
    seq = 0;
    const { fold, changes } = folded(
      message("// Aside", true),
      message("Hello"),
      event("run.created", { ...run, reason: null, continuesRunId: null }, ada),
      event("message.admitted", { ...run, messageIds: ["e2"] }),
      event("message.started", { ...run, messageId: "m1", model: "a/b" }),
      event("message.completed", {
        ...run,
        messageId: "m1",
        parts: [{ type: "text", text: "Hi" }],
        status: "completed",
      }),
      event("run.completed", run),
    );

    expect(changes).toEqual([
      [["human", 1]],
      // A message the agent has not taken in is no row yet.
      [["human", 1]],
      [["human", 1]],
      [
        ["human", 1],
        ["human", 4],
      ],
      [
        ["human", 1],
        ["human", 4],
        ["agent", 5],
      ],
      [
        ["human", 1],
        ["human", 4],
        ["agent", 6],
      ],
      [
        ["human", 1],
        ["human", 4],
        ["agent", 6],
      ],
    ]);
    expect(fold.last).toBe(7);
    expect(fold.turnAt(2)).toEqual({ continued: false, model: "a/b" });
    expect(fold.turnAt(0)).toBeNull();
  });

  it("changes a call as it is decided and runs, and the turn of the calls before a reply", () => {
    seq = 0;
    const requested = (callId: string) =>
      event("tool.requested", {
        ...run,
        callId,
        messageId: "m1",
        toolId: "thread.rename",
        input: { title: "Looms" },
        risk: "normal",
        waits: callId === "c1",
      });
    const { fold, changes } = folded(
      message("// Rename it", true),
      event("message.started", { ...run, messageId: "m1", model: "a/b" }),
      event("message.completed", { ...run, messageId: "m1", parts: [], status: "completed" }),
      requested("c1"),
      requested("c2"),
      event("tool.approved", { ...run, callId: "c1", scope: "once" }, ada),
      event("tool.ran", { ...run, callId: "c1", ok: true, ms: 3 }),
      event("message.started", { ...run, messageId: "m2", model: "a/c" }),
    );

    // The step that only called tools shows as its calls; the second call continues the turn.
    expect(fold.turnAt(1)).toBeNull();
    expect(changes[4]).toEqual([
      ["human", 1],
      ["agent", 3],
      ["tool", 4],
      ["tool", 5],
    ]);
    expect(changes[6]![2]).toEqual(["tool", 7]);
    // The reply names the turn's model, which changes the calls before it.
    expect(changes[7]).toEqual([
      ["human", 1],
      ["agent", 3],
      ["tool", 8],
      ["tool", 8],
      ["agent", 8],
    ]);
    expect([fold.turnAt(2), fold.turnAt(3), fold.turnAt(4)]).toEqual([
      { continued: false, model: "a/c" },
      { continued: true, model: "a/c" },
      { continued: true, model: "a/c" },
    ]);
  });

  it("marks the replies a retry tries again as changed", () => {
    seq = 0;
    const { changes } = folded(
      event("message.started", { ...run, messageId: "m1" }),
      event("message.completed", { ...run, messageId: "m1", parts: [], status: "failed" }),
      event("run.failed", { ...run, error: "Down" }),
      event("run.created", { runId: "r2", reason: "retry", continuesRunId: "r1" }, ada),
    );

    expect(changes.at(-1)).toEqual([
      ["agent", 4],
      ["failure", 3],
    ]);
  });

  it("holds other agents' messages until taken in, and tells subagents that ended together", () => {
    seq = 0;
    const relayed = (text: string) =>
      event("agent.message", {
        parts: [{ type: "text", text }],
        from: { threadId: "h1", name: "Writer", main: false },
        to: "agent",
        steeredBy: [{ userId: "ada", name: "Ada Lovelace", via: ["Writer"] }],
      });
    const ended = (threadId: string, name: string, state: string) =>
      event("subagent.ended", { threadId, name, state, last: `${name} done` });
    const fold = createFold();
    for (const each of [
      relayed("Draft one"),
      relayed("Draft two"),
      ended("h1", "Writer", "idle"),
      ended("h2", "Critic", "idle"),
      ended("h1", "Writer", "stopped"),
    ]) {
      fold.add(each);
    }
    expect(fold.transcript().inbox.map((message) => message.text)).toEqual([
      "Draft one",
      "Draft two",
    ]);
    // Subagents that ended one after another are one notice, each with its latest.
    expect(fold.transcript().rows).toEqual([
      expect.objectContaining({
        kind: "notice",
        seq: 3,
        subagents: [
          { threadId: "h2", name: "Critic", state: "idle", last: "Critic done" },
          { threadId: "h1", name: "Writer", state: "stopped", last: "Writer done" },
        ],
      }),
    ]);
    fold.add(event("message.admitted", { ...run, messageIds: ["e1", "e2"] }));
    fold.add(ended("h2", "Critic", "failed"));
    const { rows, inbox } = fold.transcript();
    expect(inbox).toEqual([]);
    expect(rows.map((one) => [one.kind, one.seq])).toEqual([
      ["notice", 3],
      ["relay", 6],
      ["relay", 6],
      ["notice", 7],
    ]);
    expect(rows[1]).toMatchObject({ from: { name: "Writer" }, to: "agent", text: "Draft one" });
  });
});

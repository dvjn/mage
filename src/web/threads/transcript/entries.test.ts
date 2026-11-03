import { describe, expect, it } from "vite-plus/test";

import type { AgentRow, ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import { transcriptEntries } from "@/web/threads/transcript/entries.ts";

let order = 0;

function turn(continued = true) {
  return { continued, model: null };
}

function call(id: string, overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id,
    order: order++,
    seq: order,
    turn: turn(),
    runId: "run1",
    messageId: "m1",
    toolId: "fetch",
    title: "Fetch",
    toolset: "Web",
    input: {},
    risk: "auto",
    waits: false,
    requestedAt: "2026-11-01T00:00:00.000Z",
    state: "ran",
    decision: null,
    output: null,
    ms: null,
    ...overrides,
  } as ToolRow;
}

function step(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    kind: "agent",
    id,
    order: order++,
    seq: order,
    turn: turn(),
    runId: "run1",
    model: null,
    startedAt: "2026-11-01T00:00:00.000Z",
    text: "",
    reasoning: "",
    thoughtMs: null,
    status: "completed",
    usage: null,
    retried: false,
    ...overrides,
  };
}

function human(id: string): ShownRow {
  return {
    kind: "human",
    id,
    order: order++,
    seq: order,
    turn: null,
    author: { kind: "user", userId: "ada", name: "Ada Lovelace" },
    postedAt: "2026-11-01T00:00:00.000Z",
    text: "Hello",
    quiet: false,
  };
}

function relay(id: string): ShownRow {
  return {
    kind: "relay",
    id,
    order: order++,
    seq: order,
    turn: null,
    postedAt: "2026-11-01T00:00:00.000Z",
    from: { threadId: "subagent1", name: "Researcher", main: false },
    to: "agent",
    text: "Research complete",
  } as ShownRow;
}

function notice(id: string): ShownRow {
  return {
    kind: "notice",
    id,
    order: order++,
    seq: order,
    turn: null,
    subagents: [{ threadId: "subagent1", name: "Researcher", state: "idle", last: "Done" }],
  };
}

const thought = (id: string) => step(id, { reasoning: "Thinking it over" });
const reply = (id: string) => step(id, { text: "Done" });
// A step that only called tools, which shows as nothing.
const silent = (id: string) => step(id, { turn: null });

// Each entry as its key and, for a run, the ids it holds.
function shape(rows: ShownRow[]) {
  return transcriptEntries(rows).map((entry) =>
    entry.kind === "calls" || entry.kind === "relays"
      ? [entry.key, entry.rows.map((row) => row.id), entry.gap]
      : [entry.key, entry.gap],
  );
}

describe("transcriptEntries", () => {
  it("folds consecutive calls of a turn into one run keyed by its first", () => {
    const rows = [
      human("h"),
      silent("s1"),
      call("c1", { turn: turn(false) }),
      call("c2"),
      silent("s2"),
      call("c3"),
    ];
    expect(shape(rows)).toEqual([
      ["h", "apart"],
      ["calls:c1", ["c1", "c2", "c3"], "apart"],
    ]);
  });

  it("keeps the steps that only thought between calls inside the run", () => {
    const rows = [call("c1", { turn: turn(false) }), thought("t1"), call("c2"), thought("t2")];
    expect(shape(rows)).toEqual([
      ["calls:c1", ["c1", "t1", "c2"], "apart"],
      ["t2", "close"],
    ]);
  });

  it("ends a run at text", () => {
    const rows = [
      call("c1", { turn: turn(false) }),
      call("c2"),
      reply("r1"),
      call("c3"),
      call("c4"),
      reply("r2"),
    ];
    expect(shape(rows)).toEqual([
      ["calls:c1", ["c1", "c2"], "apart"],
      ["r1", "near"],
      ["calls:c3", ["c3", "c4"], "near"],
      ["r2", "near"],
    ]);
  });

  it("splits runs at calls that wait as cards", () => {
    const rows = [
      call("c1", { turn: turn(false) }),
      call("c2"),
      call("w1", { state: "pending", waits: true }),
      call("c3"),
      call("c4"),
    ];
    expect(shape(rows)).toEqual([
      ["calls:c1", ["c1", "c2"], "apart"],
      ["w1", "near"],
      ["calls:c3", ["c3", "c4"], "near"],
    ]);
  });

  it("leaves a single call as its line", () => {
    const rows = [call("c1", { turn: turn(false) }), thought("t1"), reply("r1")];
    expect(shape(rows)).toEqual([
      ["c1", "apart"],
      ["t1", "close"],
      ["r1", "near"],
    ]);
  });

  it("folds calls in every state but waiting, running ones too", () => {
    const rows = [
      call("c1", { turn: turn(false), state: "failed" }),
      call("c2", { state: "denied" }),
      call("c3", { state: "stopped" }),
      call("c4", { state: "allowed" }),
      call("c5", { state: "pending" }),
    ];
    const [entry] = transcriptEntries(rows);
    expect(entry?.kind === "calls" && entry.calls.map((row) => row.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("does not fold calls across turns", () => {
    const rows = [call("c1", { turn: turn(false) }), call("c2", { turn: turn(false) })];
    expect(shape(rows)).toEqual([
      ["c1", "apart"],
      ["c2", "apart"],
    ]);
  });

  it("keeps a run's key as it grows", () => {
    const first = [call("c1", { turn: turn(false) }), call("c2")];
    const grown = [...first, thought("t1"), call("c3")];
    expect(transcriptEntries(first)[0]?.key).toBe(transcriptEntries(grown)[0]?.key);
  });

  it("shows a subagent's waiting call as its card after the entry that started the subagent", () => {
    const subagent = { threadId: "subagent1", name: "Researcher", state: "working" as const };
    const waiting = call("w1", { state: "pending", waits: true });
    const rows = [
      call("c1", { turn: turn(false), toolId: "subagents.start", subagent, subagentCall: waiting }),
      call("c2"),
      reply("r1"),
    ];
    const entries = transcriptEntries(rows);
    expect(shape(rows)).toEqual([
      ["calls:c1", ["c1", "c2"], "apart"],
      ["subagent:w1", "apart"],
      ["r1", "near"],
    ]);
    expect(entries[1]).toMatchObject({ row: { id: "w1" }, subagent: { threadId: "subagent1" } });
  });

  it("joins notices and agents' messages to the turn they follow, folding messages in a row", () => {
    const rows = [
      call("c1", { turn: turn(false) }),
      call("c2"),
      notice("n1"),
      relay("m1"),
      relay("m2"),
      relay("m3"),
      notice("n2"),
      relay("m4"),
      // The agent's next turn.
      step("r1", { text: "Done", turn: turn(false) }),
    ];
    expect(shape(rows)).toEqual([
      ["calls:c1", ["c1", "c2"], "apart"],
      ["n1", "close"],
      ["relays:m1", ["m1", "m2", "m3"], "close"],
      ["n2", "close"],
      ["relays:m4", ["m4"], "close"],
      ["r1", "apart"],
    ]);
  });

  it("opens a turn with messages that follow none, and keeps their run's key as it grows", () => {
    const first = [human("h"), relay("m1")];
    const grown = [...first, relay("m2"), notice("n1")];
    expect(shape(grown)).toEqual([
      ["h", "apart"],
      ["relays:m1", ["m1", "m2"], "apart"],
      ["n1", "close"],
    ]);
    expect(transcriptEntries(first)[1]?.key).toBe(transcriptEntries(grown)[1]?.key);
  });
});

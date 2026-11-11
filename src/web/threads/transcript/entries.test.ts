import { describe, expect, it } from "vite-plus/test";

import type { AgentRow, RelayRow, ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import { agentTurnOf, type TranscriptRow } from "@/shared/transcript.ts";
import {
  transcriptEntries,
  transcriptTurns,
  type TranscriptBlock,
} from "@/web/threads/transcript/entries.ts";

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
    author: { kind: "user", userId: "ada", name: "Ada Lovelace", former: false },
    postedAt: "2026-11-01T00:00:00.000Z",
    text: "Hello",
    quiet: false,
  };
}

function relay(id: string, type: RelayRow["type"] = "message"): ShownRow {
  return {
    kind: "relay",
    id,
    order: order++,
    seq: order,
    turn: null,
    postedAt: "2026-11-01T00:00:00.000Z",
    type,
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
      ? [entry.key, entry.rows.map((row) => row.id)]
      : [entry.key],
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
    expect(shape(rows)).toEqual([["h"], ["calls:c1", ["c1", "c2", "c3"]]]);
  });

  it("keeps the steps that only thought between calls inside the run", () => {
    const rows = [call("c1", { turn: turn(false) }), thought("t1"), call("c2"), thought("t2")];
    expect(shape(rows)).toEqual([["calls:c1", ["c1", "t1", "c2"]], ["t2"]]);
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
      ["calls:c1", ["c1", "c2"]],
      ["r1"],
      ["calls:c3", ["c3", "c4"]],
      ["r2"],
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
    expect(shape(rows)).toEqual([["calls:c1", ["c1", "c2"]], ["w1"], ["calls:c3", ["c3", "c4"]]]);
  });

  it("leaves a single call as its line", () => {
    const rows = [call("c1", { turn: turn(false) }), thought("t1"), reply("r1")];
    expect(shape(rows)).toEqual([["c1"], ["t1"], ["r1"]]);
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
    expect(shape(rows)).toEqual([["c1"], ["c2"]]);
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
    expect(shape(rows)).toEqual([["calls:c1", ["c1", "c2"]], ["subagent:w1"], ["r1"]]);
    expect(entries[1]).toMatchObject({ row: { id: "w1" }, subagent: { threadId: "subagent1" } });
  });

  it("keeps mixed incoming activity compact between full replies", () => {
    const rows = [
      step("r1", { text: "Waiting for the reviewers", turn: turn(false) }),
      relay("m1"),
      call("list", { turn: turn(false) }),
      relay("m2"),
      notice("idle"),
      call("watch1", { turn: turn(false) }),
      call("watch2"),
      reply("r2"),
    ];
    expect(shape(rows)).toEqual([
      ["r1"],
      ["relays:m1", ["m1"]],
      ["list"],
      ["relays:m2", ["m2"]],
      ["idle"],
      ["calls:watch1", ["watch1", "watch2"]],
      ["r2"],
    ]);
  });

  it("keeps received messages and notices outside the agent turn, folding consecutive messages from one sender", () => {
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
      ["calls:c1", ["c1", "c2"]],
      ["n1"],
      ["relays:m1", ["m1", "m2", "m3"]],
      ["n2"],
      ["relays:m4", ["m4"]],
      ["r1"],
    ]);
  });

  it("starts a fresh agent header after top-level received messages and notices", () => {
    const raw = [human("h"), reply("r1"), relay("m1"), call("archive"), notice("n1"), reply("r2")];
    const rows = raw.map((row, i) => ({ ...row, turn: agentTurnOf(raw as TranscriptRow[], i) }));
    const entries = transcriptEntries(rows);
    expect(shape(rows)).toEqual([
      ["h"],
      ["r1"],
      ["relays:m1", ["m1"]],
      ["archive"],
      ["n1"],
      ["r2"],
    ]);
    expect(
      entries.filter((entry) =>
        entry.kind === "row"
          ? entry.row.turn?.continued === false
          : entry.kind === "calls" && !entry.turn.continued,
      ),
    ).toHaveLength(3);
  });

  it("opens the agent header after incoming activity even with cached continuation metadata", () => {
    for (const incoming of [relay("incoming"), notice("incoming")]) {
      const single = transcriptEntries([incoming, call("list")]);
      const last = single.at(-1)!;
      expect(last.kind === "row" && last.row.turn?.continued).toBe(false);
      const grouped = transcriptEntries([incoming, call("list"), call("watch")]).at(-1)!;
      expect(grouped.kind === "calls" && grouped.turn.continued).toBe(false);
    }
  });

  it("keeps messages from different senders as separate top-level entries", () => {
    const first = relay("m1");
    const second = relay("m2");
    if (second.kind !== "relay") throw new Error("Expected a relay");
    second.from = { threadId: "other", name: "Writer", main: false };
    expect(shape([first, second])).toEqual([
      ["relays:m1", ["m1"]],
      ["relays:m2", ["m2"]],
    ]);
  });

  it("folds other notifications with each other, apart from messages", () => {
    const rows = [
      human("h"),
      relay("m1"),
      relay("e1", "agent.ended"),
      relay("e2", "agent.idle"),
      relay("m2"),
    ];
    expect(shape(rows)).toEqual([
      ["h"],
      ["relays:m1", ["m1"]],
      ["relays:e1", ["e1", "e2"]],
      ["relays:m2", ["m2"]],
    ]);
  });

  it("opens a turn with messages that follow none, and keeps their run's key as it grows", () => {
    const first = [human("h"), relay("m1")];
    const grown = [...first, relay("m2"), notice("n1")];
    expect(shape(grown)).toEqual([["h"], ["relays:m1", ["m1", "m2"]], ["n1"]]);
    expect(transcriptEntries(first)[1]?.key).toBe(transcriptEntries(grown)[1]?.key);
  });
});

describe("cards after a reply", () => {
  const made = (id: string, version: number, toolId = "artifact.publish") =>
    call(`c-${id}-${version}`, {
      toolId,
      output: { ok: true, value: { id, version, title: id } },
    } as Partial<ToolRow>);

  it("show one card per artifact at its latest version, after the turn's last entry", () => {
    const [agent] = transcriptTurns([
      made("a", 1, "artifact.publish"),
      made("b", 1),
      made("a", 2, "artifact.update"),
      step("reply", { text: "Done" }),
    ]);
    const last = agent!.blocks.at(-1)!;
    expect(last.kind).toBe("artifacts");
    expect(last.kind === "artifacts" && last.items.map((i) => `${i.id}${i.version}`)).toEqual([
      "a2",
      "b1",
    ]);
  });

  it("skip an artifact the reply shows", () => {
    const [agent] = transcriptTurns([
      made("a", 1),
      made("b", 1),
      step("reply", { text: '```ui\nroot = Stack([x])\nx = Artifact("a")\n```' }),
    ]);
    const last = agent!.blocks.at(-1)!;
    expect(last.kind === "artifacts" && last.items.map((i) => i.id)).toEqual(["b"]);
    expect(
      transcriptTurns([made("a", 1), step("reply", { text: '```ui\nx = Artifact("a")\n```' })])
        .flatMap((each) => each.blocks)
        .some((block) => block.kind === "artifacts"),
    ).toBe(false);
  });
});

// Each turn as its kind, its blocks (a run of lines by the keys it holds), and its actions' step.
function turns(rows: ShownRow[], running = false) {
  const blockOf = (block: TranscriptBlock) =>
    block.kind === "lines" ? ["lines", block.entries.map((entry) => entry.key)] : [block.kind];
  return transcriptTurns(rows, { running }).map((each) => [
    each.kind,
    each.blocks.map(blockOf),
    each.actions?.id,
  ]);
}

describe("transcriptTurns", () => {
  it("groups the rows into turns by who they are from", () => {
    const rows = [
      human("h"),
      reply("r1"),
      relay("m1"),
      notice("n1"),
      step("r2", { text: "Again", turn: turn(false) }),
    ];
    expect(transcriptTurns(rows).map((each) => each.kind)).toEqual([
      "human",
      "agent",
      "incoming",
      "incoming",
      "agent",
    ]);
  });

  it("makes an event such as a failure a turn of its own", () => {
    const failure = {
      kind: "failure",
      id: "f",
      order: order++,
      seq: order,
      turn: null,
    } as ShownRow;
    expect(transcriptTurns([reply("r1"), failure]).map((each) => each.kind)).toEqual([
      "agent",
      "event",
    ]);
  });

  it("runs consecutive lines together, and text and cards end the run", () => {
    const rows = [
      call("c1", { turn: turn(false) }),
      thought("t1"),
      reply("r1"),
      call("c2"),
      call("w1", { state: "pending", waits: true }),
      call("c3"),
    ];
    expect(turns(rows)).toEqual([
      [
        "agent",
        [["lines", ["c1", "t1"]], ["row"], ["lines", ["c2"]], ["row"], ["lines", ["c3"]]],
        // The last step wrote text, so it shows its own actions.
        undefined,
      ],
    ]);
  });

  it("places the artifacts block after the turn's last block", () => {
    const made = call("p1", {
      turn: turn(false),
      toolId: "artifact.publish",
      output: { ok: true, value: { id: "a", version: 1, title: "a" } },
    } as Partial<ToolRow>);
    const kinds = transcriptTurns([made, call("c2"), reply("r1")])[0]!.blocks.map(
      (block) => block.kind,
    );
    expect(kinds).toEqual(["lines", "row", "artifacts"]);
  });

  it("shows actions after a turn that ends on a call made by a step with no text or reasoning", () => {
    const rows = [human("h"), silent("s1"), call("c1", { turn: turn(false) }), call("c2")];
    expect(turns(rows)).toEqual([
      ["human", [["row"]], undefined],
      ["agent", [["lines", ["calls:c1"]]], "s1"],
    ]);
  });

  it("shows none after a turn whose last step shows its own, or a human or incoming turn", () => {
    expect(turns([human("h"), reply("r1"), relay("m1")]).map((each) => each[2])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("shows none while the last turn is still running", () => {
    const rows = [human("h"), silent("s1"), call("c1", { turn: turn(false) }), call("c2")];
    expect(turns(rows, true).at(-1)?.[2]).toBeUndefined();
    expect(turns(rows, false).at(-1)?.[2]).toBe("s1");
  });
});

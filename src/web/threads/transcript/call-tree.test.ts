import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ASK_TOOL } from "@/shared/ask.ts";
import { START_JOB } from "@/shared/jobs.ts";
import type { ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import {
  byTool,
  callsKey,
  callsUnder,
  nodeLineKey,
  openForWaiting,
  opensFor,
  runningNow,
  runStanding,
  tallyOf,
  toolsKey,
  treeOf,
} from "@/web/threads/transcript/call-tree";
import { transcriptEntries, transcriptTurns } from "@/web/threads/transcript/entries";
import { lineKey, RowFocusContext } from "@/web/threads/transcript/row-focus";
import { ToolLine } from "@/web/threads/transcript/tool-line";

let order = 0;

function call(id: string, overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id,
    order: order++,
    seq: order,
    turn: { continued: true, model: null },
    runId: "run1",
    messageId: "m1",
    toolId: "fetch",
    title: "Fetch",
    toolset: "Web",
    input: {},
    risk: "auto",
    requestedAt: "2026-11-01T00:00:00.000Z",
    state: "completed",
    decision: null,
    output: null,
    ms: null,
    ...overrides,
  } as ToolRow;
}

const under = (parent: ToolRow, overrides: Partial<ToolRow> = {}) =>
  call(`${parent.id}.${order}`, { parent: { id: parent.id, title: parent.title }, ...overrides });

function job(start: ToolRow, overrides: Partial<ToolRow> = {}) {
  return under(start, {
    work: { kind: "job", status: "running", startedAt: null, canCancel: true },
    ...overrides,
  });
}

const tree = (root: ToolRow, rows: ToolRow[]) => treeOf(root, callsUnder(rows));

// The line as it renders with the given keys held open by the page.
function rendered(row: ToolRow, rows: ToolRow[], opened: string[] = []) {
  const focus = { opened: new Set(opened), onOpenChange: () => {} };
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { enabled: false } } }) },
      createElement(
        RowFocusContext.Provider,
        { value: focus },
        createElement(ToolLine, { row, definition: undefined, under: rows }),
      ),
    ),
  );
}

describe("a script's calls", () => {
  it("group by tool in the order each was first called, a tool called once its own row", () => {
    const script = call("script", { toolId: "scripts.run", state: "ready" });
    const list = under(script, { toolId: "list" });
    const get1 = under(script, { toolId: "get" });
    const ex1 = under(script, { toolId: "exercise" });
    const get2 = under(script, { toolId: "get" });
    const ex2 = under(script, { toolId: "exercise", state: "failed" });
    const items = byTool(tree(script, [list, get1, ex1, get2, ex2]));
    expect(items.map((item) => (item.kind === "call" ? item.node.row.id : item.key))).toEqual([
      list.id,
      toolsKey("script", "get"),
      toolsKey("script", "exercise"),
    ]);
    const exercises = items[2]!;
    expect(exercises.kind === "tool" && exercises.nodes.map((node) => node.row.id)).toEqual([
      ex1.id,
      ex2.id,
    ]);
    expect(exercises.kind === "tool" && exercises.standing).toBe("done");
  });

  it("keep a nested script and a job as rows of their own", () => {
    const script = call("script", { toolId: "scripts.run" });
    const first = under(script, { toolId: START_JOB });
    const started = job(first);
    const second = under(script, { toolId: START_JOB });
    const other = job(second);
    const items = byTool(tree(script, [first, started, second, other]));
    expect(items.map((item) => item.kind === "call" && item.node.row.id)).toEqual([
      started.id,
      other.id,
    ]);
  });

  it("count every call under them at every depth, and what became of each", () => {
    const script = call("script", { toolId: "scripts.run" });
    const start = under(script, { toolId: START_JOB });
    const started = job(start, { toolId: "scripts.run" });
    const deep = under(started, { state: "failed" });
    const denied = under(script, { state: "denied" });
    const stale = under(script, { state: "stale" });
    const skipped = under(script, { state: "skipped" });
    const { calls, outcomes } = tallyOf(
      tree(script, [start, started, deep, denied, stale, skipped]),
    );
    expect(calls).toBe(5);
    expect(outcomes).toEqual(["running", "failed", "denied", "denied", "skipped"]);
  });

  it("name the call running now, the last that made none of its own", () => {
    const script = call("script", { state: "ready" });
    const done = under(script);
    const running = under(script, { state: "ready" });
    expect(runningNow(tree(script, [done, running]))?.row.id).toBe(running.id);
    expect(runningNow(tree(script, [done]))).toBeUndefined();
  });

  it("show a script that caught a failed call and returned as done, by its own icon", () => {
    const script = call("script", { toolId: "scripts.run", title: "Run script" });
    const html = rendered(script, [under(script, { state: "failed" })]);
    expect(html).toContain("lucide-check");
    expect(html).toContain("Run script · Ran · 1 call · 1 failed");
  });
});

describe("a job", () => {
  it("takes the place of the Start that made it, known by the Start's id", () => {
    const start = call("start", { toolId: START_JOB });
    const alone = tree(start, []);
    const started = job(start);
    const node = tree(start, [started]);
    expect(node.row.id).toBe(started.id);
    expect(node.start?.id).toBe(start.id);
    // The line stays open as the job arrives in its Start's place.
    expect(nodeLineKey(node)).toBe(nodeLineKey(alone));
  });

  it("does not where the Start made none", () => {
    const start = call("start", { toolId: START_JOB, state: "failed" });
    expect(tree(start, []).row.id).toBe(start.id);
  });

  it("is judged in a run by where the job stands, not by its Start", () => {
    const start = call("start", { toolId: START_JOB });
    const started = job(start, {
      work: { kind: "job", status: "failed", startedAt: null, canCancel: false },
    });
    expect(runStanding([start], [started]).standing).toBe("failed");
    expect(runStanding([start], [job(start)]).standing).toBe("running");
  });

  it("opens from a link to its Start or to itself", () => {
    const start = call("start", { toolId: START_JOB });
    const started = job(start);
    expect(opensFor([start, started], start.id)).toEqual([]);
    expect(opensFor([start, started], started.id)).toEqual([start.id, lineKey(start.id)]);
  });
});

describe("a call waiting for approval", () => {
  it("holds open every line, list of calls and group by tool above it", () => {
    const script = call("script", { toolId: "scripts.run", state: "waiting" });
    const start = under(script, { toolId: START_JOB });
    const started = job(start, { toolId: "scripts.run", state: "waiting" });
    const other = under(started, { toolId: "add" });
    const waiting = under(started, { toolId: "add", state: "waiting" });
    const unrelated = under(script, { toolId: "get" });
    const node = tree(script, [start, started, other, waiting, unrelated]);
    expect(openForWaiting(node)).toEqual(
      new Set([
        lineKey(script.id),
        callsKey(script.id),
        lineKey(start.id),
        callsKey(start.id),
        toolsKey(start.id, "add"),
      ]),
    );
  });

  it("holds nothing open where none waits", () => {
    const script = call("script");
    expect(openForWaiting(tree(script, [under(script), under(script)])).size).toBe(0);
  });

  it("is opened to by a link: the run of calls, then each level down to it", () => {
    const script = call("script", { toolId: "scripts.run" });
    const get1 = under(script, { toolId: "get" });
    const get2 = under(script, { toolId: "get" });
    expect(opensFor([script, get1, get2], get2.id)).toEqual([
      script.id,
      lineKey(script.id),
      callsKey(script.id),
      toolsKey(script.id, "get"),
      lineKey(get2.id),
    ]);
    expect(opensFor([script, get1, get2], script.id)).toEqual([]);
  });
});

describe("a call opened alone", () => {
  it("stays in sight as a second call of its tool makes it a group", () => {
    const script = call("script", { toolId: "scripts.run", title: "Run script" });
    const first = under(script, { toolId: "get", title: "Get", input: { id: "first-input" } });
    const opened = [lineKey(script.id), callsKey(script.id), lineKey(first.id)];
    expect(rendered(script, [first], opened)).toContain("first-input");
    const second = under(script, { toolId: "get", title: "Get" });
    const html = rendered(script, [first, second], opened);
    expect(html).toContain("Get · ×2");
    expect(html).toContain("first-input");
  });
});

describe("the thread's runs of calls", () => {
  it("hold only the agent's own calls, the calls under them alongside", () => {
    const script = call("script", { toolId: "scripts.run" });
    const inner = [under(script), under(script), under(script)];
    const after = call("after");
    const entries = transcriptEntries([script, ...inner, after]);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.kind === "calls" && entry.calls.map((one) => one.id)).toEqual([
      script.id,
      after.id,
    ]);
    expect(entry?.kind === "calls" && entry.under.map((one) => one.id)).toEqual(
      inner.map((one) => one.id),
    );
  });

  it("show a call apart where the call that made it is not held", () => {
    const orphan = call("orphan", { parent: { id: "gone", title: "Run script" }, depth: 1 });
    const entries = transcriptEntries([orphan]);
    expect(entries.map((entry) => entry.kind === "row" && entry.row.id)).toEqual([orphan.id]);
  });

  it("start the agent's turn anew after a message where a job's call that opened it moves under the job", () => {
    const start = call("start", { toolId: START_JOB, turn: { continued: false, model: null } });
    const started = job(start);
    const message: ShownRow = {
      kind: "human",
      id: "message",
      order: order++,
      seq: order,
      turn: null,
      author: { kind: "user", userId: "ada", name: "Ada", former: false },
      postedAt: "2026-11-01T00:00:00.000Z",
      text: "Hello",
      quiet: false,
    };
    // The job's call came first after the message, so the agent's call after it was continued.
    const inner = under(started, { turn: { continued: false, model: null } });
    const next = call("next");
    const turns = transcriptTurns([start, started, message, inner, next]);
    const last = turns.at(-1)!;
    expect(last.kind).toBe("agent");
    const [block] = last.blocks;
    expect(block?.kind === "row" && block.row.turn?.continued).toBe(false);
  });

  it("show the card of a subagent's question asked under a script", () => {
    const script = call("script", { toolId: "scripts.run" });
    const asking = under(script, {
      toolId: "subagents.start",
      subagent: {
        threadId: "sub",
        name: "Helper",
        state: "working",
        needs: "answer",
      } as ToolRow["subagent"],
      subagentCall: call("question", { toolId: ASK_TOOL, state: "waiting" }),
    });
    const entries = transcriptEntries([script, asking]);
    expect(entries.map((entry) => entry.kind)).toEqual(["row", "subagent"]);
  });
});

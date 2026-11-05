import { describe, expect, it } from "vite-plus/test";

import type { TranscriptRow } from "@/shared/transcript.ts";

import {
  contextOf,
  framingMessage,
  type Guidance,
  instructionsFor,
  summaryMessage,
} from "./context.ts";

const ada = { kind: "user", userId: "u1", name: "Ada Lovelace" } as const;
const bob = { kind: "user", userId: "u2", name: "Bob Hope" } as const;

function rowsOf() {
  let seq = 0;
  const rows: TranscriptRow[] = [];
  const add = <T extends object>(row: T) => {
    rows.push(row as unknown as TranscriptRow);
    return row;
  };
  return {
    rows,
    human: (author: typeof ada | typeof bob, text: string, quiet = false) =>
      add({ kind: "human", id: `h${++seq}`, seq, author, postedAt: "", text, quiet }),
    agent: (text: string, effort?: "low" | "medium" | "high") =>
      add({
        kind: "agent",
        id: `a${++seq}`,
        seq,
        runId: "r1",
        model: null,
        ...(effort && { effort }),
        startedAt: "",
        text,
        reasoning: "",
        thoughtMs: null,
        status: "completed",
        usage: null,
        retried: false,
      }),
    tool: (messageId: string, toolId: string) =>
      add({
        kind: "tool",
        id: `call${++seq}`,
        seq,
        runId: "r1",
        messageId,
        toolId,
        input: {},
        risk: "normal",
        waits: false,
        requestedAt: "",
        state: "ran",
        decision: null,
        output: { ok: true, value: { turnedOn: ["mcp.notes.echo"] } },
        ms: 3,
      }),
    relay: (text: string) =>
      add({
        kind: "relay",
        id: `n${++seq}`,
        seq,
        postedAt: "",
        type: "message",
        from: { threadId: "t2", name: "Researcher", main: false },
        text,
        steeredBy: [],
      }),
    compaction: (firstKeptSeq: number, summary: string) =>
      add({
        kind: "compaction",
        id: `c${++seq}`,
        seq,
        by: null,
        summary,
        firstKeptSeq,
        tokensBefore: 100,
        tokensAfter: 10,
      }),
  };
}

const guidance: Guidance = {
  org: "Be brief.",
  space: "Launch work.",
  agentName: "Mira",
  toolsets: [{ name: "Rich replies", text: "On." }],
};

// Whether the later request starts as the earlier one did: the same system prompt, and the earlier
// messages unchanged at its start.
function keepsPrefix(earlier: ReturnType<typeof contextOf>, later: ReturnType<typeof contextOf>) {
  expect(later.instructions).toBe(earlier.instructions);
  expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages);
}

describe("the system prompt", () => {
  it("names tools as the model knows them", () => {
    const prompt = instructionsFor({
      org: "",
      space: "",
      subagent: true,
      skills: [{ name: "notes", description: "Taking notes" }],
      mcpServers: [{ name: "Notes", prefix: "mcp.notes.*", text: "Title notes.", cut: false }],
      deferredTools: [
        {
          server: "Notes",
          prefix: "mcp.notes",
          tools: [{ name: "mcp.notes.echo", description: "Say it back" }],
        },
      ],
      toolName: (id) => (id === "skills.load" ? "skills.load_1a2b3c" : id),
    });
    expect(prompt).toContain("with subagents__send,");
    expect(prompt).toContain("load it with skills__load_1a2b3c");
    expect(prompt).toContain("turn on with mcp_servers__search_tools");
    expect(prompt).toContain("From Notes (`mcp__notes__*`):\nTitle notes.");
    expect(prompt).toContain("Notes (`mcp__notes__*`):\n- mcp__notes__echo: Say it back");
  });
});

describe("the agent's request", () => {
  it("keeps its start across the next turn, a new person's first message, an aside and a notification", () => {
    const thread = rowsOf();
    thread.human(ada, "Plan the launch");
    thread.agent("Here's the plan.");
    let earlier = contextOf(thread.rows, guidance);
    for (const next of [
      () => thread.human(ada, "And the budget?"),
      () => thread.human(bob, "Hi all"),
      () => thread.human(bob, "// psst", true),
      () => thread.relay("Found 3 sources"),
    ]) {
      next();
      const later = contextOf(thread.rows, guidance);
      keepsPrefix(earlier, later);
      earlier = later;
    }
  });

  it("keeps its start when a search turns tools on, and in the runs after", () => {
    const thread = rowsOf();
    thread.human(ada, "Echo hello");
    const asking = thread.agent("");
    const search = thread.tool(asking.id, "mcp_servers.search_tools");
    const before = contextOf(thread.rows, guidance);
    const on = [{ id: "mcp.notes.echo", callId: search.id }];
    const turned = contextOf(thread.rows, guidance, [], on);
    keepsPrefix(before, turned);
    expect(turned.messages.at(-1)).toEqual({ role: "change", tools: ["mcp.notes.echo"] });
    thread.agent("Said.");
    const again = thread.human(ada, "Again");
    const later = contextOf(thread.rows, guidance, [], on);
    keepsPrefix(turned, later);
    expect(later.messages.map((message) => message.role).slice(-3)).toEqual([
      "change",
      "assistant",
      "user",
    ]);
    // Once compacted away, the tools are told before the first reply.
    thread.compaction(again.seq, "Echoed.");
    const compacted = contextOf(thread.rows, guidance, [], on);
    expect(compacted.instructions).toBe(before.instructions);
    expect(compacted.messages.at(-1)).toEqual({ role: "change", tools: ["mcp.notes.echo"] });
  });

  it("keeps the thread's first effort, and tells a change where it happened", () => {
    const thread = rowsOf();
    thread.human(ada, "Plan the launch");
    thread.agent("Here's the plan.", "low");
    thread.human(ada, "Think harder");
    const asked = contextOf(thread.rows, guidance, [], [], "high");
    expect(asked.firstEffort).toBe("low");
    expect(asked.messages.at(-1)).toEqual({ role: "change", effort: "high" });
    thread.agent("Thought harder.", "high");
    thread.human(ada, "Thanks");
    const after = contextOf(thread.rows, guidance, [], [], "high");
    keepsPrefix(asked, after);
    expect(after.firstEffort).toBe("low");
    expect(after.messages.filter((message) => message.role === "change")).toHaveLength(1);
  });

  it("keeps its system prompt through a compaction, the summary leading the messages", () => {
    const thread = rowsOf();
    thread.human(ada, "Plan the launch");
    const reply = thread.agent("Here's the plan.");
    const before = contextOf(thread.rows, guidance);
    thread.compaction(reply.seq, "Ada and the agent planned the launch.");
    thread.human(ada, "Go on");
    const after = contextOf(thread.rows, guidance);
    expect(after.instructions).toBe(before.instructions);
    expect(after.messages[0]).toEqual(summaryMessage("Ada and the agent planned the launch."));
  });

  it("gives every subagent the same system prompt, and its own framing as its first message", () => {
    const thread = rowsOf();
    thread.relay("Compare queues");
    const subagent = { ...guidance, subagent: true };
    const framing = framingMessage({ name: "Scout", parent: "Queues", instructions: "Cite." });
    const scout = contextOf(thread.rows, subagent, [framing]);
    const other = contextOf(thread.rows, subagent, [
      framingMessage({ name: "Critic", parent: "Renamed" }),
    ]);
    expect(scout.instructions).toBe(other.instructions);
    expect(scout.instructions).not.toMatch(/Scout|Queues|Cite/);
    expect(scout.messages[0]).toEqual(framing);
  });
});

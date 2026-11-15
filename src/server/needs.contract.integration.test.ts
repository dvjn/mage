// What waits on whom, as its clients meet it. A call that waits for a person shows in three
// places today: on its row in the thread, in the thread's activity tray, and as the thread's
// status in its space's list. These tests say what each place shows each reader, side by side, for
// a call of the thread's own run, of a job, and of a subagent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, type Person, type World, world } from "@/server/testing/contract.ts";

// The three places, for one reader: the waiting rows of the thread with what the reader may do
// from each, the tray's items that want someone, and the thread's status in its list.
async function surfaces(w: World, who: Person) {
  const detail = await w.detail(who);
  const rows = detail.rows.flatMap((row) => {
    if (row.kind !== "tool") return [];
    const own =
      row.state === "waiting"
        ? [{ row: row.toolId, actions: row.actions ?? null, canAnswer: row.canAnswer ?? null }]
        : [];
    const below = row.subagentCall
      ? [
          {
            subagent: row.subagent?.name,
            needs: row.subagent?.needs ?? null,
            row: row.subagentCall.toolId,
            actions: row.subagentCall.actions ?? null,
          },
        ]
      : [];
    return [...own, ...below];
  });
  const tray = (await w.activity(who))
    .filter((item) => item.attention || item.work.subagent?.needs)
    .map((item) => ({
      kind: item.work.kind,
      status: item.work.status,
      attention: item.attention ?? null,
      canDecide: item.work.canDecide ?? null,
      needs: item.work.subagent?.needs ?? null,
    }));
  const listed = await w.listed(who);
  return {
    run: detail.run?.waiting ?? null,
    rows,
    tray,
    list: { status: listed.status, needsYou: listed.standing.needsYou },
  };
}

describe("a call of the thread's own run that waits for a decision", () => {
  it("needs those who may decide it, and shows the rest that the agent is paused", async () => {
    const w = await world();
    await w.post(w.ada, "Do the guarded thing");
    await w.asks(w.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );

    for (const who of [w.ada, w.grace]) {
      expect(await surfaces(w, who)).toEqual({
        run: "decision",
        rows: [{ row: "probe.guarded", actions: ["allow", "deny"], canAnswer: null }],
        tray: [
          {
            kind: "decision",
            status: "waiting",
            attention: "approval",
            canDecide: true,
            needs: null,
          },
        ],
        list: { status: "waiting", needsYou: true },
      });
    }
    expect(await surfaces(w, w.alan)).toEqual({
      run: "decision",
      rows: [{ row: "probe.guarded", actions: [], canAnswer: null }],
      // The tray lists a decision only for those who may make it.
      tray: [],
      list: { status: "paused", needsYou: false },
    });
  });
});

describe("a call of the thread's own run that waits for answers", () => {
  it("needs those who may answer", async () => {
    const w = await world();
    await w.post(w.ada, "Ask me");
    await w.asks(w.threadId, [
      "thread.ask",
      {
        questions: [
          { question: "Which one?", header: "Pick", options: [{ label: "One" }, { label: "Two" }] },
        ],
      },
    ]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "answer",
    );
    expect(await surfaces(w, w.grace)).toEqual({
      run: "answer",
      rows: [{ row: "thread.ask", actions: null, canAnswer: true }],
      tray: [],
      list: { status: "waiting", needsYou: true },
    });
    expect(await surfaces(w, w.alan)).toEqual({
      run: "answer",
      rows: [{ row: "thread.ask", actions: null, canAnswer: false }],
      tray: [],
      list: { status: "paused", needsYou: false },
    });
  });
});

describe("a job that waits for a decision", () => {
  it("needs those who may decide it, with no run waiting", async () => {
    const w = await world();
    await w.post(w.ada, "Start a guarded job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.guarded", input: { label: "a" } }]);
    await w.answers(w.threadId, "Asked for.");
    await w.settled();

    expect(await surfaces(w, w.ada)).toEqual({
      run: null,
      rows: [{ row: "probe.guarded", actions: ["allow", "deny"], canAnswer: null }],
      // The tray lists the decision and the job it is for.
      tray: [
        {
          kind: "decision",
          status: "waiting",
          attention: "approval",
          canDecide: true,
          needs: null,
        },
        { kind: "job", status: "waiting", attention: "approval", canDecide: true, needs: null },
      ],
      list: { status: "waiting", needsYou: true },
    });
    // To someone who may not decide, a waiting job is not the agent paused: the thread reads as
    // any other with something new.
    expect(await surfaces(w, w.alan)).toEqual({
      run: null,
      rows: [{ row: "probe.guarded", actions: [], canAnswer: null }],
      tray: [],
      list: { status: "unread", needsYou: false },
    });
  });
});

describe("a subagent's call that waits for a decision", () => {
  it("needs those who may decide it from the thread that started the subagent too", async () => {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Researcher", task: "Look into it" }]);
    await w.answers(w.threadId, "Started one.");
    const child = await eventually(
      () => w.subagentNamed("Researcher").catch(() => null),
      (found) => found !== null,
    );
    const { ids } = await w.asks(child!, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(w.ada, child!),
      (shown) => shown.run === "decision",
    );
    await w.settled();

    expect(await surfaces(w, w.ada)).toEqual({
      run: null,
      rows: [
        {
          subagent: "Researcher",
          needs: "decision",
          row: "probe.guarded",
          actions: ["allow", "deny"],
        },
      ],
      tray: [
        {
          kind: "subagent",
          status: "waiting",
          attention: "approval",
          canDecide: true,
          needs: "decision",
        },
      ],
      // The list's status takes the subagent's in; what it says of approving is of the thread's
      // own run alone.
      list: { status: "waiting", needsYou: false },
    });
    expect(await surfaces(w, w.alan)).toEqual({
      run: null,
      rows: [{ subagent: "Researcher", needs: "decision", row: "probe.guarded", actions: [] }],
      tray: [
        {
          kind: "subagent",
          status: "waiting",
          attention: null,
          canDecide: false,
          needs: "decision",
        },
      ],
      list: { status: "paused", needsYou: false },
    });

    // Decided from the subagent's own thread, where the call is.
    expect(await w.decide(w.grace, ids[0]!, true, "once", child!)).toBe(200);
    await w.answers(child!, "Looked.");
    await w.answers(w.threadId, "It is done.");
    await w.settled();
    expect((await surfaces(w, w.ada)).rows).toEqual([]);
  });
});

// N2
describe("a subagent's call that waits for answers", () => {
  it("shows from the thread that started the subagent as needing an answer", async () => {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Researcher", task: "Look into it" }]);
    await w.answers(w.threadId, "Started one.");
    const child = await eventually(
      () => w.subagentNamed("Researcher").catch(() => null),
      (found) => found !== null,
    );
    await w.asks(child!, [
      "thread.ask",
      {
        questions: [
          { question: "Which one?", header: "Pick", options: [{ label: "One" }, { label: "Two" }] },
        ],
      },
    ]);
    await eventually(
      () => w.shown(w.ada, child!),
      (shown) => shown.run === "answer",
    );
    await w.settled();
    expect(await surfaces(w, w.ada)).toEqual({
      run: null,
      rows: [{ subagent: "Researcher", needs: "answer", row: "thread.ask", actions: null }],
      tray: [
        {
          kind: "subagent",
          status: "waiting",
          attention: "approval",
          canDecide: true,
          needs: "answer",
        },
      ],
      list: { status: "waiting", needsYou: false },
    });
    expect(await surfaces(w, w.alan)).toEqual({
      run: null,
      rows: [{ subagent: "Researcher", needs: "answer", row: "thread.ask", actions: null }],
      tray: [
        {
          kind: "subagent",
          status: "waiting",
          attention: null,
          canDecide: false,
          needs: "answer",
        },
      ],
      list: { status: "paused", needsYou: false },
    });
  });
});

describe("a subagent's job that waits for a decision", () => {
  it("shows from the thread that started the subagent in its list status alone", async () => {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Researcher", task: "Look into it" }]);
    await w.answers(w.threadId, "Started one.");
    const child = await eventually(
      () => w.subagentNamed("Researcher").catch(() => null),
      (found) => found !== null,
    );
    await w.asks(child!, ["jobs.start", { tool: "probe.guarded", input: { label: "a" } }]);
    await w.answers(child!, "Asked for.");
    // The agent that started it is told it went idle.
    await w.answers(w.threadId, "Noted.");
    await w.settled();

    // Only the list's status takes it in; the rows and the tray show nothing of it.
    expect(await surfaces(w, w.ada)).toEqual({
      run: null,
      rows: [],
      tray: [],
      list: { status: "waiting", needsYou: false },
    });
    expect(await surfaces(w, w.alan)).toEqual({
      run: null,
      rows: [],
      tray: [],
      list: { status: "unread", needsYou: false },
    });
  });
});

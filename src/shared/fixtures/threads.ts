// Made-up thread logs that between them hold every event type and every shape an event's data
// takes. They are folded into the rows people see, and what comes out is kept beside them, so a
// change to how any shape reads shows as a diff.

import type { AnyThreadEvent } from "@/shared/threads/events.ts";

type Actor = AnyThreadEvent["actor"];

const AGENT: Actor = { kind: "agent" };
const ADA: Actor = { kind: "user", userId: "ada", name: "Ada Lovelace", former: false };
const GRACE: Actor = { kind: "user", userId: "grace", name: "Grace Hopper", former: false };
// Someone since removed from the org, and someone whose account is gone.
const FORMER: Actor = { kind: "user", userId: "alan", name: "Alan Turing", former: true };
const GONE: Actor = { kind: "user", userId: "gone", name: null, former: true };

const text = (value: string) => [{ type: "text", text: value }];
const USAGE = { inputTokens: 120, outputTokens: 30 };

const ADA_STEERED = { userId: "ada", name: "Ada Lovelace", via: [] };
const GRACE_STEERED = { userId: "grace", name: "Grace Hopper", via: ["Researcher"] };
const RESEARCHER = { threadId: "child-1", name: "Researcher", main: false };
const WRITER = { threadId: "child-2", name: "Writer", main: false };
const MAIN = { threadId: "thread", name: "Main thread", main: true };

// A log under way: each event takes the next seq and a second of its own.
function log(threadId = "thread") {
  const events: AnyThreadEvent[] = [];
  return {
    events,
    // Appends the event and answers its id, `e` and its seq unless one is given.
    add(type: string, data: unknown, actor: Actor = AGENT, id?: string) {
      const seq = events.length + 1;
      const event = {
        id: id ?? `e${seq}`,
        threadId,
        seq,
        type,
        data,
        actor,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      };
      events.push(event);
      return event.id;
    },
  };
}

type Log = ReturnType<typeof log>;

// A run that takes the messages in and answers them with one reply.
function answered(l: Log, runId: string, messageIds: string[], reply: string, by: Actor = ADA) {
  l.add("run.created", { runId, reason: null, continuesRunId: null }, by);
  l.add("message.admitted", { runId, messageIds });
  l.add("message.started", { messageId: `${runId}-m1`, runId, model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: `${runId}-m1`,
    runId,
    parts: text(reply),
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId });
}

// People's messages in every form, the changes their authors make while they wait, and replies
// that end in full, cut short and with their reasoning.
function conversation() {
  const l = log();
  // From before messages said how they are delivered.
  const hello = l.add("message", { parts: text("Hello"), quiet: false }, ADA);
  l.add("run.created", { runId: "r1", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r1", messageIds: [hello] });
  l.add("message.started", {
    messageId: "m1",
    runId: "r1",
    model: "anthropic/claude-test",
    effort: "high",
  });
  l.add("message.completed", {
    messageId: "m1",
    runId: "r1",
    parts: [
      { type: "reasoning", text: "They said hello.", durationMs: 1200 },
      { type: "text", text: "Hello, Ada." },
    ],
    status: "completed",
    usage: {
      ...USAGE,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      cost: { usd: 0.0021, source: "provider" },
    },
  });
  l.add("run.completed", { runId: "r1" });
  l.add("thread.renamed", { title: "Greetings", usage: { inputTokens: 20, outputTokens: 4 } });
  l.add("thread.renamed", { title: "Greetings, renamed by hand" }, ADA);
  l.add(
    "message",
    { parts: text("// an aside between people"), quiet: true, mode: "steer" },
    GRACE,
  );
  const guest = l.add(
    "message",
    { parts: text("May I ask something?"), quiet: false, mode: "queue", guest: true },
    GRACE,
  );
  l.add("message.changed", { messageId: guest, parts: text("May I ask something else?") }, GRACE);
  l.add("message.changed", { messageId: guest, mode: "interrupt" }, GRACE);
  const withdrawn = l.add(
    "message",
    { parts: text("Never mind"), quiet: false, mode: "steer" },
    ADA,
  );
  l.add("message.withdrawn", { messageId: withdrawn }, ADA);
  const dropped = l.add(
    "message",
    { parts: text("From someone who then left"), quiet: false, mode: "steer" },
    FORMER,
  );
  l.add("message.dropped", { messageId: dropped });
  l.add("run.created", { runId: "r2", reason: "queued_input", continuesRunId: "r1" }, GRACE);
  l.add("message.admitted", { runId: "r2", messageIds: [guest] });
  // From before replies named their model.
  l.add("message.started", { messageId: "m2", runId: "r2" });
  l.add("message.completed", {
    messageId: "m2",
    runId: "r2",
    parts: text("Of course, what"),
    status: "interrupted",
  });
  l.add("run.cancelled", { runId: "r2" }, ADA);
  const stop = l.add(
    "message",
    { parts: text("Stop, do this instead"), quiet: false, mode: "interrupt" },
    ADA,
  );
  l.add("run.created", { runId: "r3", reason: "interrupt", continuesRunId: "r2" }, ADA);
  l.add("message.admitted", { runId: "r3", messageIds: [stop] });
  l.add("message.started", {
    messageId: "m3",
    runId: "r3",
    model: "openai/gpt-test",
    effort: "low",
  });
  l.add("message.completed", {
    messageId: "m3",
    runId: "r3",
    parts: [{ type: "reasoning", text: "Thought only." }],
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId: "r3" });
  const unnamed = l.add("message", { parts: text("From an account now gone"), quiet: false }, GONE);
  answered(l, "r4", [unnamed], "Noted.", GONE);
  // The agent stopped by the system rather than a person.
  const again = l.add("message", { parts: text("Again"), quiet: false, mode: "steer" }, ADA);
  l.add("run.created", { runId: "r5", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r5", messageIds: [again] });
  l.add("run.cancelled", { runId: "r5" });
  return l.events;
}

// Runs that fail, in each way a failure is recorded, and the runs that try them again.
function failures() {
  const l = log();
  const first = l.add("message", { parts: text("Go"), quiet: false, mode: "steer" }, ADA);
  l.add("run.created", { runId: "r1", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r1", messageIds: [first] });
  l.add("message.started", { messageId: "m1", runId: "r1", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m1",
    runId: "r1",
    parts: text("Half a rep"),
    status: "failed",
  });
  l.add("run.failed", {
    runId: "r1",
    error: "The server stopped while the agent was replying.",
    kind: "interrupted",
  });
  l.add("run.created", { runId: "r2", reason: "retry", continuesRunId: "r1" });
  l.add("run.failed", {
    runId: "r2",
    error: "Rate limit reached",
    kind: "limit",
    connection: "codex",
    detail: "You have hit your usage limit.",
    resetsAt: "2026-01-01T05:00:00.000Z",
  });
  l.add("run.created", { runId: "r3", reason: "retry", continuesRunId: "r2" }, ADA);
  l.add("run.failed", { runId: "r3", error: "Sign in again", kind: "auth", connection: "claude" });
  for (const [index, kind] of [
    "model",
    "network",
    "no_model",
    "gone",
    "model_error",
    "gave_up",
  ].entries()) {
    const runId = `k${index}`;
    l.add("run.created", { runId, reason: "retry", continuesRunId: "r3" }, ADA);
    l.add("run.failed", { runId, error: kind === "model_error" ? "overloaded" : "", kind });
  }
  // A failure with no kind and nothing said.
  l.add("run.created", { runId: "r4", reason: "retry", continuesRunId: "r3" }, ADA);
  l.add("run.failed", { runId: "r4", error: "" });
  l.add("run.created", { runId: "r5", reason: "retry", continuesRunId: "r4" }, ADA);
  l.add("message.started", { messageId: "m5", runId: "r5", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m5",
    runId: "r5",
    parts: text("Done at last."),
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId: "r5" });
  return l.events;
}

// Tool calls through every state: run at once, approved once and for now, denied for each reason,
// answered and skipped, failed, large, run with a person's own login and on a standing approval,
// and jobs started in the background.
function tools() {
  const l = log();
  const go = l.add("message", { parts: text("Use your tools"), quiet: false, mode: "steer" }, ADA);
  l.add("run.created", { runId: "r1", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r1", messageIds: [go] });
  l.add("message.started", { messageId: "m1", runId: "r1", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m1",
    runId: "r1",
    parts: [],
    status: "completed",
    usage: USAGE,
  });
  const ask = (callId: string, extra: object = {}) =>
    l.add("tool.requested", {
      runId: "r1",
      callId,
      messageId: "m1",
      toolId: "web.fetch",
      input: { url: "https://example.com" },
      risk: "normal",
      waits: false,
      title: "Fetch",
      toolset: "Web",
      ...extra,
    });
  const ran = (callId: string, extra: object = {}) =>
    l.add("tool.ran", { runId: "r1", callId, ok: true, value: { status: 200 }, ms: 42, ...extra });

  ask("c-auto");
  ran("c-auto");
  // From before calls recorded what their tool was called.
  ask("c-unnamed", { title: undefined, toolset: undefined });
  l.add("tool.ran", { runId: "r1", callId: "c-unnamed", ok: false, error: "404", ms: 7 });
  // A failure that said nothing.
  ask("c-silent");
  l.add("tool.ran", { runId: "r1", callId: "c-silent", ok: false, ms: 0 });
  ask("c-once", { risk: "ask", waits: true });
  l.add("tool.approved", { runId: "r1", callId: "c-once", scope: "once" }, ADA);
  ran("c-once", { ranAs: "ada" });
  ask("c-standing", { risk: "ask", waits: true });
  l.add("tool.approved", { runId: "r1", callId: "c-standing", scope: "for_now" }, GRACE);
  ran("c-standing");
  ask("c-stood", { risk: "ask" });
  ran("c-stood", { standingOn: "c-standing" });
  // Approved by the system, as a call whose policy let it through.
  ask("c-agent", { risk: "ask", waits: true });
  l.add("tool.approved", { runId: "r1", callId: "c-agent", scope: "once" });
  ran("c-agent", { value: undefined });
  for (const reason of ["denied", "stale", "stopped", "skipped"]) {
    ask(`c-${reason}`, { risk: "ask", waits: true });
    l.add(
      "tool.denied",
      { runId: "r1", callId: `c-${reason}`, reason },
      reason === "denied" || reason === "skipped" ? ADA : AGENT,
    );
  }
  // Approved, then no longer allowed when it came to run.
  ask("c-lapsed", { risk: "ask", waits: true });
  l.add("tool.approved", { runId: "r1", callId: "c-lapsed", scope: "once" }, ADA);
  l.add("tool.denied", { runId: "r1", callId: "c-lapsed", reason: "stale" });
  ask("c-ask", {
    toolId: "ask.questions",
    title: "Ask",
    toolset: "Questions",
    input: { questions: [{ question: "Which one?", options: ["One", "Two"] }] },
    waits: true,
  });
  l.add("tool.answered", { runId: "r1", callId: "c-ask", answers: { "Which one?": "Two" } }, GRACE);
  // A second answer loses.
  l.add("tool.answered", { runId: "r1", callId: "c-ask", answers: { "Which one?": "One" } }, ADA);
  ran("c-ask", { value: { answers: { "Which one?": "Two" } } });
  ask("c-large");
  ran("c-large", { value: undefined, large: { size: 48_000 } });
  // A call still to be reviewed by someone outside the thread.
  ask("c-review", { risk: "review", waits: true });
  l.add("tool.denied", { runId: "r1", callId: "c-review", reason: "stopped" });
  // A decision on a call that is not there is left alone.
  l.add("tool.approved", { runId: "r1", callId: "c-missing", scope: "once" }, ADA);
  l.add("tool.ran", { runId: "r1", callId: "c-missing", ok: true, value: 1, ms: 1 });
  l.add("run.completed", { runId: "r1" });

  // Jobs: calls started in the background, which go under their own id as their run.
  const job = (callId: string, extra: object = {}) =>
    l.add("tool.requested", {
      runId: callId,
      callId,
      messageId: callId,
      toolId: "web.fetch",
      input: { url: "https://example.com/slow" },
      risk: "normal",
      waits: false,
      title: "Fetch",
      toolset: "Web",
      background: true,
      ...extra,
    });
  job("j-ran");
  l.add("tool.ran", { runId: "j-ran", callId: "j-ran", ok: true, value: "page", ms: 9000 });
  job("j-failed");
  l.add("tool.ran", {
    runId: "j-failed",
    callId: "j-failed",
    ok: false,
    error: "timed out",
    ms: 5,
  });
  job("j-cancelled");
  l.add("tool.denied", { runId: "j-cancelled", callId: "j-cancelled", reason: "stopped" });
  job("j-approved", { risk: "ask", waits: true });
  l.add("tool.approved", { runId: "j-approved", callId: "j-approved", scope: "once" }, ADA);
  l.add("tool.ran", {
    runId: "j-approved",
    callId: "j-approved",
    ok: true,
    value: "page",
    ms: 30,
    ranAs: "ada",
  });
  job("j-denied", { risk: "ask", waits: true });
  l.add("tool.denied", { runId: "j-denied", callId: "j-denied", reason: "denied" }, GRACE);
  // A call moved to the background while it ran: its own row answers the run at once, and the
  // job carries on under a row of its own.
  l.add("run.created", { runId: "r2", reason: "queued_input", continuesRunId: "r1" }, ADA);
  l.add("message.started", { messageId: "m2", runId: "r2", model: "anthropic/claude-test" });
  l.add("message.completed", { messageId: "m2", runId: "r2", parts: [], status: "completed" });
  l.add("tool.requested", {
    runId: "r2",
    callId: "c-moved",
    messageId: "m2",
    toolId: "web.fetch",
    input: { url: "https://example.com/slow" },
    risk: "normal",
    waits: false,
    title: "Fetch",
    toolset: "Web",
  });
  job("j-moved");
  l.add("tool.ran", {
    runId: "r2",
    callId: "c-moved",
    ok: true,
    value: { movedToBackground: true, callId: "j-moved" },
    ms: 2000,
  });
  l.add("run.completed", { runId: "r2" });
  l.add("tool.ran", { runId: "j-moved", callId: "j-moved", ok: true, value: "page", ms: 60_000 });
  return l.events;
}

// Everything the agent is told that is not a person's message, as it is written now: each kind,
// each kind of sender, taken in at once, waiting, and shown quietly before it is read.
function notices() {
  const l = log();
  const note = (kind: string, extra: object = {}, source: object = RESEARCHER) =>
    l.add("notification", { kind, source, text: `${kind} happened`, people: [], ...extra });
  const taken: string[] = [];
  taken.push(
    note("message", {
      text: "Here is what I found.",
      people: [ADA_STEERED, GRACE_STEERED],
      to: "Main thread",
      actor: { kind: "agent", ...RESEARCHER },
      source: { ...RESEARCHER, callId: "send-1" },
    }),
    // The first message in a subagent's thread is its task.
    note(
      "message",
      {
        text: "Research the topic.",
        people: [ADA_STEERED],
        to: "Researcher",
        task: { instructions: "Be brief.", fork: { callId: "start-1", seq: 12 } },
        actor: { kind: "agent", ...MAIN },
      },
      { ...MAIN, callId: "start-1" },
    ),
    note("agent.ended", {
      text: "Researcher ended its run.",
      subagents: [{ threadId: "child-1", name: "Researcher" }],
      last: "All sources read.",
      actor: { kind: "agent", ...RESEARCHER },
    }),
    note("agent.failed", {
      text: "Researcher failed.",
      subagents: [{ threadId: "child-1", name: "Researcher" }],
      error: "The model failed: overloaded",
      last: "Reading the third source.",
    }),
    note(
      "agent.stopped",
      {
        text: "Writer was stopped.",
        subagents: [{ threadId: "child-2", name: "Writer" }],
        people: [GRACE_STEERED],
      },
      WRITER,
    ),
    note(
      "agent.idle",
      {
        text: "All idle: Researcher, Writer",
        subagents: [
          { threadId: "child-1", name: "Researcher" },
          { threadId: "child-2", name: "Writer" },
        ],
        when: "all_idle",
      },
      { ...MAIN, callId: "watch-1", callIds: ["watch-2", "watch-3"] },
    ),
    note(
      "agent.idle",
      {
        text: "Idle: Writer",
        subagents: [{ threadId: "child-2", name: "Writer" }],
        when: "any_idle",
      },
      { ...MAIN, callId: "watch-4" },
    ),
    note(
      "call.ended",
      {
        text: "The call finished.",
        people: [ADA_STEERED],
        actor: { kind: "source", label: "Fetch", type: "job" },
      },
      { ...MAIN, callId: "j-1" },
    ),
    note(
      "task.changed",
      {
        text: 'Ada Lovelace marked "Draft" done.',
        people: [ADA_STEERED],
        actor: { kind: "person", userId: "ada", name: "Ada Lovelace" },
        change: {
          subject: { kind: "task", name: "Draft" },
          action: "status",
          from: "doing",
          to: "done",
        },
        tray: "tasks",
      },
      { ...MAIN, rowId: "task-1" },
    ),
    note(
      "trigger.fired",
      {
        text: "Daily digest: write today's digest.",
        people: [ADA_STEERED],
        trigger: "trigger-1",
        schedule: "Every day at 09:00",
        actor: { kind: "source", label: "Daily digest", type: "schedule" },
      },
      { ...MAIN, name: "Daily digest", callId: "schedule-1" },
    ),
    note(
      "trigger.fired",
      {
        text: "Wake-up: check the build.",
        trigger: "trigger-2",
        actor: { kind: "source", label: "Wake-up", type: "wakeup" },
      },
      { ...MAIN, name: "Wake-up", callId: "wake-1" },
    ),
    note(
      "webhook.received",
      {
        text: 'Deploys was posted to.\n\nContent-Type: application/json\n\n{"ok":true}',
        trigger: "trigger-3",
        delivery: { contentType: "application/json", bytes: 11, signed: true },
        actor: { kind: "source", label: "Deploys", type: "webhook" },
      },
      { ...MAIN, name: "Deploys", callId: "hook-1" },
    ),
    note(
      "webhook.received",
      {
        text: "Deploys was posted to.",
        trigger: "trigger-3",
        delivery: { contentType: null, bytes: 0, signed: false },
      },
      { ...MAIN, name: "Deploys" },
    ),
  );
  l.add("run.created", { runId: "r1", reason: null, continuesRunId: null });
  l.add("message.admitted", { runId: "r1", messageIds: taken });
  l.add("message.started", { messageId: "m1", runId: "r1", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m1",
    runId: "r1",
    parts: text("All noted."),
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId: "r1" });

  // Quiet changes show when they are made and are read with the agent's next input.
  const quiet = [
    note(
      "change",
      {
        text: "Ada Lovelace paused Daily digest.",
        wake: false,
        people: [ADA_STEERED],
        actor: { kind: "person", userId: "ada", name: "Ada Lovelace" },
        change: { subject: { kind: "schedule", name: "Daily digest" }, action: "pause" },
        tray: "triggers",
      },
      MAIN,
    ),
    note(
      "change",
      {
        text: "Grace Hopper turned signatures on for Deploys.",
        wake: false,
        actor: { kind: "person", userId: "grace", name: "Grace Hopper" },
        change: { subject: { kind: "webhook", name: "Deploys" }, action: "signature", to: "on" },
        tray: "webhooks",
      },
      MAIN,
    ),
    note(
      "change",
      {
        text: "Ada Lovelace changed the model.",
        wake: false,
        actor: { kind: "person", userId: "ada", name: "Ada Lovelace" },
        change: {
          subject: { kind: "thread", name: "Greetings" },
          action: "model",
          from: "anthropic/claude-test",
          to: "openai/gpt-test",
        },
      },
      MAIN,
    ),
    note(
      "change",
      {
        text: "The thread was renamed.",
        wake: false,
        actor: { kind: "source", label: "Mage", type: "system" },
        change: {
          subject: { kind: "thread", name: "Greetings" },
          action: "rename",
          from: "Hi",
          to: "Greetings",
        },
      },
      MAIN,
    ),
  ];
  const next = l.add("message", { parts: text("Anything new?"), quiet: false, mode: "steer" }, ADA);
  l.add("run.created", { runId: "r2", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r2", messageIds: [...quiet.slice(0, 3), next] });
  l.add("message.started", { messageId: "m2", runId: "r2", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m2",
    runId: "r2",
    parts: text("A few changes."),
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId: "r2" });
  // The thread's subagents sent each other as many messages as they may.
  l.add("subagent.limited", { limit: 20, call: { threadId: "child-1", callId: "send-9" } });
  l.add("subagent.limited", { limit: 20 });
  // Still waiting for the agent: one that will start it and one that will not.
  note("call.ended", { text: "Another call finished." }, { ...MAIN, callId: "j-2" });
  note("change", { text: "A task was archived.", wake: false, tray: "tasks" }, MAIN);
  return l.events;
}

// A thread's branches, forks and compactions.
function history() {
  const l = log();
  l.add("thread.forked", { threadId: "origin", rowId: "row-9", title: "Where it came from" }, ADA);
  const first = l.add("message", { parts: text("First"), quiet: false, mode: "steer" }, ADA);
  answered(l, "r1", [first], "First answer.");
  const second = l.add("message", { parts: text("Second"), quiet: false, mode: "steer" }, ADA);
  answered(l, "r2", [second], "Second answer.");
  // A reply written again: the branch starts at the row, with a run of its own.
  l.add("branch.started", { kind: "retry", rowId: "r2-m1" }, GRACE);
  l.add("run.created", { runId: "r3", reason: "rewrite", continuesRunId: "r2" }, GRACE);
  l.add("message.started", { messageId: "m3", runId: "r3", model: "openai/gpt-test" });
  // A message waits and a call is open as the next branch starts; only what it keeps still waits.
  const kept = l.add("message", { parts: text("Keep me"), quiet: false, mode: "queue" }, ADA);
  l.add("message", { parts: text("Leave me behind"), quiet: false, mode: "queue" }, GRACE);
  l.add("tool.requested", {
    runId: "r3",
    callId: "c-open",
    messageId: "m3",
    toolId: "web.fetch",
    input: {},
    risk: "ask",
    waits: true,
  });
  l.add("tool.requested", {
    runId: "r3",
    callId: "c-allowed",
    messageId: "m3",
    toolId: "web.fetch",
    input: {},
    risk: "ask",
    waits: true,
  });
  l.add("tool.approved", { runId: "r3", callId: "c-allowed", scope: "once" }, ADA);
  l.add("branch.started", { kind: "edit", rowId: second, keep: [kept] }, ADA);
  l.add("run.created", { runId: "r4", reason: "rewrite", continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r4", messageIds: [kept] });
  l.add("message.started", { messageId: "m4", runId: "r4", model: "anthropic/claude-test" });
  l.add("message.completed", {
    messageId: "m4",
    runId: "r4",
    parts: text("Kept and answered."),
    status: "completed",
    usage: USAGE,
  });
  l.add("run.completed", { runId: "r4" });
  // Compacted by the agent on its own, then by a person who asked with a focus.
  l.add("thread.compacted", {
    summary: "They greeted each other.",
    firstKeptSeq: 8,
    tokensBefore: 90_000,
  });
  const compact = l.add(
    "message",
    {
      parts: text("/compact keep the plan"),
      quiet: false,
      mode: "steer",
      command: { name: "compact", args: "keep the plan", text: "Compact the thread." },
    },
    ADA,
  );
  l.add("run.created", { runId: "r5", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r5", messageIds: [compact] });
  l.add("run.failed", { runId: "r5", error: "", kind: "network" });
  l.add("run.created", { runId: "r6", reason: "retry", continuesRunId: "r5" }, ADA);
  l.add(
    "thread.compacted",
    {
      summary: "The plan, kept.",
      firstKeptSeq: 20,
      focus: "keep the plan",
      tokensBefore: 120_000,
      tokensAfter: 4000,
      usage: { inputTokens: 5000, outputTokens: 400 },
    },
    ADA,
  );
  l.add("run.completed", { runId: "r6" });
  return l;
}

// The same thread restored from an early row, where its branch then ends, and a thread started
// from a summary of another.
function restored() {
  const l = history();
  l.add("branch.started", { kind: "restore", rowId: "r1-m1" }, ADA);
  l.add("thread.forked", { threadId: "other", title: "Summarised elsewhere", summary: true });
  return l.events;
}

// A thread stopped mid-run: a reply being written, a call waiting on a person, and input waiting
// for the agent.
function open() {
  const l = log();
  const go = l.add("message", { parts: text("Start"), quiet: false, mode: "steer" }, ADA);
  l.add("run.created", { runId: "r1", reason: null, continuesRunId: null }, ADA);
  l.add("message.admitted", { runId: "r1", messageIds: [go] });
  l.add("message.started", { messageId: "m1", runId: "r1", model: "anthropic/claude-test" });
  l.add("message.completed", { messageId: "m1", runId: "r1", parts: [], status: "completed" });
  l.add("tool.requested", {
    runId: "r1",
    callId: "c-ready",
    messageId: "m1",
    toolId: "web.fetch",
    input: {},
    risk: "normal",
    waits: false,
    title: "Fetch",
    toolset: "Web",
  });
  l.add("tool.requested", {
    runId: "r1",
    callId: "c-waiting",
    messageId: "m1",
    toolId: "files.delete",
    input: { path: "/tmp/x" },
    risk: "ask",
    waits: true,
    title: "Delete",
    toolset: "Files",
  });
  l.add("tool.requested", {
    runId: "j-waiting",
    callId: "j-waiting",
    messageId: "j-waiting",
    toolId: "files.delete",
    input: { path: "/tmp/y" },
    risk: "ask",
    waits: true,
    background: true,
  });
  l.add("message.started", { messageId: "m2", runId: "r1", model: "anthropic/claude-test" });
  l.add("message", { parts: text("Steer it"), quiet: false, mode: "steer" }, ADA);
  l.add("message", { parts: text("Queue it"), quiet: false, mode: "queue" }, GRACE);
  l.add(
    "message",
    { parts: text("Interrupt it"), quiet: false, mode: "interrupt", guest: true },
    GRACE,
  );
  l.add("notification", {
    kind: "call.ended",
    source: { ...MAIN, callId: "j-1" },
    text: "A call finished.",
    people: [],
  });
  l.add("notification", {
    kind: "change",
    source: MAIN,
    text: "A task was added.",
    people: [],
    wake: false,
  });
  return l.events;
}

// Events this code does not know, or cannot read, show as a row that says so.
function unknown() {
  const l = log();
  l.add("message", { parts: text("Before"), quiet: true, mode: "steer" }, ADA);
  l.add("something.new", { any: "thing" });
  l.add("tool.ran", { callId: 7 });
  // A person's message from the agent is not shown.
  l.add("message", { parts: text("Not a person"), quiet: false, mode: "steer" });
  return l.events;
}

export const threadFixtures: Record<string, AnyThreadEvent[]> = {
  conversation: conversation(),
  failures: failures(),
  tools: tools(),
  notices: notices(),
  history: history().events,
  restored: restored(),
  open: open(),
  unknown: unknown(),
};

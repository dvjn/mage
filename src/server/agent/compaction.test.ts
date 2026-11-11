import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { EDITORS } from "@/shared/tools.ts";
import {
  type AgentRow,
  type HumanRow,
  type ToolRow,
  type TranscriptRow,
  transcriptOf,
} from "@/shared/transcript.ts";

import { ModelError } from "@/server/models/gateway.ts";

import {
  conversationText,
  cutOf,
  fits,
  FITS_SHARE,
  RESULT_CHARS,
  summaryAsk,
  summaryRequest,
} from "./compaction.ts";
import { summaryMessage } from "./context.ts";

const ada = { kind: "user", userId: "ada", name: "Ada", former: false } as const;

function human(seq: number, text = "Hello", extra: Partial<HumanRow> = {}): HumanRow {
  return {
    kind: "human",
    id: `h${seq}`,
    seq,
    author: ada,
    postedAt: "",
    text,
    quiet: false,
    ...extra,
  };
}

function reply(
  seq: number,
  runId: string,
  text = "Done.",
  extra: Partial<AgentRow> = {},
): AgentRow {
  return {
    kind: "agent",
    id: `a${seq}`,
    seq,
    runId,
    model: null,
    startedAt: "",
    text,
    reasoning: "",
    thoughtMs: null,
    status: "completed",
    usage: null,
    retried: false,
    ...extra,
  };
}

function call(seq: number, runId: string, extra: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id: `t${seq}`,
    seq,
    runId,
    messageId: `a${seq - 1}`,
    toolId: "thread.rename",
    input: { title: "Engines" },
    risk: "normal",
    waits: false,
    requestedAt: "",
    state: "ran",
    decision: null,
    output: { ok: true, value: { title: "Engines" } },
    ms: 1,
    ...extra,
  };
}

const compactRequest = { command: { name: "compact", args: "" } };

describe("where a thread is cut", () => {
  it("is nowhere while there is one exchange, the request to compact aside", () => {
    expect(cutOf([])).toBeNull();
    expect(cutOf([human(1), reply(2, "r1")])).toBeNull();
    expect(
      cutOf([human(1, "/compact", compactRequest), human(3, "/compact", compactRequest)]),
    ).toBe(null);
  });

  it("is at the earliest person's message that keeps no more than it may, else the latest", () => {
    const rows = [human(1), reply(2, "r1"), human(4), reply(5, "r2"), human(7), reply(8, "r3")];
    expect(cutOf(rows)).toBe(2);
    expect(cutOf(rows, 0)).toBe(4);
  });

  it("is never inside a run, after an unsettled call, or between messages taken in together", () => {
    // Grace's message steered the first run between its replies.
    const steered = [human(1), reply(2, "r1"), human(3), reply(4, "r1"), human(6), reply(7, "r2")];
    expect(cutOf(steered)).toBe(4);
    const open = [human(1), reply(2, "r1"), call(3, "r1", { state: "pending", output: null })];
    expect(cutOf([...open, human(5), reply(6, "r2")])).toBeNull();
    const together = [human(1), reply(2, "r1"), human(4), human(4), reply(5, "r2")];
    expect(cutOf(together)).toBe(2);
    expect(cutOf(together, 0)).toBe(2);
  });

  it("is after the latest compaction's cut, with some conversation since", () => {
    const compacted: TranscriptRow = {
      kind: "compaction",
      id: "c",
      seq: 6,
      by: ada,
      summary: "Earlier.",
      firstKeptSeq: 4,
      tokensBefore: 10,
      tokensAfter: 5,
    };
    const rows = [human(1), reply(2, "r1"), human(4), reply(5, "r2"), compacted];
    expect(cutOf(rows)).toBeNull();
    expect(cutOf([...rows, human(8), reply(9, "r3")])).toBe(5);
  });
});

describe("what a summary is written from", () => {
  it("is the conversation as labelled lines, reasoning left out and results cut short", () => {
    const long = "x".repeat(RESULT_CHARS + 10);
    const rows = [
      human(1, "/pirate Grace", { command: { name: "pirate", args: "Grace", text: "Say arr." } }),
      reply(2, "r1", "Arr.", { reasoning: "Thinking hard" }),
      call(3, "r1", { output: { ok: true, value: long } }),
      call(4, "r1", { state: "denied", output: null }),
      human(5, "/compact", compactRequest),
    ];
    expect(conversationText(rows)).toBe(
      [
        "[Ada]: Say arr.",
        "[Agent]: Arr.",
        `[Agent called tool]: thread.rename {"title":"Engines"}`,
        `[Tool result]: ${"x".repeat(RESULT_CHARS)} (cut short)`,
        `[Agent called tool]: thread.rename {"title":"Engines"}`,
        "[Tool result]: Not run.",
      ].join("\n"),
    );
    expect(summaryRequest("Before.", [human(1, "Hi")], "the plan")).toBe(
      "The summary so far:\nBefore.\n\nThe conversation since:\n[Ada]: Hi\n\nKeep in particular: the plan",
    );
  });
});

describe("compacting a thread", () => {
  function compactCommand(
    api: (method: string, path: string, cookie: string, body?: object) => Promise<Response>,
    threadId: string,
    who: { cookie: string },
    focus = "",
  ) {
    return api("POST", `/threads/${threadId}/messages`, who.cookie, {
      text: focus ? `/compact ${focus}` : "/compact",
      command: { name: "compact", args: focus },
    });
  }

  it("is refused while there is nothing to summarise", async () => {
    const { ada, api, thread, types } = await agentThread();
    const res = await compactCommand(api, thread.id, ada);
    expect(res.status).toBe(409);
    expect(types()).toEqual([]);
  });

  it("by command leaves the agent the summary and the rest, and folds a later one in", async () => {
    const { ada, api, thread, post, model, worker, start, transcript, events } =
      await agentThread();
    start();
    await post(ada, "One");
    (await model.next()).reply("First.");
    await post(ada, "Two");
    const second = await model.next();
    second.reply("Second.");
    await worker.idle();

    expect((await compactCommand(api, thread.id, ada, "the numbers")).status).toBe(202);
    // Asked as the thread's next request would be, so that it starts as the last one did, with the
    // ask at the end naming where the kept part starts.
    const summarising = await model.next();
    const { instructions, sessionId, tools, searchable, search } = second.request;
    expect(sessionId).toBe(thread.id);
    expect(summarising.request).toMatchObject({
      instructions,
      sessionId,
      tools,
      searchable,
      search,
      maxSteps: 1,
      answerOnly: true,
    });
    expect(summarising.texts).toEqual([
      ...second.texts,
      "assistant: Second.",
      `user: ${summaryAsk({ previous: false, kept: { author: { kind: "user", userId: ada.userId, name: "Ada Lovelace", former: false }, text: "Two" }, focus: "the numbers" })}`,
    ]);
    summarising.reply("Ada counted to one.");
    await worker.idle();
    expect(transcript().slice(-2)).toEqual(["Ada Lovelace: /compact the numbers", "compaction"]);
    const compaction = transcriptOf(events()).rows.at(-1);
    expect(compaction).toMatchObject({
      kind: "compaction",
      by: { name: "Ada Lovelace" },
      summary: "Ada counted to one.",
      focus: "the numbers",
    });

    await post(ada, "Three");
    const after = await model.next();
    expect(after.request.instructions).not.toContain("Ada counted to one.");
    expect(after.texts).toEqual([
      `user: ${summaryMessage("Ada counted to one.").text}`,
      "user: [Ada Lovelace] Two",
      "assistant: Second.",
      "user: [Ada Lovelace] Three",
    ]);
    after.reply("Third.");
    await worker.idle();

    expect((await compactCommand(api, thread.id, ada)).status).toBe(202);
    const again = await model.next();
    expect(again.texts).toEqual([
      ...after.texts,
      "assistant: Third.",
      `user: ${summaryAsk({ previous: true, kept: { author: { kind: "user", userId: ada.userId, name: "Ada Lovelace", former: false }, text: "Three" } })}`,
    ]);
    again.reply("Ada counted to two.");
    await worker.idle();

    await post(ada, "Four");
    const last = await model.next();
    expect(last.texts).toEqual([
      `user: ${summaryMessage("Ada counted to two.").text}`,
      "user: [Ada Lovelace] Three",
      "assistant: Third.",
      "user: [Ada Lovelace] Four",
    ]);
    last.reply("Fourth.");
    await worker.idle();
  });

  it("by command waits for the run under way, and shows as compacting while it writes", async () => {
    const { ada, api, thread, post, model, worker, start, pending } = await agentThread();
    start();
    await post(ada, "One");
    const first = await model.next();
    expect((await compactCommand(api, thread.id, ada)).status).toBe(202);
    expect(pending()).toEqual(["Ada Lovelace (queue): /compact"]);
    first.reply("First.");
    const summarising = await model.next();
    const shown = (await (await api("GET", `/threads/${thread.id}`, ada.cookie)).json()) as {
      run: unknown;
    };
    expect(shown.run).toMatchObject({ compacting: true });
    expect(summarising.texts).toEqual([
      "user: [Ada Lovelace] One",
      "assistant: First.",
      `user: ${summaryAsk({ previous: false, kept: null })}`,
    ]);
    summarising.reply("Ada said one.");
    await worker.idle();
    expect(pending()).toEqual([]);
  });

  it("by the agent's tool, after which the run goes on from the summary", async () => {
    const { ada, post, model, worker, start, transcript } = await agentThread();
    start();
    await post(ada, "One");
    (await model.next()).reply("First.");
    await post(ada, "Two");
    const asking = await model.next();
    asking.startStep();
    asking.delta("Compacting.");
    asking.toolCall("call-1", "thread.compact", { focus: "numbers" });
    asking.endStep();
    asking.end();
    const summarising = await model.next();
    expect(summarising.request.instructions).toBe(asking.request.instructions);
    expect(summarising.texts).toEqual([
      ...asking.texts,
      "assistant: Compacting.",
      `user: ${summaryAsk({ previous: false, kept: { author: { kind: "user", userId: ada.userId, name: "Ada Lovelace", former: false }, text: "Two" }, focus: "numbers" })}`,
    ]);
    summarising.reply("Ada said one.");
    const after = await model.next();
    expect(after.texts).toEqual([
      `user: ${summaryMessage("Ada said one.").text}`,
      "user: [Ada Lovelace] Two",
      "assistant: Compacting.",
      'tool thread.compact: {"focus":"numbers"}',
      expect.stringMatching(/^result thread\.compact: \{"ok":true,"value":\{"summarised":2,/),
    ]);
    after.reply("Done.");
    await worker.idle();
    expect(transcript()).toEqual([
      "Ada Lovelace: One",
      "Agent (completed): First.",
      "Ada Lovelace: Two",
      "Agent (completed): Compacting.",
      "thread.compact (ran)",
      "compaction",
      "Agent (completed): Done.",
    ]);
  });

  it("falls back to a prompt of its own when the model calls a tool or the request is refused", async () => {
    const { ada, api, thread, post, model, worker, start } = await agentThread();
    start();
    await post(ada, "One");
    (await model.next()).reply("First.");
    await worker.idle();

    expect((await compactCommand(api, thread.id, ada)).status).toBe(202);
    const calling = await model.next();
    calling.startStep();
    calling.toolCall("call-1", "thread.rename", { title: "Engines" });
    calling.endStep();
    calling.end();
    const own = await model.next();
    expect(own.request.sessionId).toBe(`${thread.id}:compact`);
    expect(own.request.tools).toBeUndefined();
    expect(own.texts).toEqual(["user: The conversation:\n[Ada Lovelace]: One\n[Agent]: First."]);
    own.reply("Ada said one.");
    await worker.idle();

    await post(ada, "Two");
    (await model.next()).reply("Second.");
    await worker.idle();
    expect((await compactCommand(api, thread.id, ada)).status).toBe(202);
    (await model.next()).fail(new ModelError("model", "400 prompt is too long"));
    const fallback = await model.next();
    expect(fallback.texts[0]).toMatch(/^user: The summary so far:\nAda said one\./);
    fallback.reply("Ada said two.");
    await worker.idle();
  });

  it("asks with the thread's own request only while it fits the model's context window", () => {
    const request = { instructions: "", messages: [], maxSteps: 1, sessionId: "t" };
    const big = { ...request, messages: [{ role: "user" as const, text: "x".repeat(4_000) }] };
    expect(fits(big)).toBe(true);
    expect(fits(big, 1_000)).toBe(false);
    expect(fits(big, Math.ceil(1_100 / FITS_SHARE))).toBe(true);
  });

  it("by the agent's tool says when there is nothing to summarise", async () => {
    const { ada, post, model, worker, start } = await agentThread();
    start();
    await post(ada, "One");
    const asking = await model.next();
    asking.startStep();
    asking.toolCall("call-1", "thread.compact", {});
    asking.endStep();
    asking.end();
    const after = await model.next();
    expect(after.texts.at(-1)).toBe(
      'result thread.compact: {"ok":false,"error":"There is nothing to compact yet."}',
    );
    after.reply("Nothing yet.");
    await worker.idle();
  });

  it("still counts the words it summarised for whose approval a call needs", async () => {
    const {
      ada,
      grace,
      api,
      thread,
      post,
      model,
      worker,
      start,
      toolPolicyStore,
      toolSettings,
      transcript,
    } = await agentThread();
    // Only Ada may rename threads directly; anyone who can edit approves the rest.
    const policy = toolPolicyStore.create({
      orgId: ada.orgId,
      spaceId: null,
      name: "Ada only",
      color: "orange",
      use: "some",
      users: [`user:${ada.userId}`],
      approvers: [EDITORS],
      independent: false,
    });
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], policy.id);
    start();
    await post(grace, "Call it Engines");
    (await model.next()).reply("Sure.");
    await post(ada, "Hello");
    (await model.next()).reply("Hi.");
    await worker.idle();
    expect((await compactCommand(api, thread.id, ada)).status).toBe(202);
    (await model.next()).reply("Grace wants it called Engines.");
    await worker.idle();

    await post(ada, "Rename it");
    const asking = await model.next();
    // Grace's words reach the agent only through the summary now.
    expect(asking.texts.join("\n")).not.toContain("Call it Engines");
    asking.startStep();
    asking.toolCall("call-1", "thread.rename", { title: "Engines" });
    asking.endStep();
    asking.end();
    await worker.idle();
    // The call waits for approval, as it would had nothing been compacted.
    expect(transcript().at(-1)).toBe("thread.rename (pending)");
  });
});

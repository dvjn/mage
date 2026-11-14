import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { wholeWhereRead } from "@/server/execution/compaction.ts";
import type { ToolSpec } from "@/server/agent/tools.ts";
import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import { LARGE_RESULT_CHARS } from "@/shared/threads/events.ts";
import type { ToolRow } from "@/shared/threads/rows.ts";
import { type TranscriptRow, transcriptOf } from "@/shared/transcript.ts";

import { createTranscripts } from "./transcripts.ts";

// A tool that gives back a text of as many characters as it is asked for.
const dump: ToolSpec<{ chars: number }> = {
  name: "probe.dump",
  title: "Dump",
  description: "Gives back a long text.",
  input: z.object({ chars: z.number() }),
  risk: () => "normal",
  run: ({ chars }) => Promise.resolve({ ok: true, value: { text: "é".repeat(chars) } }),
};

const toolset = { id: "probe", title: "Probe", source: "builtin" as const, tools: [dump] };

const BIG = LARGE_RESULT_CHARS * 2;

// A thread whose agent called the tool once for a small result and once for a large one.
async function dumped() {
  const workspace = await agentThread({}, { toolsets: [toolset] });
  const { ada, model, worker, post, start } = workspace;
  await start();
  await post(ada, "Dump it");
  const call = await model.next();
  call.startStep();
  call.toolCall("small", "probe.dump", { chars: 3 });
  call.toolCall("big", "probe.dump", { chars: BIG });
  call.endStep();
  call.end();
  const next = await model.next();
  next.reply("Dumped.");
  await worker.idle();
  const ran = (await workspace.events()).filter((event) => event.type === "tool.ran");
  const detail = async (who = ada, thread = workspace.thread.id) =>
    (await (await workspace.api("GET", `/threads/${thread}`, who.cookie)).json()) as ThreadDetail;
  const tools = (shown: ThreadDetail) =>
    shown.rows.filter((row): row is ToolRow => row.kind === "tool");
  return { ...workspace, next, ran, detail, tools };
}

describe("a large tool result", () => {
  it("is kept apart from the log, which says its size, while a small one stays in it", async () => {
    const { ran, db } = await dumped();

    expect(ran.map((event) => event.data)).toEqual([
      expect.objectContaining({ callId: "small", ok: true, value: { text: "ééé" } }),
      expect.objectContaining({ callId: "big", ok: true, large: { size: BIG + 11 } }),
    ]);
    expect(ran[1]!.data).not.toHaveProperty("value");
    expect(await db.select().from(schema.toolResult)).toEqual([
      { eventId: ran[1]!.id, value: { text: "é".repeat(BIG) } },
    ]);
  });

  it("is read whole by the model", async () => {
    const { next } = await dumped();

    expect(next.texts.slice(-2)).toEqual([
      'result probe.dump: {"ok":true,"value":{"text":"ééé"}}',
      `result probe.dump: {"ok":true,"value":{"text":"${"é".repeat(BIG)}"}}`,
    ]);
  });

  it("is left out of the row, and given to whoever may read the thread when asked for", async () => {
    const { api, ada, alan, signUp, ran, detail, tools } = await dumped();

    const [small, big] = tools(await detail());
    expect(small!.output).toEqual({ ok: true, value: { text: "ééé" } });
    expect(big!.output).toEqual({
      ok: true,
      value: null,
      large: { id: ran[1]!.id, size: BIG + 11 },
    });

    for (const reader of [ada, alan]) {
      const res = await api("GET", `/tool-results/${ran[1]!.id}`, reader.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: { text: "é".repeat(BIG) } });
    }
    const bob = await signUp("Bob Boole", "bob@example.com");
    expect((await api("GET", `/tool-results/${ran[1]!.id}`, bob.cookie)).status).toBe(404);
    // A small result has nothing kept apart.
    expect((await api("GET", `/tool-results/${ran[0]!.id}`, ada.cookie)).status).toBe(404);
    expect((await api("GET", `/tool-results/${ran[1]!.id}`, "")).status).toBe(401);
  });

  it("is read back into rows by a transcript cache that never folded it", async () => {
    const { threadStore, thread } = await dumped();
    const transcripts = createTranscripts(threadStore);
    const { rows } = (await transcripts.of(thread.id)).transcript();

    const outputs = (list: readonly TranscriptRow[]) =>
      list.flatMap((row) => (row.kind === "tool" ? [row.output] : []));
    expect(outputs(rows)[1]).toMatchObject({ value: null, large: { size: BIG + 11 } });
    expect(outputs(await transcripts.whole(rows))).toEqual([
      { ok: true, value: { text: "ééé" } },
      { ok: true, value: { text: "é".repeat(BIG) } },
    ]);
    // Rows with nothing kept apart are given back as they are.
    const plain = rows.filter((row) => row.kind !== "tool");
    expect(await transcripts.whole(plain)).toBe(plain);
  });

  it("is copied with the conversation into a thread forked from it", async () => {
    const { api, ada, thread, db, ran, detail, tools, model, worker } = await dumped();
    const last = (await detail()).rows.at(-1)!;

    const res = await api("POST", `/threads/${thread.id}/fork`, ada.cookie, { rowId: last.id });
    expect(res.status).toBe(200);
    const fork = (await res.json()) as { id: string };

    const [, big] = tools(await detail(ada, fork.id));
    expect(big!.output).toMatchObject({ value: null, large: { size: BIG + 11 } });
    const copy = (big!.output as { large: { id: string } }).large.id;
    expect(copy).not.toBe(ran[1]!.id);
    expect(await (await api("GET", `/tool-results/${copy}`, ada.cookie)).json()).toEqual({
      value: { text: "é".repeat(BIG) },
    });
    // The fork's agent reads it too.
    await api("POST", `/threads/${fork.id}/messages`, ada.cookie, { text: "Again" });
    const call = await model.next();
    call.reply("Still there.");
    await worker.idle();
    expect(call.texts).toContain(
      `result probe.dump: {"ok":true,"value":{"text":"${"é".repeat(BIG)}"}}`,
    );

    // Each thread's results go with it.
    expect((await api("DELETE", `/threads/${thread.id}`, ada.cookie)).status).toBe(200);
    expect(await db.select({ id: schema.toolResult.eventId }).from(schema.toolResult)).toEqual([
      { id: copy },
    ]);
  });

  it("is told to the agent, cut short, when it asks how a background call went", async () => {
    // A tool that runs until the test ends it.
    let finish = (_output: { ok: true; value: unknown }) => {};
    const wait: ToolSpec<Record<string, never>> = {
      name: "probe.wait",
      title: "Wait",
      description: "Waits.",
      input: z.object({}),
      risk: () => "normal",
      run: () => new Promise((resolve) => (finish = resolve)),
    };
    const t = await agentThread({}, { toolsets: [{ ...toolset, tools: [wait] }] });
    await t.start();
    await t.post(t.ada, "Wait in the background");
    const first = await t.model.next();
    first.startStep();
    first.toolCall("start", "jobs.start", { tool: "probe.wait", input: {} });
    first.endStep();
    first.end();
    (await t.model.next()).reply("Started.");
    await t.worker.idle();
    const [record] = (await t.db.execute<{ id: string }>("select id from call where background"))
      .rows;

    // Its end wakes the agent, which then checks on it.
    finish({ ok: true, value: { text: "é".repeat(BIG) } });
    const told = await t.model.next();
    told.startStep();
    told.toolCall("check", "jobs.check", { id: record!.id });
    told.endStep();
    told.end();
    const checked = await t.model.next();
    checked.reply("Done.");
    await t.worker.idle();

    const ended = transcriptOf(await t.events()).rows.find(
      (row) => row.kind === "tool" && row.id === record!.id,
    );
    expect(ended).toMatchObject({ output: { value: null, large: { size: BIG + 11 } } });
    expect(checked.texts.at(-1)).toContain(`"result":"{\\"text\\":\\"${"é".repeat(100)}`);
    expect(checked.texts.at(-1)).toContain("(cut short)");
  });
});

describe("reading rows whole", () => {
  it("leaves alone the rows before the latest compaction's cut, which the agent no longer reads", async () => {
    const row = (seq: number) => ({ kind: "human", id: `m${seq}`, seq }) as TranscriptRow;
    const compaction = { kind: "compaction", id: "c", seq: 3, firstKeptSeq: 2 } as TranscriptRow;
    const rows = [row(1), row(2), compaction, row(4)];
    const asked: (readonly TranscriptRow[])[] = [];
    const whole = async (list: readonly TranscriptRow[]) => {
      asked.push(list);
      return list;
    };

    expect(await wholeWhereRead(rows, whole)).toEqual(rows);
    expect(asked).toEqual([[row(2), compaction, row(4)]]);
    await wholeWhereRead([row(1)], whole);
    expect(asked[1]).toEqual([row(1)]);
  });
});

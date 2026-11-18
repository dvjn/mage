// Scripts through a thread: a script's calls are rows of its run that people see and the model does
// not, each judged as a direct call; what a script gets back, how it fails, and how it stops.

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { conversationText } from "@/server/execution/compaction.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { probe } from "@/server/testing/contract.ts";
import { MCP_ORIGIN } from "@/server/testing/workspace.ts";
import { EDITORS, TOOL_OFF, wireToolName } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

async function scriptThread() {
  const tool = probe();
  // The tool that needs approval, counted as it runs.
  const [wait, guardedSpec, ...rest] = tool.toolset.tools;
  const guarded = vi.fn(guardedSpec!.run.bind(guardedSpec));
  const toolset = { ...tool.toolset, tools: [wait!, { ...guardedSpec!, run: guarded }, ...rest] };
  const t = await agentThread({}, { toolsets: [toolset] });
  await t.start();
  let made = 0;
  // The model's next call, asking for a script; answers the script's call id.
  async function script(code: string, inputs?: Record<string, unknown>) {
    const call = await t.model.next();
    call.startStep();
    made += 1;
    call.toolCall(`s${made}`, "scripts.run", { code, ...(inputs && { inputs }) });
    call.endStep();
    call.end();
    return `s${made}`;
  }
  // The model's next call, with what it was given, answered with the text.
  async function replies(text = "Done.") {
    const call = await t.model.next();
    call.reply(text);
    return call;
  }
  async function calls() {
    return transcriptOf(await t.events()).rows.flatMap((row) => (row.kind === "tool" ? [row] : []));
  }
  async function stored() {
    return (
      await t.db.execute<{ id: string; status: string; run_id: string; tool_id: string }>(
        sql`select id, status, run_id, tool_id from call where thread_id = ${t.thread.id}
             order by seq`,
      )
    ).rows;
  }
  async function until(condition: () => boolean | Promise<boolean>) {
    for (let tries = 0; !(await condition()); tries++) {
      if (tries > 3000) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  async function pauses() {
    const rows = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from script_pause where thread_id = ${t.thread.id}`,
    );
    return rows.rows[0]!.n;
  }
  const decide = async (callId: string, allow: boolean) =>
    t.api("POST", `/threads/${t.thread.id}/tools/${callId}/decision`, t.ada.cookie, {
      allow,
      scope: "once",
    });
  // What the call printed that people watching see.
  async function shown(callId: string) {
    const rows = await t.db.execute<{ text: string }>(
      sql`select text from call_output_chunk where call_id = ${callId} order by "offset"`,
    );
    return rows.rows.map((row) => row.text).join("");
  }
  // A beat of the jobs' keeper, as one comes on its own.
  const sweep = async () => t.calls.beat();
  return {
    ...t,
    tool,
    guarded,
    script,
    replies,
    calls,
    stored,
    until,
    pauses,
    decide,
    shown,
    sweep,
  };
}

describe("a script", () => {
  it("records each call it makes as a row of its run, and the model reads only its result", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Double it");
    const id = await t.script(
      'r = await call_tool("probe__wait", {"label": "a"})\nprint("got", r["n"])\nr["n"] * 2',
    );
    await t.until(() => t.tool.running("a"));
    t.tool.finish("a", { n: 21 });
    const next = await t.replies();
    await t.worker.idle();

    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":42,"printed":"got 21\\n"}}',
    );
    // The script, then its result: none of its calls.
    expect(next.texts.filter((text) => !text.startsWith("user:"))).toHaveLength(2);
    const [script, inner] = await t.calls();
    expect(script).toMatchObject({ id, toolId: "scripts.run", state: "completed" });
    expect(inner).toMatchObject({
      toolId: "probe.wait",
      within: id,
      messageId: "",
      state: "completed",
      title: "Wait",
      input: { label: "a" },
      output: { ok: true, value: { n: 21 } },
    });
    const rows = await t.stored();
    expect(rows.map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "completed"],
      ["probe.wait", "completed"],
    ]);
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(1);
    // Nor does a summary of the thread.
    const all = transcriptOf(await t.events()).rows;
    expect(conversationText(all)).toContain("scripts.run");
    expect(conversationText(all)).not.toContain("Agent called tool]: probe");
  });

  it("reads its inputs by name, nested values as Python's", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Sum");
    await t.script('sum(item["n"] for item in items) + config["extra"][1]', {
      items: [{ n: 1 }, { n: 2 }],
      config: { extra: [0, 10] },
    });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe('result scripts.run: {"ok":true,"value":{"result":13}}');
  });

  it("refuses inputs not named as Python names", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Go");
    await t.script("1", { "not-a-name": 1, class: 2 });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain(
      "Input names must be Python identifiers, not not-a-name, class.",
    );
    expect(await t.stored()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("pauses at a call that needs approval, and once approved runs it once and goes on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    const id = await t.script(
      'print("before")\nr = await call_tool("probe__guarded", {"label": "x"})\nprint("after", r["did"])\nr["did"]',
    );
    await t.worker.idle();
    expect((await t.runs()).map((run) => run.status)).toEqual(["waiting"]);
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "ready"],
      ["probe.guarded", "waiting"],
    ]);
    expect(await t.pauses()).toBe(1);
    const [, inner] = await t.calls();
    expect(inner).toMatchObject({ within: id, waits: true, state: "waiting" });

    expect((await t.decide(inner!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":"x","printed":"before\\nafter x\\n"}}',
    );
    expect(t.guarded).toHaveBeenCalledTimes(1);
    expect((await t.stored()).map((row) => row.status)).toEqual(["completed", "completed"]);
    expect(await t.pauses()).toBe(0);
    expect((await t.runs()).map((run) => run.status)).toEqual(["completed"]);
  });

  it("raises PermissionError at a call that was denied, which it can catch", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script(
      'try:\n  await call_tool("probe__guarded", {"label": "x"})\nexcept PermissionError as e:\n  r = str(e)\nr',
    );
    await t.worker.idle();
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, false)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain('"result":"probe__guarded was denied."');
    expect(t.guarded).not.toHaveBeenCalled();
    expect((await t.stored()).map((row) => row.status)).toEqual(["completed", "denied"]);
  });

  it("fails without running the approved call where it stood cannot be loaded", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    await t.db.execute(sql`update script_pause set snapshot = '\\x00'::bytea`);
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("The script could not go on");
    expect(t.guarded).not.toHaveBeenCalled();
    expect((await t.stored()).map((row) => row.status)).toEqual(["failed", "cancelled"]);
  });

  it("goes on at once when the call it waits on comes to need nobody, as a direct call does", async () => {
    const t = await scriptThread();
    const signOff = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "some",
      users: [`user:${t.grace.userId}`],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], signOff.id);
    await t.post(t.ada, "Both");
    const call = await t.model.next();
    call.startStep();
    call.toolCall("s1", "scripts.run", {
      code: 'await call_tool("probe__wait", {"label": "a"})\n"done"',
    });
    call.toolCall("d1", "probe.wait", { label: "b" });
    call.endStep();
    call.end();
    await t.worker.idle();
    const waiting = (await t.stored()).filter((row) => row.status === "waiting");
    expect(waiting.map((row) => row.id)).toContain("d1");
    expect(waiting).toHaveLength(2);
    // Allowed for now on the direct call, the script's call needs nobody either.
    const allowed = await t.api("POST", `/threads/${t.thread.id}/tools/d1/decision`, t.ada.cookie, {
      allow: true,
      scope: "for_now",
    });
    expect(allowed.status).toBe(200);
    await t.until(() => t.tool.running("a"));
    t.tool.finish("a", 1);
    await t.until(() => t.tool.running("b"));
    t.tool.finish("b", 2);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts).toContain('result scripts.run: {"ok":true,"value":{"result":"done"}}');
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("nests the job a call it made started, each under the call that made it", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Chain");
    const id = await t.script(
      'await call_tool("jobs__start", {"tool": "probe__wait", "input": {"label": "a"}})\n"started"',
    );
    await t.until(() => t.tool.running("a"));
    await t.replies();
    await t.worker.idle();
    const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
    const { rows } = (await res.json()) as {
      rows: { kind: string; id: string; toolId?: string; parent?: object; depth?: number }[];
    };
    const calls = rows.filter((row) => row.kind === "tool");
    const start = calls.find((row) => row.toolId === "jobs.start")!;
    expect(calls.map(({ toolId, parent, depth }) => ({ toolId, parent, depth }))).toEqual([
      { toolId: "scripts.run", parent: undefined, depth: undefined },
      { toolId: "jobs.start", parent: { id, title: "Run script" }, depth: 1 },
      { toolId: "probe.wait", parent: { id: start.id, title: "Start" }, depth: 2 },
    ]);
    t.tool.finish("a", 1);
    await t.replies();
    await t.worker.idle();
  });

  it("stopped with its run, ends its own calls but leaves the job it started to run on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Chain");
    await t.script(
      'await call_tool("jobs__start", {"tool": "probe__wait", "input": {"label": "a"}})\nawait call_tool("probe__wait", {"label": "b"})',
    );
    await t.until(() => t.tool.running("a") && t.tool.running("b"));
    await t.execution.stop({ threadId: t.thread.id }, t.ada.userId);
    await t.worker.idle();
    expect(t.tool.aborted).toEqual(["b"]);
    // The job runs on, and its end is told.
    t.tool.finish("a", "A");
    await t.replies("Noted.");
    await t.worker.idle();
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "failed"],
      ["jobs.start", "completed"],
      ["probe.wait", "completed"],
      ["probe.wait", "failed"],
    ]);
    const ends = (await t.events()).filter(
      (event) => event.type === "tool.ran" || event.type === "tool.denied",
    );
    // Each call ends once.
    const ended = ends.map((event) => (event.data as { callId: string }).callId);
    expect(new Set(ended).size).toBe(ended.length);
  });

  it("caps its calls across its pauses, not only between them", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Many");
    const id = await t.script(
      [
        'await call_tool("probe__guarded", {"label": "x"})',
        "r = None",
        "for i in range(5):",
        "  try:",
        '    await call_tool("nope__tool", {})',
        "  except NameError:",
        "    pass",
        "  except RuntimeError as e:",
        "    r = str(e)",
        "r",
      ].join("\n"),
    );
    await t.worker.idle();
    // As though it made all but two of its calls before it paused.
    await t.db.execute(sql`
      insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, background,
                        parent_id)
      select ${t.thread.id}, 'made-' || n, branch_id, 0, run_id, 'probe.wait', 'normal',
             'completed', false, ${id}
        from call, generate_series(1, 997) as n
       where thread_id = ${t.thread.id} and id = ${id}`);
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain('"result":"A script makes at most 1000 calls."');
    // The calls made up are not the log's.
    await t.db.execute(sql`delete from call where id like 'made-%'`);
  });

  it("fails the call it would pause at where it holds too much to pause", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Big");
    await t.script(
      'big = "a" * 5000000\ntry:\n  await call_tool("probe__guarded", {"label": "x"})\nexcept RuntimeError as e:\n  r = str(e)\nr',
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("The script holds too much to pause for an approval");
    expect((await t.stored()).map((row) => row.status)).toEqual(["completed", "failed"]);
    expect(await t.pauses()).toBe(0);
    expect(t.guarded).not.toHaveBeenCalled();
  });

  it("goes stale without where it stood when it may no longer run, never running its call alone", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    const off = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
      toolIds: ["scripts.run"],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    await t.replies();
    await t.worker.idle();
    expect((await t.stored()).map((row) => row.status)).toEqual(["stale", "cancelled"]);
    expect(await t.pauses()).toBe(0);
    expect(t.guarded).not.toHaveBeenCalled();
  });

  it("shows what it prints once it goes on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Print");
    const id = await t.script(
      'print("before")\nawait call_tool("probe__guarded", {"label": "x"})\nprint("after")\nawait call_tool("probe__wait", {"label": "w"})',
    );
    await t.worker.idle();
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    await t.until(() => t.tool.running("w"));
    const shown = async () =>
      (
        await t.db.execute<{ text: string }>(
          sql`select text from call_output_chunk where call_id = ${id} order by "offset"`,
        )
      ).rows
        .map((row) => row.text)
        .join("");
    await t.until(async () => (await shown()).includes("after"));
    t.tool.finish("w", 1);
    await t.replies();
    await t.worker.idle();
  });

  it("fails rather than start again from the top where it made calls and has nowhere to go on from", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    await t.db.execute(sql`delete from script_pause`);
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("where it stood was lost");
    expect(t.guarded).not.toHaveBeenCalled();
    expect((await t.stored()).map((row) => row.status)).toEqual(["failed", "cancelled"]);
  });

  it("shows as waiting while it waits on a call it made", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    const id = await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
    const { rows } = (await res.json()) as {
      rows: { id: string; state?: string; canBackground?: boolean }[];
    };
    const shown = rows.find((row) => row.id === id);
    expect(shown).toMatchObject({ state: "waiting" });
    // It moves to the background only while it runs.
    expect(shown?.canBackground).toBeUndefined();
  });

  it("raises PermissionError where the approval lapsed before it went on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script(
      'try:\n  await call_tool("probe__guarded", {"label": "x"})\nexcept PermissionError as e:\n  r = str(e)\nr',
    );
    await t.worker.idle();
    await t.worker.stop();
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    // Only Grace may approve it from now on.
    const graceOnly = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Grace",
      color: "orange",
      use: "none",
      users: [],
      approvers: [`user:${t.grace.userId}`],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.guarded"], graceOnly.id);
    await t.worker.start();
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("probe__guarded did not run: its approval no longer held.");
    expect(t.guarded).not.toHaveBeenCalled();
    expect((await t.stored()).map((row) => row.status)).toEqual(["completed", "stale"]);
  });

  it("pauses twice, never running a call again as it goes on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Twice");
    await t.script(
      [
        'a = await call_tool("probe__wait", {"label": "a"})',
        'b = await call_tool("probe__guarded", {"label": "1"})',
        'c = await call_tool("probe__guarded", {"label": "2"})',
        '[a, b["did"], c["did"]]',
      ].join("\n"),
    );
    await t.until(() => t.tool.running("a"));
    t.tool.finish("a", "A");
    await t.worker.idle();
    for (const label of ["1", "2"]) {
      const waiting = (await t.stored()).find((row) => row.status === "waiting")!;
      expect((await t.decide(waiting.id, true)).status).toBe(200);
      await t.until(async () => t.guarded.mock.calls.length === Number(label));
      // The second goes on to the reply, which the test gives below.
      if (label === "1") await t.worker.idle();
    }
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":["A","1","2"]}}',
    );
    expect(t.guarded).toHaveBeenCalledTimes(2);
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "completed"],
      ["probe.wait", "completed"],
      ["probe.guarded", "completed"],
      ["probe.guarded", "completed"],
    ]);
    const ran = (await t.events()).filter((event) => event.type === "tool.ran");
    expect(ran).toHaveLength(4);
  });

  it("names its calls in its rows, as the log says, once the rows are made again from it", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    const id = await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    const parents = async () =>
      (
        await t.db.execute<{ parent_id: string | null }>(
          sql`select parent_id from call where thread_id = ${t.thread.id} order by seq`,
        )
      ).rows.map((row) => row.parent_id);
    expect(await parents()).toEqual([null, id]);
    await t.db.execute(sql`delete from call where thread_id = ${t.thread.id}`);
    await t.callStore.fromLog(t.thread.id);
    expect(await parents()).toEqual([null, id]);
  });

  it("runs the calls it gathers at once", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "All at once");
    await t.script(
      'import asyncio\nawait asyncio.gather(*[call_tool("probe__wait", {"label": l}) for l in "abcd"])',
    );
    // Every one runs before any ends.
    const labels = ["a", "b", "c", "d"];
    await t.until(() => labels.every((label) => t.tool.running(label)));
    for (const label of labels) t.tool.finish(label, label);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":["a","b","c","d"]}}',
    );
  });

  it("pauses with the calls gathered beside one that waits settled, and runs none of them again", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Gather");
    await t.script(
      [
        "import asyncio",
        "await asyncio.gather(",
        '  call_tool("probe__wait", {"label": "a"}),',
        '  call_tool("probe__guarded", {"label": "x"}),',
        '  call_tool("probe__wait", {"label": "b"}),',
        ")",
      ].join("\n"),
    );
    await t.until(() => t.tool.running("a") && t.tool.running("b"));
    t.tool.finish("a", "A");
    t.tool.finish("b", "B");
    await t.worker.idle();
    // The call that waits is recorded as the script pauses, after those it ran.
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "ready",
      "completed",
      "completed",
      "waiting",
    ]);
    const waiting = (await t.stored()).find((row) => row.status === "waiting")!;
    expect((await t.decide(waiting.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":["A",{"did":"x"},"B"]}}',
    );
    expect(t.guarded).toHaveBeenCalledTimes(1);
    const ran = (await t.events()).filter((event) => event.type === "tool.ran");
    expect(ran).toHaveLength(4);
  });

  it("gives back its result where it caught a gathered call's error, once the rest end", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Gather");
    await t.script(
      [
        "import asyncio",
        "try:",
        '  await asyncio.gather(call_tool("nope__tool", {}), call_tool("probe__wait", {"label": "a"}))',
        "except NameError:",
        '  r = "caught"',
        "r",
      ].join("\n"),
    );
    await t.until(() => t.tool.running("a"));
    t.tool.finish("a", "A");
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe('result scripts.run: {"ok":true,"value":{"result":"caught"}}');
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
  });

  it("tells a script that does not await its call how to", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Forgot");
    await t.script('r = call_tool("nope__tool", {})\nr["a"]');
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("await call_tool(...)");
  });

  it("runs in the background, its prints what the job check shows while it runs", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "In the background");
    const code =
      'print("step 1")\nawait call_tool("probe__wait", {"label": "a"})\nprint("step 2")\n"done"';
    const start = await t.model.next();
    start.startStep();
    start.toolCall("j1", "jobs.start", { tool: "scripts__run", input: { code } });
    start.endStep();
    start.end();
    await t.replies("Started.");
    await t.worker.idle();
    await t.until(() => t.tool.running("a"));
    const job = (await t.stored()).find((row) => row.tool_id === "scripts.run")!;
    await t.until(async () => (await t.shown(job.id)).includes("step 1"));
    await t.post(t.ada, "How is it going?");
    const asks = await t.model.next();
    asks.startStep();
    asks.toolCall("c1", "jobs.check", { id: job.id });
    asks.endStep();
    asks.end();
    const checked = await t.replies("Still going.");
    await t.worker.idle();
    expect(checked.texts.at(-1)).toContain('"status":"running"');
    expect(checked.texts.at(-1)).toContain("step 1");
    t.tool.finish("a", 1);
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":"done"');
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["jobs.start", "completed"],
      ["scripts.run", "completed"],
      ["probe.wait", "completed"],
      ["jobs.check", "completed"],
    ]);
  });

  it("in the background pauses for approval as a job, and finishes once approved", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "In the background");
    const code = 'r = await call_tool("probe__guarded", {"label": "x"})\nr["did"]';
    const start = await t.model.next();
    start.startStep();
    start.toolCall("j1", "jobs.start", { tool: "scripts__run", input: { code } });
    start.endStep();
    start.end();
    await t.replies("Started.");
    await t.worker.idle();
    await t.until(async () => (await t.stored()).some((row) => row.status === "waiting"));
    // The sweep holds back a job that waits on its own call.
    await t.sweep();
    const job = (await t.stored()).find((row) => row.tool_id === "scripts.run")!;
    expect(job.status).toBe("ready");
    const waiting = (await t.stored()).find((row) => row.status === "waiting")!;
    expect((await t.decide(waiting.id, true)).status).toBe(200);
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":"x"');
    expect(t.guarded).toHaveBeenCalledTimes(1);
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(await t.pauses()).toBe(0);
  });

  it("in the background goes on when the call it waits on comes to need nobody", async () => {
    const t = await scriptThread();
    const signOff = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "some",
      users: [`user:${t.grace.userId}`],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], signOff.id);
    await t.post(t.ada, "In the background");
    const start = await t.model.next();
    start.startStep();
    start.toolCall("j1", "jobs.start", {
      tool: "scripts__run",
      input: { code: 'await call_tool("probe__wait", {"label": "a"})' },
    });
    start.endStep();
    start.end();
    await t.replies("Started.");
    await t.worker.idle();
    await t.until(async () => (await t.stored()).some((row) => row.status === "waiting"));
    // A call of the run's own waits too; allowed for now, the job's needs nobody either.
    await t.post(t.ada, "And this");
    const direct = await t.model.next();
    direct.startStep();
    direct.toolCall("d1", "probe.wait", { label: "b" });
    direct.endStep();
    direct.end();
    await t.worker.idle();
    const allowed = await t.api("POST", `/threads/${t.thread.id}/tools/d1/decision`, t.ada.cookie, {
      allow: true,
      scope: "for_now",
    });
    expect(allowed.status).toBe(200);
    await t.until(() => t.tool.running("a") && t.tool.running("b"));
    t.tool.finish("b", "B");
    await t.replies("B done.");
    await t.worker.idle();
    t.tool.finish("a", "A");
    await t.replies("A done.");
    await t.worker.idle();
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["jobs.start", "completed"],
      ["scripts.run", "completed"],
      ["probe.wait", "completed"],
      ["probe.wait", "completed"],
    ]);
  });

  it("cannot start another script, in the background or not", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Nest");
    await t.script(
      'try:\n  await call_tool("jobs__start", {"tool": "scripts__run", "input": {"code": "1"}})\nexcept RuntimeError as e:\n  r = str(e)\nr',
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain(
      '"result":"A script cannot start another, in the background or not."',
    );
    expect((await t.stored()).map((row) => row.tool_id)).toEqual(["scripts.run", "jobs.start"]);
  });

  // A background script paused at a call that needs approval; its job's id and the call's.
  async function pausedJob(t: Awaited<ReturnType<typeof scriptThread>>, code: string) {
    await t.post(t.ada, "In the background");
    const start = await t.model.next();
    start.startStep();
    start.toolCall("j1", "jobs.start", { tool: "scripts__run", input: { code } });
    start.endStep();
    start.end();
    await t.replies("Started.");
    await t.worker.idle();
    await t.until(async () => (await t.stored()).some((row) => row.status === "waiting"));
    const rows = await t.stored();
    return {
      job: rows.find((row) => row.tool_id === "scripts.run")!.id,
      waiting: rows.find((row) => row.status === "waiting")!.id,
    };
  }

  it("in the background goes stale without where it stood or its approved call", async () => {
    const t = await scriptThread();
    const { waiting } = await pausedJob(t, 'await call_tool("probe__guarded", {"label": "x"})');
    const off = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
      toolIds: ["scripts.run"],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    expect((await t.decide(waiting, true)).status).toBe(200);
    await t.until(async () =>
      (await t.stored()).some((row) => row.tool_id === "scripts.run" && row.status === "stale"),
    );
    await t.replies("Noted.");
    await t.worker.idle();
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["jobs.start", "completed"],
      ["scripts.run", "stale"],
      ["probe.guarded", "cancelled"],
    ]);
    expect(await t.pauses()).toBe(0);
    expect(t.guarded).not.toHaveBeenCalled();
  });

  it("in the background, cancelled while paused, ends with where it stood and its call", async () => {
    const t = await scriptThread();
    const { job } = await pausedJob(t, 'await call_tool("probe__guarded", {"label": "x"})');
    const cancelled = await t.api(
      "POST",
      `/threads/${t.thread.id}/tools/${job}/cancel`,
      t.ada.cookie,
    );
    expect(cancelled.status).toBe(200);
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["jobs.start", "completed"],
      ["scripts.run", "cancelled"],
      ["probe.guarded", "cancelled"],
    ]);
    expect(await t.pauses()).toBe(0);
    // A person's cancel is no decision on the job, as it runs or once its rows are made again.
    const shown = async () => (await t.calls()).find((row) => row.id === job);
    expect(await shown()).toMatchObject({ state: "cancelled" });
    expect((await shown())?.decision).toBeNull();
    await t.db.execute(sql`delete from call where thread_id = ${t.thread.id}`);
    await t.callStore.fromLog(t.thread.id);
    const [row] = (
      await t.db.execute<{ decided_by: string | null }>(
        sql`select decided_by from call where thread_id = ${t.thread.id} and id = ${job}`,
      )
    ).rows;
    expect(row).toEqual({ decided_by: null });
  });

  // A background script that pauses for approval while the run that started it still goes on;
  // its job's id and the call's, with the run's next model step still to answer.
  async function pausedUnderRun(t: Awaited<ReturnType<typeof scriptThread>>) {
    await t.post(t.ada, "In the background");
    const start = await t.model.next();
    start.startStep();
    start.toolCall("j1", "jobs.start", {
      tool: "scripts__run",
      input: { code: 'r = await call_tool("probe__guarded", {"label": "x"})\nr["did"]' },
    });
    start.endStep();
    start.end();
    const after = await t.model.next();
    await t.until(async () => (await t.stored()).some((row) => row.status === "waiting"));
    await t.sweep();
    const rows = await t.stored();
    return {
      after,
      job: rows.find((row) => row.tool_id === "scripts.run")!.id,
      waiting: rows.find((row) => row.status === "waiting")!.id,
    };
  }

  // Allowed, the paused job goes on and its result reaches the agent.
  async function finishes(t: Awaited<ReturnType<typeof scriptThread>>, waiting: string) {
    expect((await t.decide(waiting, true)).status).toBe(200);
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":"x"');
    expect(t.guarded).toHaveBeenCalledTimes(1);
    expect(await t.pauses()).toBe(0);
  }

  it("in the background, paused, outlives the run that started it ending", async () => {
    const t = await scriptThread();
    const { after, job, waiting } = await pausedUnderRun(t);
    after.reply("Started.");
    await t.worker.idle();
    await t.sweep();
    expect((await t.runs()).map((run) => run.status)).toEqual(["completed"]);
    const rows = new Map((await t.stored()).map((row) => [row.id, row.status]));
    expect([rows.get(job), rows.get(waiting)]).toEqual(["ready", "waiting"]);
    expect(await t.pauses()).toBe(1);
    await finishes(t, waiting);
  });

  it("in the background, paused, outlives the run that started it being stopped", async () => {
    const t = await scriptThread();
    const { job, waiting } = await pausedUnderRun(t);
    await t.execution.stop({ threadId: t.thread.id }, t.ada.userId);
    await t.worker.idle();
    await t.sweep();
    expect((await t.runs()).map((run) => run.status)).toEqual(["cancelled"]);
    const rows = new Map((await t.stored()).map((row) => [row.id, row.status]));
    expect([rows.get(job), rows.get(waiting)]).toEqual(["ready", "waiting"]);
    expect(await t.pauses()).toBe(1);
    await finishes(t, waiting);
  });

  it("in the background shows the job check it waits while paused, and all it printed", async () => {
    const t = await scriptThread();
    const { job, waiting } = await pausedJob(
      t,
      'print("one")\nawait call_tool("probe__guarded", {"label": "x"})\nprint("two")\nawait call_tool("probe__wait", {"label": "w"})',
    );
    const check = async () => {
      await t.post(t.ada, "How is it going?");
      const asks = await t.model.next();
      asks.startStep();
      asks.toolCall(`c${Math.random()}`, "jobs.check", { id: job });
      asks.endStep();
      asks.end();
      const checked = await t.replies("Noted.");
      await t.worker.idle();
      return checked.texts.at(-1)!;
    };
    const paused = await check();
    expect(paused).toContain('"status":"waiting"');
    expect(paused).toContain('"output":"one\\n"');
    expect((await t.decide(waiting, true)).status).toBe(200);
    await t.until(() => t.tool.running("w"));
    await t.until(async () => (await t.shown(job)).includes("two"));
    const running = await check();
    expect(running).toContain('"status":"running"');
    expect(running).toContain('"output":"one\\ntwo\\n"');
    t.tool.finish("w", 1);
    await t.replies("Done.");
    await t.worker.idle();
  });

  it("with nowhere to go on from cancels every call it left open", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Two");
    await t.script(
      'import asyncio\nawait asyncio.gather(call_tool("probe__guarded", {"label": "1"}), call_tool("probe__guarded", {"label": "2"}))',
    );
    await t.worker.idle();
    await t.db.execute(sql`delete from script_pause`);
    for (const row of (await t.stored()).filter((one) => one.status === "waiting")) {
      expect((await t.decide(row.id, true)).status).toBe(200);
    }
    // As the script fails, before its run ends.
    const next = await t.model.next();
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "failed",
      "cancelled",
      "cancelled",
    ]);
    next.reply("Noted.");
    await t.worker.idle();
    expect(t.guarded).not.toHaveBeenCalled();
  });

  it("moved to the background while it runs keeps its calls running", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Wait");
    const id = await t.script(
      'a = await call_tool("probe__wait", {"label": "a"})\nb = await call_tool("probe__wait", {"label": "b"})\n[a, b]',
    );
    await t.until(() => t.tool.running("a"));
    const moved = await t.api(
      "POST",
      `/threads/${t.thread.id}/tools/${id}/background`,
      t.ada.cookie,
    );
    expect(moved.status).toBe(200);
    // The run goes on and ends; the script and its call go on without it.
    await t.replies("It runs on.");
    await t.worker.idle();
    expect(t.tool.aborted).toEqual([]);
    t.tool.finish("a", "A");
    await t.until(() => t.tool.running("b"));
    t.tool.finish("b", "B");
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":["A","B"]');
    expect((await t.stored()).map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("ends with its waiting call when its run is stopped while it is paused", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script('await call_tool("probe__guarded", {"label": "x"})');
    await t.worker.idle();
    await t.execution.stop({ threadId: t.thread.id }, t.ada.userId);
    await t.worker.idle();
    expect((await t.stored()).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect(await t.pauses()).toBe(0);
    expect(t.guarded).not.toHaveBeenCalled();
  });

  it("fails with Python's traceback for a call it does not catch, keeping what it printed", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script('print("start")\nawait call_tool("nope__tool", {})');
    await t.replies();
    await t.worker.idle();
    const [script, inner] = await t.calls();
    const said = script?.output?.ok === false ? script.output.error : "";
    expect(said).toContain('    await call_tool("nope__tool", {})\n');
    expect(said).toContain("NameError: No tool is named nope__tool here.");
    expect(said).toContain("Printed before it:\nstart");
    expect(inner).toMatchObject({ toolId: "nope__tool", state: "failed" });
  });

  it("refuses tools that ask people, and scripts within scripts", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try them");
    await t.script(
      [
        "out = []",
        'for name, given in [("thread__ask", {"questions": []}), ("scripts__run", {"code": "1"})]:',
        "  try:",
        "    await call_tool(name, given)",
        "  except PermissionError as e:",
        "    out.append(str(e))",
        "out",
      ].join("\n"),
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":["thread__ask cannot be called from a script.","A script cannot run another."]}}',
    );
  });

  it("fails on a syntax error before it calls anything", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Go");
    await t.script("def f(:\n  pass");
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("SyntaxError");
    expect((await t.stored()).map((row) => row.tool_id)).toEqual(["scripts.run"]);
  });

  it("stops with its run, aborting the call it waits on", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Wait");
    await t.script(
      'await call_tool("probe__wait", {"label": "a"})\nawait call_tool("probe__wait", {"label": "b"})',
    );
    await t.until(() => t.tool.running("a"));
    await t.execution.stop({ threadId: t.thread.id }, t.ada.userId);
    await t.worker.idle();
    expect(t.tool.aborted).toEqual(["a"]);
    expect(t.tool.running("b")).toBe(false);
    const [script, inner] = await t.calls();
    expect(script).toMatchObject({
      state: "failed",
      output: { ok: false, error: "The script was stopped." },
    });
    expect(inner).toMatchObject({ state: "failed", output: { ok: false, error: "aborted" } });
    expect((await t.runs()).map((run) => run.status)).toEqual(["cancelled"]);
  });

  it("sleeps holding no lock of its thread, and stops at once with its run while asleep", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Sleep");
    await t.script("import time\ntime.sleep(30)");
    await t.until(async () => (await t.stored()).some((row) => row.status === "running"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The thread takes a message meanwhile.
    await t.post(t.ada, "Still there?");
    const started = Date.now();
    await t.execution.stop({ threadId: t.thread.id }, t.ada.userId);
    await t.until(async () => (await t.stored()).every((row) => row.status !== "running"));
    expect(Date.now() - started).toBeLessThan(2000);
    // The message waiting starts the next run.
    await t.replies("Here.");
    await t.worker.idle();
    const [script] = await t.calls();
    expect(script).toMatchObject({
      state: "failed",
      output: { ok: false, error: "The script was stopped." },
    });
    expect((await t.runs()).map((run) => run.status)).toEqual(["cancelled", "completed"]);
  });

  it("holds a tool turned off while it runs from its next call", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Twice");
    await t.script(
      'await call_tool("probe__wait", {"label": "a"})\ntry:\n  await call_tool("probe__wait", {"label": "b"})\nexcept PermissionError as e:\n  r = str(e)\nr',
    );
    await t.until(() => t.tool.running("a"));
    const off = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
      toolIds: ["probe.wait"],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    t.tool.finish("a", 1);
    const next = await t.replies();
    await t.worker.idle();
    expect(t.tool.running("b")).toBe(false);
    expect(next.texts.at(-1)).toContain('"result":"probe__wait is off here."');
  });

  it("refuses a tool that is off and an MCP server's tool not turned on in the thread", async () => {
    const t = await scriptThread();
    const off = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
      toolIds: ["probe.guarded"],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    const added = await t.api("POST", "/org/mcp-servers", t.ada.cookie, {
      name: "Open",
      url: `${MCP_ORIGIN}/mcp`,
      auth: { kind: "none" },
    });
    expect(added.ok).toBe(true);
    const space = { id: t.space.id, orgId: t.ada.orgId };
    const names = await t.tools.modelNames(space);
    const [server] = await t.tools.fromServers(space, names);
    const mcp = wireToolName(names.toModel(server!.id));
    await t.post(t.ada, "Try them");
    await t.script(
      [
        "out = []",
        `for name in ["probe__guarded", "${mcp}"]:`,
        "  try:",
        "    await call_tool(name, {})",
        "  except NameError as e:",
        "    out.append(str(e))",
        "out",
      ].join("\n"),
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("No tool is named probe__guarded here.");
    expect(next.texts.at(-1)).toContain(
      `${mcp} is not on yet. Call tools__search outside the script to turn it on, then run the script again.`,
    );
  });
});

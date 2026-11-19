// Scripts through a thread: a script's calls are rows of its run that people see and the model does
// not, each judged as a direct call; what a script gets back, how it fails, and how it stops.

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import * as z from "zod";

import { SIGNATURE_CHARS } from "@/server/calls/scripts.ts";
import { conversationText } from "@/server/execution/compaction.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { probe } from "@/server/testing/contract.ts";
import type { AnyToolSpec } from "@/server/tools/registry.ts";
import { MCP_ORIGIN } from "@/server/testing/workspace.ts";
import { EDITORS, TOOL_OFF, wireToolName } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

// What the helpers below use of a thread.
type Helped = Pick<Awaited<ReturnType<typeof agentThread>>, "api" | "ada" | "tools"> & {
  space: { id: string };
};

// Adds the stand-in MCP server to the org, answering its echo tool's id and its name in a script.
async function mcpEcho(t: Helped) {
  const added = await t.api("POST", "/org/mcp-servers", t.ada.cookie, {
    name: "Open",
    url: `${MCP_ORIGIN}/mcp`,
    auth: { kind: "none" },
  });
  expect(added.ok).toBe(true);
  const space = { id: t.space.id, orgId: t.ada.orgId };
  const names = await t.tools.modelNames(space);
  const echo = (await t.tools.fromServers(space, names)).find((one) => one.id.endsWith("echo"))!;
  return { echo: echo.id, mcp: wireToolName(names.toModel(echo.id)) };
}

// Sets the tools in the thread's space to a policy whose every call waits for an editor.
async function signOff(t: Helped, toolIds: string[]) {
  const made = await t.api("POST", `/spaces/${t.space.id}/tool-policies`, t.ada.cookie, {
    name: "Sign-off",
    color: "orange",
    use: "none",
    users: [],
    approvers: [EDITORS],
    independent: false,
  });
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const set = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
    toolIds,
    policy: id,
  });
  expect(set.status).toBe(200);
}

async function scriptThread() {
  const tool = probe();
  // The tool that needs approval, counted as it runs.
  const [wait, guardedSpec, ...rest] = tool.toolset.tools;
  const guarded = vi.fn(guardedSpec!.run.bind(guardedSpec));
  // Tools that give back what they were given: one taking null where it may be left out, one
  // taking no keywords but its own, and two whose names differ only in a character Python refuses.
  const echo = (name: string, input: z.ZodType, inputSchema?: Record<string, unknown>) => ({
    name,
    description: "Gives back its input.",
    input,
    ...(inputSchema && { inputSchema }),
    risk: () => "normal" as const,
    run: async (given: unknown) => Promise.resolve({ ok: true as const, value: { name, given } }),
  });
  const echoes: AnyToolSpec[] = [
    echo("probe.echo", z.object({ a: z.string().nullable().optional(), b: z.string().optional() })),
    echo("probe.strict", z.record(z.string(), z.unknown()), {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    }),
    echo("probe.get-item", z.object({ id: z.string() })),
    echo("probe.get_item", z.object({ id: z.string() })),
  ];
  const toolset = {
    ...tool.toolset,
    tools: [wait!, { ...guardedSpec!, run: guarded }, ...rest, ...echoes],
  };
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

  it("calls each tool as a function by its name, with keywords, given what call_tool gives", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Both ways");
    const id = await t.script(
      [
        "import asyncio",
        'a, b = await asyncio.gather(probe__wait(label="a"), call_tool("probe__wait", {"label": "b"}))',
        "[a, b, a == b]",
      ].join("\n"),
    );
    await t.until(() => t.tool.running("a") && t.tool.running("b"));
    t.tool.finish("a", { n: [1, { m: 2 }] });
    t.tool.finish("b", { n: [1, { m: 2 }] });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":[{"n":[1,{"m":2}]},{"n":[1,{"m":2}]},true]}}',
    );
    const [, ...inner] = await t.calls();
    expect(inner).toEqual([
      expect.objectContaining({ toolId: "probe.wait", within: id, input: { label: "a" } }),
      expect.objectContaining({ toolId: "probe.wait", within: id, input: { label: "b" } }),
    ]);
  });

  it("fails a tool's function as call_tool fails with the same input, recording each call", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Wrongly");
    await t.script(
      [
        "cases = [",
        '  ("probe__wait", {"lable": "a"}, lambda: probe__wait(lable="a")),',
        '  ("probe__wait", {"label": 1}, lambda: probe__wait(label=1)),',
        '  ("probe__strict", {"a": "x", "b": 1}, lambda: probe__strict(a="x", b=1)),',
        '  ("probe__wiat", {"label": "a"}, lambda: probe__wiat(label="a")),',
        '  ("thread__ask", {"questions": []}, lambda: thread__ask(questions=[])),',
        '  ("scripts__run", {"code": "1"}, lambda: scripts__run(code="1")),',
        "]",
        "out = []",
        "for name, given, typed in cases:",
        "  pair = []",
        "  for go in [typed, lambda: call_tool(name, given)]:",
        "    try:",
        "      await go()",
        "    except Exception as e:",
        "      pair.append(type(e).__name__ + ': ' + str(e))",
        "  out.append(pair)",
        "out",
      ].join("\n"),
    );
    const next = await t.replies();
    await t.worker.idle();
    const said = JSON.parse(next.texts.at(-1)!.replace(/^result scripts.run: /, "")) as {
      value: { result: [string, string][] };
    };
    const pairs = said.value.result;
    for (const [typed, byName] of pairs) expect(typed).toBe(byName);
    const [keyword, value, strict, named, asks, script] = pairs.map(([typed]) => typed);
    expect(keyword).toMatch(/^ValueError: The input is not valid: .*\nprobe__wait\(label: str\)$/s);
    expect(value).toMatch(/^ValueError: The input is not valid: .*\nprobe__wait\(label: str\)$/s);
    expect(strict).toBe(
      "ValueError: probe__strict takes no argument b. Did you mean a?\nprobe__strict(a: str = None)",
    );
    expect(named).toBe(
      "NameError: No tool is named probe__wiat here. Did you mean:\nprobe__wait(label: str)",
    );
    expect(asks).toBe("PermissionError: thread__ask cannot be called from a script.");
    expect(script).toBe("PermissionError: A script cannot run another.");
    const rows = (await t.stored()).slice(1);
    expect(rows).toHaveLength(pairs.length * 2);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
  });

  it("refuses positional arguments, showing the signature, before any call", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Wrongly");
    await t.script('try:\n  await probe__wait("a")\nexcept TypeError as e:\n  r = str(e)\nr');
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain(
      '"result":"probe__wait takes its input as keyword arguments: probe__wait(label: str)"',
    );
    expect((await t.stored()).map((row) => row.tool_id)).toEqual(["scripts.run"]);
  });

  it("leaves Python's NameError for a name not shaped as a tool's", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Typo");
    await t.script("result = 1\nresul + e");
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("NameError: name 'resul' is not defined");
    expect((await t.stored()).map((row) => row.tool_id)).toEqual(["scripts.run"]);
  });

  it("sends None as null where the schema takes null, and leaves it out where it does not", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Nothing");
    await t.script(
      '[(await probe__echo(a=None, b=None))["given"], (await call_tool("probe__echo", {"a": None}))["given"]]',
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain('"result":[{"a":null},{"a":null}]');
  });

  it("gives tools whose names differ only where Python refuses a function each", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Both");
    await t.script(
      [
        'names = sorted(await list_tools("get_item"))',
        "out = []",
        "for n in names:",
        "  out.append([n, await describe_tool(n)])",
        'out.append((await probe__get_item(id="1"))["name"])',
        "out",
      ].join("\n"),
    );
    const next = await t.replies();
    await t.worker.idle();
    const said = JSON.parse(next.texts.at(-1)!.replace(/^result scripts.run: /, "")) as {
      value: { result: unknown[] };
    };
    const [first, second, plain] = said.value.result as [
      [string, string],
      [string, string],
      string,
    ];
    expect(first[0]).toBe("probe__get_item");
    expect(second[0]).toMatch(/^probe__get_item_[0-9a-f]{6}$/);
    expect(second[1]).toBe(`${second[0]}(id: str)`);
    expect(plain).toBe("probe.get_item");
  });

  it("refuses inputs named as the script's functions", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Shadow");
    await t.script("1", { probe__wait: 1 });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("Input names must not be those of tools' functions");
    await t.post(t.ada, "Again");
    await t.script("1", { list_tools: 1 });
    const again = await t.replies();
    await t.worker.idle();
    expect(again.texts.at(-1)).toContain("Input names must be Python identifiers");
  });

  it("lists and describes every tool it may call, MCP tools not on yet among them, making no calls", async () => {
    const t = await scriptThread();
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
    await t.post(t.ada, "What is there");
    await t.script(
      `[await list_tools(), await list_tools("GUARD"), await describe_tool("probe__wait"), await describe_tool("${mcp}")]`,
    );
    const call = await t.replies();
    await t.worker.idle();
    const said = JSON.parse(call.texts.at(-1)!.replace(/^result scripts.run: /, "")) as {
      value: { result: [string[], string[], string, string] };
    };
    const [all, guarded, wait, fromServer] = said.value.result;
    expect(all).toEqual(expect.arrayContaining(["probe__wait", "probe__guarded", mcp]));
    // Not those a script cannot call.
    expect(all).not.toContain("scripts__run");
    expect(all).not.toContain("thread__ask");
    expect(guarded).toEqual(["probe__guarded", "probe__guarded_wait"]);
    expect(wait).toBe("probe__wait(label: str)");
    expect(fromServer.startsWith(`${mcp}(`)).toBe(true);
    expect((await t.stored()).map((row) => row.tool_id)).toEqual(["scripts.run"]);
  });

  it("tells the model each tool's signature, the same at every step", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Look");
    const first = await t.model.next();
    const { instructions } = first.request;
    first.startStep();
    first.toolCall("s1", "scripts.run", { code: "1" });
    first.endStep();
    first.end();
    const second = await t.replies();
    await t.worker.idle();
    expect(instructions).toContain("probe__wait(label: str)\nprobe__guarded(label: str)\n");
    expect(instructions).toContain("list_tools(query=None)");
    expect(instructions).not.toContain("scripts__run(");
    expect(second.request.instructions).toBe(instructions);
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
    // What it printed, just before it paused too, stays for those watching while it waits.
    expect(await t.shown(id)).toBe("before\n");
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
    expect(await t.shown(id)).toBe("");
  });

  it("calls tools by name after it pauses, whether it looked them up before or after", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Try it");
    await t.script(
      [
        "w = probe__wait",
        'r = await probe__guarded(label="x")',
        'a = await w(label=r["did"])',
        'b = await probe__wait(label="y")',
        '[a, b, await describe_tool("probe__guarded"), await list_tools("guarded_w")]',
      ].join("\n"),
    );
    await t.worker.idle();
    const [, inner] = await t.calls();
    expect((await t.decide(inner!.id, true)).status).toBe(200);
    await t.until(() => t.tool.running("x"));
    t.tool.finish("x", 1);
    await t.until(() => t.tool.running("y"));
    t.tool.finish("y", 2);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":[1,2,"probe__guarded(label: str)",["probe__guarded_wait"]]}}',
    );
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "completed"],
      ["probe.guarded", "completed"],
      ["probe.wait", "completed"],
      ["probe.wait", "completed"],
    ]);
  });

  it("raises PermissionError at a call that was denied, which it can catch, by either form", async () => {
    for (const call of [
      'await call_tool("probe__guarded", {"label": "x"})',
      'await probe__guarded(label="x")',
    ]) {
      const t = await scriptThread();
      await t.post(t.ada, "Try it");
      await t.script(`try:\n  ${call}\nexcept PermissionError as e:\n  r = str(e)\nr`);
      await t.worker.idle();
      const [, inner] = await t.calls();
      expect((await t.decide(inner!.id, false)).status).toBe(200);
      const next = await t.replies();
      await t.worker.idle();
      expect(next.texts.at(-1)).toContain('"result":"probe__guarded was denied."');
      expect(t.guarded).not.toHaveBeenCalled();
      expect((await t.stored()).map((row) => row.status)).toEqual(["completed", "denied"]);
    }
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
    // Recorded in the order the script made them.
    const [, ...inner] = await t.calls();
    expect(inner.map((row) => row.input)).toEqual(labels.map((label) => ({ label })));
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
    expect(next.texts.at(-1)).toContain("are awaitable: write `await name(...)`");
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

  it("calls an MCP server's tool the thread has not turned on, as a function and by call_tool", async () => {
    const t = await scriptThread();
    const { mcp, echo } = await mcpEcho(t);
    await t.post(t.ada, "Try it");
    await t.script(
      `a = await ${mcp}(text="a")\nb = await call_tool("${mcp}", {"text": "b"})\n[a, b]`,
    );
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain('"ok":true');
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "completed"],
      [echo, "completed"],
      [echo, "completed"],
    ]);
    // The script's call is enough: the thread's agent has not turned it on.
    expect(await t.tools.turnedOn(t.thread.id)).toEqual([]);
  });

  it("refuses a tool that is off, and holds an MCP server's tool not turned on to its policy", async () => {
    const t = await scriptThread();
    const off = await t.api("PATCH", `/spaces/${t.space.id}/tools`, t.ada.cookie, {
      toolIds: ["probe.guarded"],
      policy: TOOL_OFF,
    });
    expect(off.status).toBe(200);
    const { mcp, echo } = await mcpEcho(t);
    await signOff(t, [echo]);
    await t.post(t.ada, "Try them");
    await t.script(
      [
        "out = []",
        "try:",
        '  await call_tool("probe__guarded", {})',
        "except NameError as e:",
        "  out.append(str(e))",
        `out.append(await call_tool("${mcp}", {"text": "hi"}))`,
        "len(out)",
      ].join("\n"),
    );
    await t.worker.idle();
    const waiting = (await t.calls()).find((row) => row.toolId === echo);
    expect(waiting).toMatchObject({ state: "waiting" });
    expect((await t.decide(waiting!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe('result scripts.run: {"ok":true,"value":{"result":2}}');
    expect((await t.stored()).map((row) => [row.tool_id, row.status])).toEqual([
      ["scripts.run", "completed"],
      ["probe__guarded", "failed"],
      [echo, "completed"],
    ]);
  });
});

describe("a script run by its file", () => {
  // A thread whose space learned a skill with two scripts and a note.
  async function learnedThread() {
    const t = await scriptThread();
    const space = (await t.spaceStore.find(t.space.id))!;
    let saved = 0;
    const learn = async (code: string, update = false) =>
      t.skills.learn(
        {
          orgId: space.orgId,
          spaceId: space.id,
          threadId: t.thread.id,
          callId: `learn-${(saved += 1)}`,
          influence: [],
          approvedBy: t.ada.userId,
        },
        {
          name: "doubler",
          description: "Doubles a number",
          instructions: "Run double.py.",
          files: [
            { path: "double.py", text: code },
            { path: "notes.md", text: "# Notes" },
            { path: "lib/half.py", text: "n / 2" },
          ],
          ...(update && { update }),
        },
      );
    await learn('print("doubling")\nn * 2');
    let asked = 0;
    // The model's next call, of the tool by its id, with the input given.
    async function asks(toolId: string, input: Record<string, unknown>) {
      const call = await t.model.next();
      call.startStep();
      call.toolCall(`f${(asked += 1)}`, toolId, input);
      call.endStep();
      call.end();
    }
    return { ...t, space, learn, asks };
  }

  it("runs a learned skill's script as if its code were given, recording the code it ran", async () => {
    const t = await learnedThread();
    await t.post(t.ada, "Double 21");
    await t.asks("scripts.run", { file: "doubler/double.py", inputs: { n: 21 } });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toBe(
      'result scripts.run: {"ok":true,"value":{"result":42,"printed":"doubling\\n"}}',
    );
    // The model reads its call as it sent it, without the code read for it.
    expect(next.texts.at(-2)).toBe(
      'tool scripts.run: {"file":"doubler/double.py","inputs":{"n":21}}',
    );
    const recorded = {
      file: "doubler/double.py",
      code: 'print("doubling")\nn * 2',
      inputs: { n: 21 },
    };
    const [script] = await t.calls();
    expect(script).toMatchObject({ toolId: "scripts.run", state: "completed", input: recorded });
    // A later edit of the skill leaves what ran as it was.
    expect((await t.learn("n * 3", true)).ok).toBe(true);
    const [after] = await t.calls();
    expect(after!.input).toEqual(recorded);
    // A summary of the thread reads the call as the model sent it.
    const text = conversationText(transcriptOf(await t.events()).rows);
    expect(text).toContain('{"file":"doubler/double.py","inputs":{"n":21}}');
    expect(text).not.toContain("n * 2");
  });

  it("runs the code it read when asked for once approved, though the skill changed meanwhile", async () => {
    const t = await learnedThread();
    await signOff(t, ["scripts.run"]);
    await t.post(t.ada, "Double 21");
    await t.asks("scripts.run", { file: "doubler/double.py", inputs: { n: 21 } });
    await t.worker.idle();
    const [script] = await t.calls();
    expect(script).toMatchObject({ state: "waiting" });
    expect((await t.learn("n * 3", true)).ok).toBe(true);
    expect((await t.decide(script!.id, true)).status).toBe(200);
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain('"result":42');
  });

  it("in the background runs the code it read when started once approved, though the skill changed meanwhile", async () => {
    const t = await learnedThread();
    await signOff(t, ["scripts.run"]);
    await t.post(t.ada, "Double 21 in the background");
    await t.asks("jobs.start", {
      tool: "scripts__run",
      input: { file: "doubler/double.py", inputs: { n: 21 } },
    });
    await t.replies("Started.");
    await t.worker.idle();
    const job = (await t.calls()).find((row) => row.toolId === "scripts.run");
    expect(job).toMatchObject({ state: "waiting" });
    expect((await t.learn("n * 3", true)).ok).toBe(true);
    expect((await t.decide(job!.id, true)).status).toBe(200);
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":42');
  });

  it("refuses an empty script by its file", async () => {
    const t = await learnedThread();
    expect((await t.learn("\n", true)).ok).toBe(true);
    await t.post(t.ada, "Double");
    await t.asks("scripts.run", { file: "doubler/double.py" });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("doubler/double.py is empty.");
  });

  it("runs one in the background by its file, recording its code", async () => {
    const t = await learnedThread();
    await t.post(t.ada, "Halve 8 in the background");
    await t.asks("jobs.start", {
      tool: "scripts__run",
      input: { file: "doubler/lib/half.py", inputs: { n: 8 } },
    });
    await t.replies("Started.");
    const told = await t.replies("Done.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain('"result":4');
    const job = (await t.calls()).find((row) => row.toolId === "scripts.run");
    expect(job!.input).toEqual({ file: "doubler/lib/half.py", code: "n / 2", inputs: { n: 8 } });
  });

  it("refuses what is not a learned skill's .py file, naming those that run", async () => {
    const t = await learnedThread();
    const these = "Those here: doubler/double.py, doubler/lib/half.py.";
    await t.post(t.ada, "Run the notes");
    await t.asks("scripts.run", { file: "doubler/notes.md" });
    const notes = await t.replies();
    await t.worker.idle();
    expect(notes.texts.at(-1)).toContain(`Only learned skills' .py files run by file. ${these}`);
    await t.post(t.ada, "Run the palette");
    await t.asks("scripts.run", { file: "charts/palette.md" });
    const builtin = await t.replies();
    await t.worker.idle();
    expect(builtin.texts.at(-1)).toContain(`Only learned skills' .py files run by file. ${these}`);
    expect((await t.stored()).map((row) => row.status)).toEqual(["failed", "failed"]);
  });

  it("gives the files nearest a name no file has", async () => {
    const t = await learnedThread();
    await t.post(t.ada, "Double");
    await t.asks("scripts.run", { file: "doubler/dobule.py" });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain(
      "No skill file doubler/dobule.py is on here. Did you mean: doubler/double.py",
    );
  });

  it("refuses the file of a learned skill switched off, and code given with a file", async () => {
    const t = await learnedThread();
    const skill = (await t.skills.effectiveIn(t.space)).find((one) => one.name === "doubler");
    const off = await t.api("PUT", `/skills/${skill!.id}/enabled`, t.ada.cookie, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    await t.post(t.ada, "Double");
    await t.asks("scripts.run", { file: "doubler/double.py", inputs: { n: 1 } });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain("No skill file doubler/double.py is on here.");
    await t.post(t.ada, "Both");
    await t.asks("scripts.run", { file: "doubler/double.py", code: "1" });
    const both = await t.replies();
    await t.worker.idle();
    expect(both.texts.at(-1)).toContain("Give the code or a file, not both.");
  });

  it("is named, with how to run it, when its skill loads", async () => {
    const t = await learnedThread();
    await t.post(t.ada, "Load it");
    await t.asks("skills.load", { name: "doubler" });
    const next = await t.replies();
    await t.worker.idle();
    expect(next.texts.at(-1)).toContain(
      'Run each with scripts__run by file, its values in inputs: file=\\"doubler/double.py\\", file=\\"doubler/lib/half.py\\".',
    );
  });
});

describe("the scripts guidance", () => {
  it("tells the agent every tool is callable by name, and a learned skill's script runs by file", async () => {
    const t = await agentThread();
    await t.start();
    await t.post(t.ada, "Hi");
    const call = await t.model.next();
    const { instructions } = call.request;
    call.reply("Hi.");
    await t.worker.idle();
    expect(instructions).toContain(
      "- Every tool here, MCP tools among them, is callable from a script by name, without searching for it or turning it on first; search only to find a tool you don't know.",
    );
    expect(instructions).toContain(
      '- A learned skill\'s script runs by its file, `file="<skill>/<path>"` in place of `code`, with its values in `inputs`.',
    );
  });

  it("keeps the signatures within their size, counting every tool it cannot show", async () => {
    const many: AnyToolSpec[] = Array.from({ length: 150 }, (_, i) => ({
      name: `bulk.tool_${i}`,
      description: "One of many.",
      input: z.object({
        first_parameter: z.string(),
        second_parameter: z.number().optional(),
        third_parameter: z.array(z.string()).optional(),
      }),
      risk: () => "normal" as const,
      run: async () => Promise.resolve({ ok: true as const, value: i }),
    }));
    const t = await agentThread(
      {},
      { toolsets: [{ id: "bulk", title: "Bulk", source: "builtin" as const, tools: many }] },
    );
    await t.start();
    await t.post(t.ada, "How many");
    const call = await t.model.next();
    const { instructions } = call.request;
    call.startStep();
    call.toolCall("s1", "scripts.run", { code: "len(await list_tools())" });
    call.endStep();
    call.end();
    const next = await t.model.next();
    next.reply("Done.");
    await t.worker.idle();
    const total = Number(/"result":(\d+)/.exec(next.texts.at(-1)!)![1]);
    const heading = "Tools as a script calls them:\n";
    const section = instructions
      .slice(instructions.indexOf(heading) + heading.length)
      .split("\n\n")[0]!;
    expect(section.length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    const lines = section.split("\n");
    const more = /^\+(\d+) more.*\(list_tools\(\)\)$/.exec(lines.at(-1)!);
    expect(more).not.toBeNull();
    expect(lines.length - 1 + Number(more![1])).toBe(total);
  });
});

describe("a page of a script's rows", () => {
  it("comes with the calls above it that made calls in it, alone, from three levels down", async () => {
    const t = await scriptThread();
    await t.post(t.ada, "Many");
    const id = await t.script(
      [
        "for i in range(100):",
        '    await call_tool("probe__echo", {"a": "x"})',
        'await call_tool("jobs__start", {"tool": "probe__wait", "input": {"label": "a"}})',
        '"started"',
      ].join("\n"),
    );
    await t.until(() => t.tool.running("a"));
    await t.replies();
    await t.worker.idle();
    const read = async (path: string) =>
      (await (await t.api("GET", path, t.ada.cookie)).json()) as {
        rows: { id: string; order: number; toolId?: string }[];
        callers?: { id: string }[];
        before: number | null;
        thread: { lastEventSeq: number };
      };
    const first = await read(`/threads/${t.thread.id}`);
    expect(
      (
        await t.api("PUT", `/threads/${t.thread.id}/read`, t.ada.cookie, {
          seq: first.thread.lastEventSeq,
        })
      ).status,
    ).toBe(200);
    const newest = await read(`/threads/${t.thread.id}`);
    expect(newest.rows).toHaveLength(60);
    // The script is far above the page: it comes alone, not the rows between.
    expect(newest.callers?.map((row) => row.id)).toEqual([id]);
    const job = newest.rows.find((row) => row.toolId === "probe.wait")!;
    const start = newest.rows.find((row) => row.toolId === "jobs.start")!;
    const deep = await read(`/threads/${t.thread.id}/rows?before=${job.order + 1}&limit=1`);
    expect(deep.rows.map((row) => row.id)).toEqual([job.id]);
    expect(deep.callers?.map((row) => row.id)).toEqual([id, start.id]);
    const older = await read(`/threads/${t.thread.id}/rows?before=${newest.before}&limit=20`);
    expect(older.callers?.map((row) => row.id)).toEqual([id]);
    const reaching = await read(
      `/threads/${t.thread.id}/rows?before=${newest.before}&limit=5&at=${older.rows[3]!.id}`,
    );
    expect(reaching.rows[0]!.id).toBe(older.rows[3]!.id);
    expect(reaching.callers?.map((row) => row.id)).toEqual([id]);
    const whole = await read(`/threads/${t.thread.id}/rows?before=${newest.before}`);
    expect(whole.rows.some((row) => row.id === id)).toBe(true);
    expect(whole.callers).toBeUndefined();
    t.tool.finish("a", 1);
    await t.replies();
    await t.worker.idle();
  });
});

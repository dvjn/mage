import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { expireLeases } from "@/server/testing/database.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { BACKGROUND_LIMIT } from "@/shared/jobs.ts";
import type { ThreadFollowItem } from "@/server/views/thread.ts";
import type { LiveChunk } from "@/shared/threads/events.ts";
import { EDITORS } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import type { LiveReporter } from "@/server/calls/live.ts";
import type { ToolSpec } from "@/server/tools/registry.ts";

// A tool that runs until the test finishes it, by the label of its call.
function probe() {
  const open = new Map<string, (output: { ok: true; value: unknown }) => void>();
  const aborted: string[] = [];
  const printing = new Map<string, LiveReporter>();
  const wait: ToolSpec<{ label: string }> = {
    name: "probe.wait",
    title: "Wait",
    description: "Waits.",
    input: z.object({ label: z.string() }),
    risk: () => "normal",
    run({ label }, ctx) {
      return new Promise((resolve) => {
        open.set(label, resolve);
        if (ctx.live) printing.set(label, ctx.live);
        ctx.signal?.addEventListener("abort", () => {
          aborted.push(label);
          resolve({ ok: false, error: "aborted" });
        });
      });
    },
  };
  return {
    toolset: { id: "probe", title: "Probe", source: "builtin" as const, tools: [wait] },
    aborted,
    // What the call with the label reports with while it runs.
    live: (label: string) => printing.get(label)!,
    // Whether the call with the label has started running.
    running: (label: string) => open.has(label),
    finish(label: string, value: unknown) {
      open.get(label)?.({ ok: true, value });
    },
  };
}

async function callThread() {
  const tool = probe();
  const workspace = await agentThread({}, { toolsets: [tool.toolset] });
  const { model, events, thread, api, ada, worker } = workspace;
  // The model's next call, asking for the tool calls in one step.
  async function asks(...asked: [string, unknown][]): Promise<Call> {
    const call = await model.next();
    call.startStep();
    call.delta("On it.");
    for (const [index, [toolId, input]] of asked.entries()) {
      call.toolCall(`call-${model.calls.length}-${index}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }
  async function replies(text = "Done.") {
    const call = await model.next();
    call.reply(text);
    return call;
  }
  async function rows() {
    return transcriptOf(await events()).rows;
  }
  async function tools() {
    return (await rows()).filter((row) => row.kind === "tool");
  }
  async function records() {
    return (
      await workspace.db.execute<{ id: string; status: string; tool_id: string }>(
        "select id, status, tool_id from call where background order by id",
      )
    ).rows;
  }
  async function until(condition: () => boolean | Promise<boolean>) {
    for (let tries = 0; !(await condition()); tries++) {
      if (tries > 2000) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  // How many of the run's calls are running.
  async function running() {
    const rows = await workspace.db.execute<{ count: number }>(
      "select count(*)::int as count from call where status = 'running' and not background",
    );
    return rows.rows[0]?.count ?? 0;
  }
  function callApi(path: string, who: { cookie: string } = ada, body?: object) {
    return api("POST", `/threads/${thread.id}/tools/${path}`, who.cookie, body);
  }
  return {
    ...workspace,
    tool,
    asks,
    replies,
    rows,
    tools,
    records,
    until,
    running,
    callApi,
    worker,
  };
}

describe("background calls", () => {
  it("start at once, run on, and tell the agent their result when they end", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    const started = await t.replies("Started.");
    await t.worker.idle();

    // The run went on without the tool, which is still running.
    expect(started.texts.at(-1)).toMatch(/^result jobs\.start: .*"status":"running"/);
    const [record] = await t.records();
    expect(record).toMatchObject({ status: "running", tool_id: "probe.wait" });
    expect(
      (await t.tools()).map((row) => `${row.toolId} ${row.state}${row.background ? " bg" : ""}`),
    ).toEqual(["jobs.start completed", "probe.wait ready bg"]);

    t.tool.finish("a", { answer: 42 });
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain(`Background call ${record!.id} (Wait) finished`);
    expect(told.texts.at(-1)).toContain('Result:\n\n{"answer":42}');
    expect((await t.records())[0]).toMatchObject({ status: "completed" });
    expect((await t.tools()).map((row) => `${row.toolId} ${row.state}`)).toEqual([
      "jobs.start completed",
      "probe.wait completed",
    ]);
  });

  it("are checked, listed and cancelled by id, and a cancelled one tells nobody", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = (await t.records())[0]!;

    await t.post(t.ada, "Check");
    await t.asks(["jobs.check", { id }], ["jobs.list", {}], ["jobs.cancel", { id }]);
    const next = await t.replies("Cancelled.");
    await t.worker.idle();

    expect(next.texts.join("\n")).toContain(`"id":"${id}"`);
    // Status and list name the tool as the model calls it.
    const [checked, listed] = next.texts.slice(-3);
    for (const text of [checked!, listed!]) {
      expect(text).toContain('"tool":"probe__wait"');
      expect(text).not.toContain("probe.wait");
    }
    expect(t.tool.aborted).toEqual(["a"]);
    expect((await t.records())[0]).toMatchObject({ status: "cancelled" });
    expect((await t.rows()).filter((row) => row.kind === "notice")).toEqual([]);
    expect((await t.tools()).find((row) => row.toolId === "probe.wait")).toMatchObject({
      state: "cancelled",
    });
  });

  it("refuse tools that ask and calls of their own", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Go");
    await t.asks(
      ["jobs.start", { tool: "thread.ask", input: { questions: [] } }],
      ["jobs.start", { tool: "jobs.list", input: {} }],
      ["jobs.start", { tool: "probe.wait", input: {} }],
    );
    const refused = await t.replies("No.");
    await t.worker.idle();
    expect(refused.texts.join("\n")).toContain("cannot run in the background");
    expect(refused.texts.join("\n")).toContain("cannot start another");
    expect(refused.texts.join("\n")).toContain("The input is not valid");
  });

  it("queue past the thread's limit, start in turn as places free, and are cancelled while queued", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Many");
    await t.asks(
      ...Array.from({ length: BACKGROUND_LIMIT }, (_, index): [string, unknown] => [
        "jobs.start",
        { tool: "probe.wait", input: { label: `l${index}` } },
      ]),
      ["jobs.start", { tool: "probe.wait", input: { label: "first" } }],
      ["jobs.start", { tool: "probe.wait", input: { label: "second" } }],
    );
    const told = await t.replies("Started.");
    await t.worker.idle();
    expect(told.texts.filter((text) => text.includes('"status":"queued"'))).toHaveLength(2);
    expect(told.texts.at(-1)).toContain(`${BACKGROUND_LIMIT} background calls running;`);
    const statuses = async () => (await t.records()).map((record) => record.status).toSorted();
    expect(await statuses()).toEqual([
      "ready",
      "ready",
      ...Array(BACKGROUND_LIMIT).fill("running"),
    ]);
    const ids = (await t.tools()).filter((row) => row.background).map((row) => row.id);
    const [first, second] = ids.slice(-2);
    // The tray says they are queued, and they may be cancelled.
    const tray = (await (
      await t.api("GET", `/threads/${t.thread.id}/activity`, t.ada.cookie)
    ).json()) as { items: { rowId: string; work: { status: string; canCancel: boolean } }[] };
    expect(tray.items.filter((item) => [first, second].includes(item.rowId))).toEqual([
      expect.objectContaining({
        work: expect.objectContaining({ status: "queued", canCancel: true }),
      }),
      expect.objectContaining({
        work: expect.objectContaining({ status: "queued", canCancel: true }),
      }),
    ]);

    // A place frees: the older of the two starts, the other waits on.
    t.tool.finish("l0", "done");
    await t.until(() => t.tool.running("first"));
    expect(t.tool.running("second")).toBe(false);
    await t.replies("Noted.");
    await t.worker.idle();

    expect((await t.callApi(`${second}/cancel`)).status).toBe(200);
    expect((await t.records()).find((record) => record.id === second)).toMatchObject({
      status: "cancelled",
    });
  });

  it("waiting for approval hold no place, and once approved with none free wait their turn", async () => {
    const t = await callThread();
    const policy = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    const startAll = async (prefix: string) => {
      await t.post(t.ada, `Start ${prefix}`);
      await t.asks(
        ...Array.from({ length: BACKGROUND_LIMIT }, (_, index): [string, unknown] => [
          "jobs.start",
          { tool: "probe.wait", input: { label: `${prefix}${index}` } },
        ]),
      );
      await t.replies("Started.");
      await t.worker.idle();
    };
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    await t.start();
    await startAll("w");
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], null);
    // Eight wait on a person, and eight more all run.
    await startAll("l");
    const count = async (status: string) =>
      (await t.records()).filter((record) => record.status === status).length;
    expect([await count("waiting"), await count("running")]).toEqual([
      BACKGROUND_LIMIT,
      BACKGROUND_LIMIT,
    ]);
    // One approved while all places are taken waits its turn, then starts when one frees.
    const first = (await t.tools()).find((row) => row.state === "waiting")!;
    expect(
      (await t.callApi(`${first.id}/decision`, t.ada, { allow: true, scope: "once" })).status,
    ).toBe(200);
    await t.calls.beat();
    expect((await t.records()).find((record) => record.id === first.id)).toMatchObject({
      status: "ready",
    });
    t.tool.finish("l0", "done");
    await t.until(
      async () => (await t.records()).find((r) => r.id === first.id)?.status === "running",
    );
    await t.replies("Noted.");
    await t.worker.idle();
  });

  it("start after those already waiting their turn, even with a place free", async () => {
    const t = await callThread();
    const policy = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    await t.start();
    await t.post(t.ada, "Ask");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "approved" } }]);
    await t.replies("Asked.");
    await t.worker.idle();
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], null);
    // Approved while no sweep runs, it waits its turn; one asked for next goes behind it.
    await t.calls.stop();
    const [waiting] = await t.records();
    expect(
      (await t.callApi(`${waiting!.id}/decision`, t.ada, { allow: true, scope: "once" })).status,
    ).toBe(200);
    await t.post(t.ada, "Another");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "later" } }]);
    const told = await t.replies("Asked.");
    expect(told.texts.at(-1)).toContain('"status":"queued"');
    await t.start();
    await t.calls.beat();
    await t.until(() => t.tool.running("approved") && t.tool.running("later"));
  });

  it("waiting their turn in a space since archived go stale, and the agent is told", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Many");
    await t.asks(
      ...Array.from({ length: BACKGROUND_LIMIT + 1 }, (_, index): [string, unknown] => [
        "jobs.start",
        { tool: "probe.wait", input: { label: `l${index}` } },
      ]),
    );
    await t.replies("Started.");
    await t.worker.idle();
    await t.db.execute(sql`update space set archived_at = now() where id = ${t.space.id}`);
    t.tool.finish("l0", "done");
    const told = await t.replies("Noted.");
    await t.until(async () => (await t.records()).some((record) => record.status === "stale"));
    expect(
      told.texts.join("\n") + (await t.events()).map((e) => JSON.stringify(e.data)).join(),
    ).toContain("its space is archived");
  });

  it("wait as calls of their own for the tool's usual approval, which the run does not wait on", async () => {
    const t = await callThread();
    const policy = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();

    const { id } = (await t.records())[0]!;
    expect((await t.records())[0]).toMatchObject({ status: "waiting" });
    expect((await t.tools()).at(-1)).toMatchObject({
      id,
      state: "waiting",
      waits: true,
      background: true,
    });
    // The run ended; the decision is the existing one.
    expect((await t.callApi(`${id}/decision`, t.alan, { allow: true, scope: "once" })).status).toBe(
      403,
    );
    expect((await t.callApi(`${id}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    await t.until(() => t.tool.running("a"));

    t.tool.finish("a", "ok");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("finished");
    expect((await t.tools()).at(-1)).toMatchObject({
      state: "completed",
      decision: { allow: true },
    });
  });

  it("end as denied when the approval is refused, telling the agent", async () => {
    const t = await callThread();
    const policy = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = (await t.records())[0]!;
    expect((await t.callApi(`${id}/decision`, t.ada, { allow: false, scope: "once" })).status).toBe(
      200,
    );
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain(`Background call ${id} (Wait) was denied.`);
    expect((await t.records())[0]).toMatchObject({ status: "denied" });
  });

  it("move from a run that waits on a running call, which carries on and tells the agent when done", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["probe.wait", { label: "a" }]);
    // Running, as its row says once the tool has begun.
    await t.until(async () => (await t.running()) > 0);
    const callId = (await t.tools())[0]!.id;

    // Only a call that is running, and not for someone who cannot post.
    expect((await t.callApi(`${callId}/background`, t.alan)).status).toBe(403);
    expect((await t.callApi(`${callId}/background`)).status).toBe(200);
    const carried = await t.replies("Carrying on.");
    await t.worker.idle();
    // It goes on as a job under its own id, on its own row, asked for once.
    const job = (await t.records())[0]!;
    expect(job).toMatchObject({ id: callId, status: "running" });
    expect(carried.texts.at(-1)).toBe(
      `result probe.wait: {"ok":true,"value":{"movedToBackground":true,"callId":"${callId}"}}`,
    );
    expect((await t.tools()).map((row) => `${row.state}${row.background ? " bg" : ""}`)).toEqual([
      "ready bg",
    ]);
    expect((await t.events()).filter((event) => event.type === "tool.requested")).toHaveLength(1);
    // The run is over; the call is not.
    expect((await t.runs()).map((run) => run.status)).toEqual(["completed"]);
    expect((await t.callApi(`${callId}/background`)).status).toBe(409);

    t.tool.finish("a", "late");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("Result:\n\nlate");
    expect((await t.records())[0]).toMatchObject({ status: "completed" });
    // What it gave back is in the log, on its one row, while the turn that asked still reads it
    // as moved.
    expect(await t.tools()).toMatchObject([
      { id: callId, state: "completed", output: { ok: true, value: "late" } },
    ]);
    expect(told.texts).toContain(
      `result probe.wait: {"ok":true,"value":{"movedToBackground":true,"callId":"${callId}"}}`,
    );
  });

  it("move from a run that waits for a decision, which stays decidable as a call of its own", async () => {
    const t = await callThread();
    const policy = await t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    await t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["probe.wait", { label: "a" }]);
    await t.worker.idle();
    const callId = (await t.tools())[0]!.id;
    expect((await t.tools())[0]).toMatchObject({ state: "waiting" });

    expect((await t.callApi(`${callId}/background`)).status).toBe(200);
    const carried = await t.replies("Carrying on.");
    await t.worker.idle();
    const record = (await t.records())[0]!;
    expect(record).toMatchObject({ id: callId, status: "waiting" });
    expect(carried.texts.at(-1)).toBe(
      `result probe.wait: {"ok":true,"value":{"movedToBackground":true,"callId":"${callId}"}}`,
    );
    expect((await t.tools()).map((row) => `${row.state}${row.background ? " bg" : ""}`)).toEqual([
      "waiting bg",
    ]);

    expect(
      (await t.callApi(`${record.id}/decision`, t.ada, { allow: true, scope: "once" })).status,
    ).toBe(200);
    await t.until(() => t.tool.running("a"));
    t.tool.finish("a", "ok");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("finished");
  });

  it("are interrupted, with the agent told, when a stopped server left them running", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    expect((await t.records())[0]).toMatchObject({ status: "running" });

    // Held here, it is left be until its lease runs out, as when this server stopped.
    await t.calls.recover();
    expect((await t.records())[0]).toMatchObject({ status: "running" });
    await expireLeases(t.db, "call");
    await t.calls.recover();
    const told = await t.replies("Noted.");
    await t.worker.idle();
    const { id } = (await t.records())[0]!;
    expect(told.texts.at(-1)).toContain(`Background call ${id} (Wait) was interrupted`);
    expect((await t.records())[0]).toMatchObject({ status: "interrupted" });
    expect((await t.tools()).at(-1)).toMatchObject({ state: "failed" });
  });

  it("show as cards with their status, and stop when cancelled by a person", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = (await t.records())[0]!;

    const shown = async () => {
      const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
      const body = (await res.json()) as { rows: { id: string; work?: unknown }[] };
      return body.rows.find((row) => row.id === id)?.work;
    };
    expect(await shown()).toMatchObject({ kind: "job", status: "running", canCancel: true });
    expect((await t.callApi(`${id}/cancel`, t.alan)).status).toBe(403);
    expect((await t.callApi(`${id}/cancel`)).status).toBe(200);
    expect(await shown()).toMatchObject({ kind: "job", status: "cancelled", canCancel: false });
    expect((await t.callApi(`${id}/cancel`)).status).toBe(409);
  });

  it("print for those who follow the thread, and give someone who comes later the end", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = (await t.records())[0]!;
    const asAda = { userId: t.ada.userId, orgId: t.ada.orgId, role: "member" as const };
    const chunksOf = (sent: ThreadFollowItem[]) =>
      sent.flatMap((item): LiveChunk[] => (item.kind === "live" ? [item.live] : []));

    const early: ThreadFollowItem[] = [];
    const { stop: stopEarly } = await t.views.thread.follow(
      asAda,
      t.thread.id,
      Number.MAX_SAFE_INTEGER,
      (item) => item !== "ended" && early.push(item),
    );
    t.tool.live("a").output("one\n");
    t.tool.live("a").progress({ progress: 1, total: 2, message: "Half" });
    await t.until(() => chunksOf(early).some((chunk) => chunk.progress));
    expect(chunksOf(early)[0]).toEqual({ callId: id, offset: 0, text: "one\n", from: 0 });
    expect(chunksOf(early).at(-1)!.progress).toEqual({ progress: 1, total: 2, message: "Half" });

    // Someone who starts following now gets what was printed so far, once.
    const late: ThreadFollowItem[] = [];
    const { stop: stopLate } = await t.views.thread.follow(
      asAda,
      t.thread.id,
      Number.MAX_SAFE_INTEGER,
      (item) => item !== "ended" && late.push(item),
    );
    await t.until(() => chunksOf(late).length > 0);
    expect(chunksOf(late)).toEqual([
      {
        callId: id,
        offset: 0,
        text: "one\n",
        from: 0,
        progress: { progress: 1, total: 2, message: "Half" },
      },
    ]);
    t.tool.live("a").output("two\n");
    await t.until(() => chunksOf(late).length === 2);
    expect(chunksOf(late)[1]).toMatchObject({ offset: 4, text: "two\n" });

    // The agent may check on it; once it ends, nothing of it is kept.
    await t.post(t.ada, "Check");
    await t.asks(["jobs.check", { id }]);
    const checked = await t.replies("Still going.");
    await t.worker.idle();
    expect(checked.texts.join("\n")).toContain('"output":"one\\ntwo\\n"');
    expect(checked.texts.join("\n")).toContain('"progress":{"progress":1,"total":2');
    t.tool.finish("a", "ok");
    await t.replies("Noted.");
    await t.worker.idle();
    expect(await t.live.inThread(t.thread.id)).toEqual([]);
    expect((await t.db.execute("select * from call_output")).rows).toEqual([]);
    stopEarly();
    stopLate();
  });

  it("keep what a call printed as it moves to the background, and drop it once it is stopped", async () => {
    const t = await callThread();
    await t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["probe.wait", { label: "a" }]);
    // Running, as its row says once the tool has begun.
    await t.until(async () => (await t.running()) > 0);
    const callId = (await t.tools())[0]!.id;
    await t.until(() => !!t.tool.live("a"));
    t.tool.live("a").output("before\n");
    await t.until(async () => (await t.live.inThread(t.thread.id)).length === 1);

    expect((await t.callApi(`${callId}/background`)).status).toBe(200);
    await t.replies("Carrying on.");
    await t.worker.idle();
    const job = (await t.records())[0]!;
    expect(await t.live.inThread(t.thread.id)).toEqual([
      { callId: job.id, offset: 0, text: "before\n", from: 0 },
    ]);
    t.tool.live("a").output("after\n");
    await t.until(async () => (await t.live.inThread(t.thread.id))[0]?.text === "before\nafter\n");

    expect((await t.callApi(`${job.id}/cancel`)).status).toBe(200);
    expect(await t.live.inThread(t.thread.id)).toEqual([]);
    t.tool.live("a").output("too late\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await t.db.execute("select * from call_output")).rows).toEqual([]);
  });
});

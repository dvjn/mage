import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { BACKGROUND_LIMIT } from "@/shared/calls.ts";
import { EDITORS } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import type { ToolSpec } from "./tools.ts";

// A tool that runs until the test finishes it, by the label of its call.
function probe() {
  const open = new Map<string, (output: { ok: true; value: unknown }) => void>();
  const aborted: string[] = [];
  const wait: ToolSpec<{ label: string }> = {
    name: "probe.wait",
    title: "Wait",
    description: "Waits.",
    input: z.object({ label: z.string() }),
    risk: () => "normal",
    run({ label }, ctx) {
      return new Promise((resolve) => {
        open.set(label, resolve);
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
  function rows() {
    return transcriptOf(events()).rows;
  }
  function tools() {
    return rows().filter((row) => row.kind === "tool");
  }
  function records() {
    return workspace.db.all<{ id: string; status: string; tool_id: string }>(
      "select id, status, tool_id from background_call order by id",
    );
  }
  async function until(condition: () => boolean) {
    for (let tries = 0; !condition(); tries++) {
      if (tries > 2000) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  function callApi(path: string, who: { cookie: string } = ada, body?: object) {
    return api("POST", `/threads/${thread.id}/tools/${path}`, who.cookie, body);
  }
  return { ...workspace, tool, asks, replies, rows, tools, records, until, callApi, worker };
}

describe("background calls", () => {
  it("start at once, run on, and tell the agent their result when they end", async () => {
    const t = await callThread();
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    const started = await t.replies("Started.");
    await t.worker.idle();

    // The run went on without the tool, which is still running.
    expect(started.texts.at(-1)).toMatch(/^result jobs\.start: .*"status":"running"/);
    const [record] = t.records();
    expect(record).toMatchObject({ status: "running", tool_id: "probe.wait" });
    expect(
      t.tools().map((row) => `${row.toolId} ${row.state}${row.background ? " bg" : ""}`),
    ).toEqual(["calls.start ran", "probe.wait pending bg"]);

    t.tool.finish("a", { answer: 42 });
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain(`Background call ${record!.id} (Wait) finished`);
    expect(told.texts.at(-1)).toContain('Result:\n\n{"answer":42}');
    expect(t.records()[0]).toMatchObject({ status: "done" });
    expect(t.tools().map((row) => `${row.toolId} ${row.state}`)).toEqual([
      "calls.start ran",
      "probe.wait ran",
    ]);
  });

  it("are checked, listed and cancelled by id, and a cancelled one tells nobody", async () => {
    const t = await callThread();
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = t.records()[0]!;

    await t.post(t.ada, "Check");
    await t.asks(["jobs.check", { id }], ["jobs.list", {}], ["jobs.cancel", { id }]);
    const next = await t.replies("Cancelled.");
    await t.worker.idle();

    expect(next.texts.join("\n")).toContain(`"id":"${id}"`);
    expect(t.tool.aborted).toEqual(["a"]);
    expect(t.records()[0]).toMatchObject({ status: "cancelled" });
    expect(t.rows().filter((row) => row.kind === "relay")).toEqual([]);
    expect(t.tools().find((row) => row.toolId === "probe.wait")).toMatchObject({
      state: "stopped",
    });
  });

  it("refuse tools that ask, calls of their own and a thread with too many", async () => {
    const t = await callThread();
    t.start();
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

    await t.post(t.ada, "Many");
    await t.asks(
      ...Array.from({ length: BACKGROUND_LIMIT + 1 }, (_, index): [string, unknown] => [
        "jobs.start",
        { tool: "probe.wait", input: { label: `l${index}` } },
      ]),
    );
    const full = await t.replies("Full.");
    await t.worker.idle();
    expect(t.records()).toHaveLength(BACKGROUND_LIMIT);
    expect(full.texts.at(-1)).toContain(`${BACKGROUND_LIMIT} background calls`);
  });

  it("wait as calls of their own for the tool's usual approval, which the run does not wait on", async () => {
    const t = await callThread();
    const policy = t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();

    const { id } = t.records()[0]!;
    expect(t.records()[0]).toMatchObject({ status: "pending" });
    expect(t.tools().at(-1)).toMatchObject({ id, state: "pending", waits: true, background: true });
    // The run ended; the decision is the existing one.
    expect((await t.callApi(`${id}/decision`, t.alan, { allow: true, scope: "once" })).status).toBe(
      403,
    );
    expect((await t.callApi(`${id}/decision`, t.ada, { allow: true, scope: "once" })).status).toBe(
      200,
    );
    await t.until(() => t.records()[0]!.status === "running");

    t.tool.finish("a", "ok");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("finished");
    expect(t.tools().at(-1)).toMatchObject({ state: "ran", decision: { allow: true } });
  });

  it("end as denied when the approval is refused, telling the agent", async () => {
    const t = await callThread();
    const policy = t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = t.records()[0]!;
    expect((await t.callApi(`${id}/decision`, t.ada, { allow: false, scope: "once" })).status).toBe(
      200,
    );
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("was denied");
    expect(t.records()[0]).toMatchObject({ status: "cancelled" });
  });

  it("move from a run that waits on a running call, which carries on and tells the agent when done", async () => {
    const t = await callThread();
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["probe.wait", { label: "a" }]);
    await t.until(() => t.tools()[0]?.state === "pending");
    const callId = t.tools()[0]!.id;

    // Only a call that is running, and not for someone who cannot post.
    expect((await t.callApi(`${callId}/background`, t.alan)).status).toBe(403);
    expect((await t.callApi(`${callId}/background`)).status).toBe(200);
    const carried = await t.replies("Carrying on.");
    await t.worker.idle();
    expect(carried.texts.at(-1)).toBe(
      `result probe.wait: {"ok":true,"value":{"movedToBackground":true,"callId":"${callId}"}}`,
    );
    expect(t.records()[0]).toMatchObject({ id: callId, status: "running" });
    // The run is over; the call is not.
    expect(t.runs().map((run) => run.status)).toEqual(["completed"]);
    expect((await t.callApi(`${callId}/background`)).status).toBe(409);

    t.tool.finish("a", "late");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("Result:\n\nlate");
    expect(t.records()[0]).toMatchObject({ status: "done" });
  });

  it("move from a run that waits for a decision, which stays decidable as a call of its own", async () => {
    const t = await callThread();
    const policy = t.toolPolicyStore.create({
      orgId: t.ada.orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    t.toolSettings.setInOrg(t.ada.orgId, ["probe.wait"], policy.id);
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["probe.wait", { label: "a" }]);
    await t.worker.idle();
    const callId = t.tools()[0]!.id;
    expect(t.tools()[0]).toMatchObject({ state: "pending", waits: true });

    expect((await t.callApi(`${callId}/background`)).status).toBe(200);
    const carried = await t.replies("Carrying on.");
    await t.worker.idle();
    const record = t.records()[0]!;
    expect(carried.texts.at(-1)).toBe(
      `result probe.wait: {"ok":true,"value":{"movedToBackground":true,"callId":"${record.id}"}}`,
    );
    expect(t.tools().map((row) => `${row.state}${row.background ? " bg" : ""}`)).toEqual([
      "ran",
      "pending bg",
    ]);

    expect(
      (await t.callApi(`${record.id}/decision`, t.ada, { allow: true, scope: "once" })).status,
    ).toBe(200);
    await t.until(() => t.records()[0]!.status === "running");
    t.tool.finish("a", "ok");
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("finished");
  });

  it("are interrupted, with the agent told, when a stopped server left them running", async () => {
    const t = await callThread();
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    expect(t.records()[0]).toMatchObject({ status: "running" });

    t.calls.recover();
    const told = await t.replies("Noted.");
    await t.worker.idle();
    expect(told.texts.at(-1)).toContain("was interrupted");
    expect(t.records()[0]).toMatchObject({ status: "interrupted" });
    expect(t.tools().at(-1)).toMatchObject({ state: "failed" });
  });

  it("show as cards with their status, and stop when cancelled by a person", async () => {
    const t = await callThread();
    t.start();
    await t.post(t.ada, "Wait for it");
    await t.asks(["jobs.start", { tool: "probe.wait", input: { label: "a" } }]);
    await t.replies("Started.");
    await t.worker.idle();
    const { id } = t.records()[0]!;

    const shown = async () => {
      const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
      const body = (await res.json()) as { rows: { id: string; background?: unknown }[] };
      return body.rows.find((row) => row.id === id)?.background;
    };
    expect(await shown()).toMatchObject({ kind: "call", status: "running", canCancel: true });
    expect((await t.callApi(`${id}/cancel`, t.alan)).status).toBe(403);
    expect((await t.callApi(`${id}/cancel`)).status).toBe(200);
    expect(await shown()).toMatchObject({ kind: "call", status: "cancelled", canCancel: false });
    expect((await t.callApi(`${id}/cancel`)).status).toBe(409);
  });
});

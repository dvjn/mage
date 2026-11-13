import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";
import { LARGE_RESULT_CHARS } from "@/shared/threads/events.ts";

// Two server instances on one database file: `a` with a thread in Ada's space, and `b`.
async function twoInstances() {
  const dir = mkdtempSync(path.join(tmpdir(), "mage-instances-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const database = path.join(dir, "mage.db");
  const a = await agentThread({}, { database });
  const b = setup({}, { database });
  return { a, b };
}

// Makes every lease on the table run out, as when the instance holding them died.
function expireLeases(db: { $client: { exec(sql: string): void } }, table: string) {
  db.$client.exec(`update ${table} set lease_expires_at = 1 where lease_owner is not null`);
}

describe("several server instances on one database", () => {
  it("take over a run only once its lease has run out, and only one of them", async () => {
    const { a, b } = await twoInstances();
    await a.post(a.ada, "Hello");
    // An instance takes the run, then dies.
    const taken = a.runStore.claim("dead", new Date(Date.now() + 60_000));
    expect(taken).not.toBeNull();

    a.worker.recover();
    b.worker.recover();
    expect(a.runs()).toEqual([expect.objectContaining({ status: "running" })]);

    expireLeases(a.db, "run");
    b.worker.recover();
    a.worker.recover();
    expect(a.runs().map((run) => [run.status, run.attempt])).toEqual([
      ["failed", 1],
      ["queued", 2],
    ]);
    expect(a.types().filter((type) => type === "run.failed")).toHaveLength(1);
  });

  it("fire a due trigger once, whichever instance ticks", async () => {
    const { a, b } = await twoInstances();
    a.triggerStore.create({
      id: "trigger-1",
      threadId: a.thread.id,
      kind: "once",
      name: "Wake",
      cron: null,
      timezone: null,
      prompt: "Carry on",
      steeredBy: [],
      createdByLabel: "Agent",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
    });
    a.clock.now = new Date();
    b.clock.now = new Date();
    expect(b.triggers.tick() + a.triggers.tick()).toBe(1);
    expect(a.triggers.tick() + b.triggers.tick()).toBe(0);
    expect(a.events().filter((event) => event.type === "notification")).toHaveLength(1);
  });

  it("interrupt a background call left by a dead instance once, telling its thread once", async () => {
    const { a, b } = await twoInstances();
    const run = a.runStore.create({ threadId: a.thread.id, triggerSeq: 1, createdBy: null });
    a.callStore.create(
      {
        id: "call-1",
        threadId: a.thread.id,
        runId: run.id,
        toolId: "probe.wait",
        input: {},
        status: "running",
      },
      { owner: "dead", expiresAt: new Date(Date.now() + 60_000) },
    );
    a.calls.recover();
    b.calls.recover();
    expect(a.callStore.find("call-1")?.status).toBe("running");

    expireLeases(a.db, "background_call");
    a.calls.recover();
    b.calls.recover();
    expect(a.callStore.find("call-1")?.status).toBe("interrupted");
    const told = a
      .events()
      .filter((event) => event.type === "notification" && event.data.kind === "call.ended");
    expect(told).toHaveLength(1);
  });

  it("read a large tool result that another instance wrote", async () => {
    const { a, b } = await twoInstances();
    const value = { text: "x".repeat(LARGE_RESULT_CHARS) };
    const { events } = a.log.write(a.thread.id, (append) => {
      append({
        type: "tool.ran",
        actor: { kind: "agent" },
        data: { runId: "run", callId: "call", ok: true, ms: 1, value },
      });
    });

    expect(b.threadStore.eventAt(a.thread.id, events[0]!.seq)?.data).toMatchObject({
      large: { size: JSON.stringify(value).length },
    });
    const res = await b.api("GET", `/tool-results/${events[0]!.id}`, a.ada.cookie);
    expect(await res.json()).toEqual({ value });
  });

  it("deliver a write made through one instance to a stream open on another", async () => {
    const { a, b } = await twoInstances();
    b.bus.start();
    onTestFinished(() => b.bus.stop());
    const stream = await openStream(b.app, a.ada.cookie, a.thread.id);
    await a.api("POST", `/threads/${a.thread.id}/messages`, a.ada.cookie, {
      text: "// from the other instance",
    });
    const update = await stream.nextRows();
    await stream.close();
    expect(update.rows).toEqual([
      expect.objectContaining({ kind: "human", text: "// from the other instance" }),
    ]);
  });
});

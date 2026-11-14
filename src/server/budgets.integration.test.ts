// The most queries the paths people wait on may make. A step that makes one of them cheaper
// lowers its number; one that makes it dearer says why.

import { describe, expect, it } from "vite-plus/test";

import { createRunTraces } from "@/server/kernel/tracing.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { queries } from "@/server/testing/tracing.ts";

const MAX = { detail: 46, rows: 13, threadList: 60, tray: 49, run: 157 };

// Ada's space with twenty threads, and a thread of fifty notes.
async function arranged() {
  const t = await agentThread({}, { traces: createRunTraces() });
  const seed = async (body: object) =>
    (
      await t.app.request("/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<{ threadId: string }>;
  await seed({ threads: { email: "ada@example.com", count: 20, prefix: "Thread" } });
  const { threadId } = await seed({
    notesThread: { email: "ada@example.com", title: "Notes", count: 50 },
  });
  const get = async (path: string) => {
    const res = await t.api("GET", path, t.ada.cookie);
    expect(res.status).toBe(200);
    await res.text();
  };
  return { ...t, notes: threadId, get };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("queries of the paths people wait on", () => {
  it("stay within their budgets", async () => {
    const t = await arranged();
    // None counted would mean the driver is not traced, not that a path is free.
    const counted = async (path: string) => {
      const { count } = await queries(() => t.get(path));
      expect(count).toBeGreaterThan(0);
      return count;
    };
    expect(await counted(`/threads/${t.notes}`)).toBeLessThanOrEqual(MAX.detail);
    expect(await counted(`/threads/${t.notes}/rows?before=40`)).toBeLessThanOrEqual(MAX.rows);
    expect(await counted(`/spaces/${t.space.id}/threads`)).toBeLessThanOrEqual(MAX.threadList);
    expect(await counted(`/threads/${t.notes}/background`)).toBeLessThanOrEqual(MAX.tray);
    // One message, one model step, no tools: what the run makes, not the post that woke it.
    await t.start();
    const run = await queries(async () => {
      await t.post(t.ada, "Hello");
      (await t.model.next()).reply("Hello back.");
      await t.worker.idle();
    }, "run");
    expect(run.count).toBeGreaterThan(0);
    expect(run.count).toBeLessThanOrEqual(MAX.run);
  });
});

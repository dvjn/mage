// What a request and a stream's delivery read of their reader through the access rule: once, the
// one Reader every part they show is worked out from.

import { describe, expect, it, vi } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";

describe("a reader", () => {
  it("is read once for a thread's detail, its rows and its tray", async () => {
    const t = await agentThread();
    await t.start();
    await t.post(t.ada, "Hello");
    (await t.model.next()).reply("Hello back.");
    await t.worker.idle();
    // Whether others may post, as the task list asks of those it may give tasks to, is not the
    // reader's.
    const resolves = [
      vi.spyOn(t.access, "require"),
      vi.spyOn(t.access, "reader"),
      vi.spyOn(t.access, "of"),
    ];
    const count = async (path: string) => {
      for (const spy of resolves) spy.mockClear();
      expect((await t.api("GET", path, t.ada.cookie)).status).toBe(200);
      return resolves.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    };

    expect(await count(`/threads/${t.thread.id}`)).toBe(1);
    expect(await count(`/threads/${t.thread.id}/rows?before=2`)).toBe(1);
    expect(await count(`/threads/${t.thread.id}/activity`)).toBe(1);
  });

  it("is read once for a stream's first delivery of rows and tray", async () => {
    const t = await agentThread();
    await t.start();
    await t.post(t.ada, "Hello");
    (await t.model.next()).reply("Hello back.");
    await t.worker.idle();
    const require = vi.spyOn(t.access, "require");
    const reader = vi.spyOn(t.access, "reader");
    const kinds: string[] = [];
    const { stop } = await t.views.thread.follow(t.ada, t.thread.id, 0, (item) =>
      kinds.push(item === "ended" ? item : item.kind),
    );
    await vi.waitFor(() => expect(kinds).toContain("rows"));
    stop();

    // One to open the stream, one for the delivery.
    expect(require.mock.calls.length).toBe(2);
    expect(reader.mock.calls.length).toBe(0);
  });
});

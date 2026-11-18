import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { ToolContext } from "@/server/tools/registry.ts";
import { SAVE_MEMORY } from "@/shared/memory.ts";

import { createMemory } from "./memory.ts";
import { createMemoryStore } from "./store.ts";

// Ada's thread, with the memory as compose makes it and a way to run its save tool there.
async function arranged() {
  const t = await agentThread();
  const ctx = (callId: string): ToolContext =>
    ({
      threadId: t.thread.id,
      spaceId: t.space.id,
      orgId: t.ada.orgId,
      runId: "run",
      callId,
      actor: { kind: "agent" },
      model: null,
      runAs: null,
      influence: [],
      named: (id: string) => id,
    }) as unknown as ToolContext;
  const saveWith = (memory: Pick<typeof t.memory, "toolset">) =>
    memory.toolset().tools.find((spec) => spec.name === SAVE_MEMORY)!;
  const live = async () => (await createMemoryStore(t.db).live(t.space.id)).map((row) => row.text);
  return { ...t, ctx, saveWith, live };
}

const ENTRY = { type: "fact", topic: "Deploys", text: "Deploys go out on Tuesdays." };

describe("space memory", () => {
  it("saves once for a call run again", async () => {
    const t = await arranged();
    const save = t.saveWith(t.memory);
    const first = await save.run(ENTRY, t.ctx("call-1"));
    const again = await save.run(ENTRY, t.ctx("call-1"));
    expect(again).toEqual(first);
    // Two runs of one call at once save one entry, and answer it both.
    const [one, other] = await Promise.all([
      save.run({ ...ENTRY, text: "Freeze on Fridays." }, t.ctx("call-2")),
      save.run({ ...ENTRY, text: "Freeze on Fridays." }, t.ctx("call-2")),
    ]);
    expect(one).toEqual(other);
    expect(await t.live()).toEqual(["Freeze on Fridays.", ENTRY.text]);
  });

  it("keeps the entry a save would replace when the save fails", async () => {
    const t = await arranged();
    const old = (await t.saveWith(t.memory).run(ENTRY, t.ctx("call-1"))) as {
      value: { id: string };
    };
    const store = createMemoryStore(t.db);
    const failing = createMemory({
      store: {
        ...store,
        create: () => Promise.reject(new Error("the write failed")),
      },
      spaces: t.spaces,
      spaceStore: t.spaceStore,
      transact: t.transact,
      memoryTools: () => Promise.resolve({ on: new Set([SAVE_MEMORY]), named: (id: string) => id }),
    });
    await expect(
      t
        .saveWith(failing)
        .run({ ...ENTRY, text: "Wednesdays.", replaces: old.value.id }, t.ctx("call-2")),
    ).rejects.toThrow("the write failed");
    expect(await t.live()).toEqual([ENTRY.text]);
  });

  it("opens main threads only, not subagents'", async () => {
    const t = await arranged();
    await t.saveWith(t.memory).run(ENTRY, t.ctx("call-1"));
    const thread = (await t.threadStore.find(t.thread.id))!;
    expect(await t.memory.opening(thread)).toMatchObject({ kind: "memory" });
    expect(await t.memory.opening({ ...thread, parentThreadId: thread.id })).toBeNull();
  });
});

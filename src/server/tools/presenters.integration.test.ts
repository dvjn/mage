// What calls show beyond their rows comes from the toolsets that present them: each asked once
// for a page, and a toolset's card shows on its row and in the tray with nothing else changed.

import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { agentThread } from "@/server/testing/agent-thread.ts";
import type { ActivityItem } from "@/shared/jobs.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";

import type { Toolset } from "./registry.ts";

// A toolset whose calls show a card of their own, counting how often it is asked.
function seam() {
  let asked = 0;
  const toolset: Toolset = {
    id: "seam",
    title: "Seam",
    source: "builtin",
    tools: [
      {
        name: "seam.make",
        title: "Make",
        description: "Makes a thing.",
        input: z.object({}),
        risk: () => "normal",
        run: async () => ({ ok: true, value: { made: true } }),
      },
      {
        name: "seam.plain",
        title: "Plain",
        description: "Shows nothing more.",
        input: z.object({}),
        risk: () => "normal",
        run: async () => ({ ok: true, value: {} }),
      },
    ],
    present: async (_reader, rows) => {
      asked += 1;
      const made = new Set(rows.filter((row) => row.toolId === "seam.make").map((row) => row.id));
      return (row) =>
        made.has(row.id)
          ? {
              names: { summary: "a thing" },
              work: {
                kind: "webhook",
                status: "listening",
                startedAt: new Date(0).toISOString(),
                canCancel: false,
                webhook: { id: row.id, name: "Thing", signed: false, fired: 0, canChange: false },
              },
              live: true,
            }
          : undefined;
    },
  };
  return { toolset, asked: () => asked };
}

describe("a toolset that presents its calls", () => {
  it("is asked once a page, and its card shows on its row and in the tray", async () => {
    const shown = seam();
    const t = await agentThread({}, { toolsets: [shown.toolset] });
    await t.start();
    await t.post(t.ada, "Make three");
    const call = await t.model.next();
    call.startStep();
    for (const [index, toolId] of ["seam.make", "seam.make", "seam.make", "seam.plain"].entries()) {
      call.toolCall(`c${index}`, toolId, {});
    }
    call.endStep();
    call.end();
    (await t.model.next()).reply("Made.");
    await t.worker.idle();

    const before = shown.asked();
    const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
    const detail = (await res.json()) as ThreadDetail;
    expect(shown.asked()).toBe(before + 1);
    const tools = detail.rows.flatMap((row) => (row.kind === "tool" ? [row] : []));
    expect(tools.map((row) => [row.toolId, row.summary ?? null, row.work?.kind ?? null])).toEqual([
      ["seam.make", "a thing", "webhook"],
      ["seam.make", "a thing", "webhook"],
      ["seam.make", "a thing", "webhook"],
      ["seam.plain", null, null],
    ]);

    const tray = await t.api("GET", `/threads/${t.thread.id}/activity`, t.ada.cookie);
    const { items } = (await tray.json()) as { items: ActivityItem[] };
    expect(items.map((item) => [item.title, item.work.kind])).toEqual([
      ["Thing", "webhook"],
      ["Thing", "webhook"],
      ["Thing", "webhook"],
    ]);
  });
});

describe("the registry", () => {
  it("offers tools in the order their toolsets registered", async () => {
    const t = await agentThread();
    const thread = (await t.threadStore.find(t.thread.id))!;
    const space = (await t.spaceStore.find(t.space.id))!;
    const toolsets = [
      ...new Set((await t.tools.offered(space, thread)).map((spec) => spec.name.split(".")[0])),
    ];
    const registered = [
      "reply",
      "thread",
      "skills",
      "mcp_servers",
      "subagents",
      "jobs",
      "tasks",
      "schedules",
      "webhooks",
      "artifact",
    ];
    expect(toolsets).toEqual(registered.filter((id) => toolsets.includes(id)));
    expect(toolsets.length).toBeGreaterThan(4);
  });
});

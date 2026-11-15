// What a running call prints across its move to the background: every piece it prints goes on
// on under the same id, wherever the move's commit falls among them.

import { describe, it } from "vite-plus/test";

import type { AfterCommit } from "@/server/sync/sync.ts";
import { eventually, expect, world } from "@/server/testing/contract.ts";

describe("a running call moved to the background", () => {
  it("keeps a piece printed while the move's commit is held back, under the call's id", async () => {
    // What live output waits on a commit for, held back while `holding` is set.
    let holding = false;
    const held: (() => void)[] = [];
    const liveAfterCommit =
      (inner: AfterCommit): AfterCommit =>
      (run) =>
        inner(() => (holding ? held.push(run) : run()));
    const w = await world({}, { liveAfterCommit });
    await w.post(w.ada, "Start and wait");
    const { ids } = await w.asks(w.threadId, ["probe.wait", { label: "a" }]);
    await eventually(
      () => w.tool.running("a"),
      (running) => running,
    );
    await w.tool.print("a", "one ");
    await eventually(
      () => w.printed(ids[0]!),
      (text) => text === "one ",
    );

    holding = true;
    expect(await w.act(w.ada, "POST", `/tools/${ids[0]}/background`)).toBe(200);
    await w.answers(w.threadId, "Carrying on.");
    const [job] = await eventually(
      () => w.activity(),
      (items) => items.some((item) => item.work.kind === "job"),
    );
    const jobId = job!.rowId;
    expect(jobId).toBe(ids[0]);
    await w.tool.print("a", "two ");
    // Long enough for the piece to be stored, or dropped.
    await new Promise((resolve) => setTimeout(resolve, 300));
    holding = false;
    for (const run of held.splice(0)) run();
    await w.tool.print("a", "three");
    await eventually(
      () => w.printed(jobId),
      (text) => text === "one two three",
    );
    w.tool.finish("a", { answer: 42 });
    await w.answers(w.threadId, "Noted.");
    await w.settled();
  });
});

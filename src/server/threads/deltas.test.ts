import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";
import type { DeltaBatch } from "@/shared/threads/events.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import { withPieces } from "@/web/threads/event-stream.ts";

import { eventSummary } from "./log.ts";

async function until(check: () => boolean) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting");
}

async function streamingThread() {
  const workspace = setup();
  workspace.org.defaultModel = "codex/gpt-big";
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  function stored() {
    return workspace.db.all<{ message_id: string; idx: number; text: string }>(
      "select message_id, idx, text from message_delta order by message_id, idx",
    );
  }
  function storedParts() {
    return workspace.db.all<{ idx: number; text: string; part: string }>(
      "select idx, text, part from message_delta order by message_id, idx",
    );
  }
  function start(worker = workspace.worker) {
    worker.start();
    onTestFinished(() => worker.stop());
  }
  async function post(text: string) {
    await workspace.api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text });
  }
  function rows() {
    return transcriptOf(workspace.threadStore.eventsAfter(thread.id, 0).map(eventSummary)).rows;
  }
  return { ...workspace, ada, thread, stored, storedParts, start, post, rows };
}

describe("streamed replies", () => {
  it("store every piece as it arrives and drop them when the reply completes", async () => {
    const { model, worker, stored, start, post, rows } = await streamingThread();
    start();

    await post("Hello");
    const call = await model.next();
    call.startStep();
    for (const piece of ["Gears", " and", " levers"]) call.delta(piece);
    await until(() => stored().length === 3);
    const replyId = stored()[0]?.message_id;

    expect(stored()).toEqual([
      { message_id: replyId, idx: 0, text: "Gears" },
      { message_id: replyId, idx: 1, text: " and" },
      { message_id: replyId, idx: 2, text: " levers" },
    ]);
    expect(rows().at(-1)).toMatchObject({ kind: "agent", id: replyId, status: "streaming" });

    call.endStep();
    call.end();
    await worker.idle();

    expect(stored()).toEqual([]);
    expect(rows().at(-1)).toMatchObject({
      id: replyId,
      text: "Gears and levers",
      status: "completed",
    });
  });

  it("give a reader who joins mid-reply the pieces so far, then the rest live, once each", async () => {
    const { app, ada, thread, model, worker, stored, start, post } = await streamingThread();
    start();
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Gears");
    call.delta(" and");
    await until(() => stored().length === 2);

    const stream = await openStream(app, ada.cookie, thread.id, { after: 0 });
    const frames = [];
    // The rows so far, then the stored pieces.
    for (let i = 0; i < 2; i += 1) frames.push(await stream.nextItem());
    call.delta(" levers");
    frames.push(await stream.nextItem());
    call.endStep();
    call.end();
    frames.push(await stream.nextItem());
    await worker.idle();
    await stream.close();

    expect(frames.map((frame) => frame.event)).toEqual([
      "rows",
      "message-delta",
      "message-delta",
      "rows",
    ]);
    expect(JSON.parse(frames[0]!.data!)).toMatchObject({
      rows: [{ kind: "human" }, { kind: "agent", status: "streaming", text: "" }],
    });
    const batches = frames
      .filter((frame) => frame.event === "message-delta")
      .map((frame) => JSON.parse(frame.data!) as DeltaBatch);
    expect(batches.map(({ index, texts }) => ({ index, texts }))).toEqual([
      { index: 0, texts: ["Gears", " and"] },
      { index: 2, texts: [" levers"] },
    ]);
    expect(JSON.parse(frames.at(-1)!.data!)).toMatchObject({
      rows: [{ kind: "agent", text: "Gears and levers", status: "completed" }],
    });
  });

  it("are rebuilt from their stored pieces when a stopped server's run is recovered", async () => {
    const { model, stored, start, post, rows, makeWorker } = await streamingThread();
    const crashed = makeWorker();
    start(crashed);
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Gears");
    call.delta(" and");
    await until(() => stored().length === 2);
    await crashed.stop();

    makeWorker().recover();

    expect(rows()[1]).toMatchObject({ kind: "agent", text: "Gears and", status: "failed" });
    expect(stored()).toEqual([]);
  });
});

describe("reasoning", () => {
  it("is stored like the answer, then kept on the reply with how long the model thought", async () => {
    const { app, ada, thread, model, worker, storedParts, start, post, rows } =
      await streamingThread();
    start();
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.reason("Gears");
    call.reason(" turn.");
    await until(() => storedParts().length === 2);
    call.delta("Gears.");
    await until(() => storedParts().length === 3);

    expect(storedParts()).toEqual([
      { idx: 0, text: "Gears", part: "reasoning" },
      { idx: 1, text: " turn.", part: "reasoning" },
      { idx: 2, text: "Gears.", part: "text" },
    ]);
    expect(rows().at(-1)).toMatchObject({ kind: "agent", status: "streaming" });
    const stream = await openStream(app, ada.cookie, thread.id, { after: 4 });
    const replayed = [await stream.nextItem(), await stream.nextItem()].map(
      (frame) => JSON.parse(frame.data!) as DeltaBatch,
    );
    await stream.close();
    expect(replayed.map(({ index, texts, part }) => ({ index, texts, part }))).toEqual([
      { index: 0, texts: ["Gears", " turn."], part: "reasoning" },
      { index: 2, texts: ["Gears."], part: undefined },
    ]);

    call.endStep();
    call.end();
    await worker.idle();

    expect(rows().at(-1)).toMatchObject({
      kind: "agent",
      text: "Gears.",
      reasoning: "Gears turn.",
      thoughtMs: expect.any(Number),
      status: "completed",
    });
    expect(storedParts()).toEqual([]);
  });

  it("is rebuilt with the answer when a stopped server's run is recovered", async () => {
    const { model, storedParts, start, post, rows, makeWorker } = await streamingThread();
    const crashed = makeWorker();
    start(crashed);
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.reason("Hmm");
    call.delta("Gea");
    await until(() => storedParts().length === 2);
    await crashed.stop();

    makeWorker().recover();

    expect(rows()[1]).toMatchObject({ text: "Gea", reasoning: "Hmm", status: "failed" });
  });
});

describe("withPieces", () => {
  it("adds only the pieces a reply does not have yet", () => {
    const first = withPieces(new Map(), { messageId: "m", index: 0, texts: ["a", "b"] });
    const again = withPieces(first, { messageId: "m", index: 0, texts: ["a", "b", "c"] });
    const stale = withPieces(again, { messageId: "m", index: 1, texts: ["b"] });

    expect(again.get("m")).toEqual({ text: "abc", reasoning: "", pieces: 3 });
    expect(stale).toBe(again);
  });

  it("keeps reasoning pieces apart from the answer", () => {
    const thinking = withPieces(new Map(), {
      messageId: "m",
      index: 0,
      texts: ["hm", "m"],
      part: "reasoning",
    });
    const answered = withPieces(thinking, { messageId: "m", index: 2, texts: ["Yes"] });

    expect(answered.get("m")).toEqual({ text: "Yes", reasoning: "hmm", pieces: 3 });
  });
});

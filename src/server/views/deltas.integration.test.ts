import { sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";
import type { DeltaBatch } from "@/shared/threads/events.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import { withPieces } from "@/web/threads/event-stream.ts";

import { eventSummary } from "@/server/threads/log.ts";

async function until(check: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting");
}

async function streamingThread() {
  const workspace = setup();
  await workspace.models.default("codex/gpt-big");
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  async function stored() {
    return (
      await workspace.db.execute<{ message_id: string; idx: number; text: string }>(
        "select message_id, idx, text from message_delta order by message_id, idx",
      )
    ).rows;
  }
  async function storedParts() {
    return (
      await workspace.db.execute<{ idx: number; text: string; part: string }>(
        "select idx, text, part from message_delta order by message_id, idx",
      )
    ).rows;
  }
  async function start(worker = workspace.worker) {
    await worker.start();
    onTestFinished(() => worker.stop());
  }
  async function post(text: string) {
    await workspace.api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text });
  }
  async function rows() {
    return transcriptOf((await workspace.threadStore.eventsAfter(thread.id, 0)).map(eventSummary))
      .rows;
  }
  return { ...workspace, ada, thread, stored, storedParts, start, post, rows };
}

describe("streamed replies", () => {
  it("store every piece as it arrives and drop them when the reply completes", async () => {
    const { model, worker, stored, start, post, rows } = await streamingThread();
    await start();

    await post("Hello");
    const call = await model.next();
    call.startStep();
    for (const piece of ["Gears", " and", " levers"]) call.delta(piece);
    await until(async () => (await stored()).length === 3);
    const replyId = (await stored())[0]?.message_id;

    expect(await stored()).toEqual([
      { message_id: replyId, idx: 0, text: "Gears" },
      { message_id: replyId, idx: 1, text: " and" },
      { message_id: replyId, idx: 2, text: " levers" },
    ]);
    expect((await rows()).at(-1)).toMatchObject({
      kind: "agent",
      id: replyId,
      status: "streaming",
    });

    call.endStep();
    call.end();
    await worker.idle();

    expect(await stored()).toEqual([]);
    expect((await rows()).at(-1)).toMatchObject({
      id: replyId,
      text: "Gears and levers",
      status: "completed",
    });
  });

  it("give a reader who joins mid-reply the pieces so far, then the rest live, once each", async () => {
    const { app, ada, thread, model, worker, stored, start, post } = await streamingThread();
    await start();
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Gears");
    call.delta(" and");
    await until(async () => (await stored()).length === 2);

    const stream = await openStream(app, ada.cookie, thread.id, { after: 0 });
    const frames: Awaited<ReturnType<typeof stream.nextItem>>[] = [];
    // The next frame that is not the thread itself, which a stream opened behind the log sends too.
    const take = async () => {
      let frame = await stream.nextItem();
      while (frame.event === "thread") frame = await stream.nextItem();
      frames.push(frame);
    };
    // The rows so far, then the stored pieces.
    for (let i = 0; i < 2; i += 1) await take();
    call.delta(" levers");
    await take();
    call.endStep();
    call.end();
    await take();
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

  it("are read once per stored batch for every reader following the reply here", async () => {
    const t = await streamingThread();
    await t.start();
    await t.post("Hello");
    const call = await t.model.next();
    call.startStep();
    call.delta("Gears");
    await until(async () => (await t.stored()).length === 1);
    const followers = [[], []].map(() => [] as string[]);
    const stops = await Promise.all(
      followers.map(async (pieces) =>
        t.views.thread.follow(t.ada, t.thread.id, 0, (item) => {
          if (item !== "ended" && item.kind === "delta") pieces.push(...item.delta.texts);
        }),
      ),
    );
    await vi.waitFor(() => expect(followers).toEqual([["Gears"], ["Gears"]]));
    const reads = vi.spyOn(t.deltaStore, "from");

    call.delta(" and");
    await vi.waitFor(() => expect(followers.map((one) => one.length)).toEqual([2, 2]));
    call.delta(" levers");
    await vi.waitFor(() => expect(followers.map((one) => one.length)).toEqual([3, 3]));
    for (const { stop } of stops) stop();
    call.endStep();
    call.end();
    await t.worker.idle();

    expect(followers).toEqual([
      ["Gears", " and", " levers"],
      ["Gears", " and", " levers"],
    ]);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("stop reaching a guest whose access ends mid-reply, with nothing else to tell them so", async () => {
    const t = await streamingThread();
    await t.start();
    const hedy = await t.signUp("Hedy Lamarr", "hedy@example.com");
    const invited = await t.api("POST", `/threads/${t.thread.id}/invites`, t.ada.cookie, {
      accessFor: "1d",
    });
    const { url } = (await invited.json()) as { url: string };
    const token = url.split("/invite/")[1]!;
    expect((await t.api("POST", "/invites/accept", hedy.cookie, { token })).status).toBe(200);
    await t.post("Hello");
    const call = await t.model.next();
    call.startStep();
    call.delta("Gears");
    await until(async () => (await t.stored()).length === 1);
    const told: string[] = [];
    const { stop } = await t.views.thread.follow(hedy, t.thread.id, 0, (item) => {
      if (item === "ended") told.push(item);
      else if (item.kind === "delta") told.push(...item.delta.texts);
    });
    await vi.waitFor(() => expect(told).toEqual(["Gears"]));
    // Ended as though its time ran out, which no write tells.
    await t.db.execute(
      sql`update thread_guest set access_until = now() - interval '1 second' where thread_id = ${t.thread.id}`,
    );

    call.delta(" and");
    await vi.waitFor(() => expect(told).toEqual(["Gears", "ended"]));
    stop();
    call.endStep();
    call.end();
    await t.worker.idle();
  });

  it("are rebuilt from their stored pieces when a stopped server's run is recovered", async () => {
    const { model, stored, start, post, rows, makeWorker } = await streamingThread();
    const crashed = makeWorker();
    await start(crashed);
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.delta("Gears");
    call.delta(" and");
    await until(async () => (await stored()).length === 2);
    await crashed.stop();

    await makeWorker().recover();

    expect((await rows())[1]).toMatchObject({ kind: "agent", text: "Gears and", status: "failed" });
    expect(await stored()).toEqual([]);
  });
});

describe("reasoning", () => {
  it("is stored like the answer, then kept on the reply with how long the model thought", async () => {
    const { app, ada, thread, model, worker, storedParts, start, post, rows } =
      await streamingThread();
    await start();
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.reason("Gears");
    call.reason(" turn.");
    await until(async () => (await storedParts()).length === 2);
    call.delta("Gears.");
    await until(async () => (await storedParts()).length === 3);

    expect(await storedParts()).toEqual([
      { idx: 0, text: "Gears", part: "reasoning" },
      { idx: 1, text: " turn.", part: "reasoning" },
      { idx: 2, text: "Gears.", part: "text" },
    ]);
    expect((await rows()).at(-1)).toMatchObject({ kind: "agent", status: "streaming" });
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

    expect((await rows()).at(-1)).toMatchObject({
      kind: "agent",
      text: "Gears.",
      reasoning: "Gears turn.",
      thoughtMs: expect.any(Number),
      status: "completed",
    });
    expect(await storedParts()).toEqual([]);
  });

  it("is rebuilt with the answer when a stopped server's run is recovered", async () => {
    const { model, storedParts, start, post, rows, makeWorker } = await streamingThread();
    const crashed = makeWorker();
    await start(crashed);
    await post("Hello");
    const call = await model.next();
    call.startStep();
    call.reason("Hmm");
    call.delta("Gea");
    await until(async () => (await storedParts()).length === 2);
    await crashed.stop();

    await makeWorker().recover();

    expect((await rows())[1]).toMatchObject({ text: "Gea", reasoning: "Hmm", status: "failed" });
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

// A thread's live stream as its client meets it: what a reader who opens it after some event is
// sent, in what order, and what they are sent again when they come back. Everything is arranged
// through the API and read from the stream itself.

import { describe, it } from "vite-plus/test";

import { eventually, expect, rowWords, world } from "@/server/testing/contract.ts";
import type { RowsUpdate } from "@/shared/threads/rows.ts";

const words = (update: Record<string, any>) => (update as RowsUpdate).rows.map(rowWords);

describe("a reader following a thread", () => {
  it("is sent the rows as they change, numbered by the event they reach, and a reply's pieces in order", async () => {
    const w = await world();
    const stream = await w.stream(w.grace, 0);
    expect(stream.status).toBe(200);

    await w.post(w.ada, "Hello");
    const call = await w.next(w.threadId);
    call.startStep();
    call.delta("Hi");
    call.delta(" there");

    // Kept as a client keeps them: each row sent takes the place of the one with its id.
    const rows = new Map<string, string>();
    const seqs: number[] = [];
    const pieces: string[] = [];
    let ended = false;
    for (;;) {
      const item = await stream.next();
      if (item.event === "message-delta") {
        // Pieces carry no id, and each batch starts where the last ended.
        expect(item.id).toBeNull();
        expect(item.data.index).toBe(pieces.length);
        pieces.push(...item.data.texts);
        if (pieces.join("") === "Hi there" && !ended) {
          ended = true;
          call.endStep();
          call.end();
        }
        continue;
      }
      if (item.event !== "rows") continue;
      const update = item.data as RowsUpdate;
      expect(item.id).toBe(update.seq);
      seqs.push(update.seq);
      for (const row of update.rows) rows.set(row.id, rowWords(row));
      if (ended && update.run === null) break;
    }
    await w.settled();
    expect([...rows.values()]).toEqual(["Ada Lovelace: Hello", "agent (completed): Hi there"]);
    expect([...rows.values()]).toEqual((await w.shown(w.grace)).rows);
    expect(pieces.join("")).toBe("Hi there");
    // Never back to an earlier event.
    expect(seqs).toEqual([...seqs].sort((one, other) => one - other));
    expect(seqs.at(-1)).toBe((await w.detail()).thread.lastEventSeq);
    await stream.close();
  });

  it("who opens it late is sent what changed since, then the reply being written from its start", async () => {
    const w = await world();
    await w.post(w.ada, "Hello");
    const call = await w.next(w.threadId);
    call.startStep();
    call.delta("Hi");
    call.delta(" there");
    await call.drained();
    const before = (await w.detail()).thread.lastEventSeq;

    // From the start: every row so far in one update, then the pieces so far.
    const whole = await w.stream(w.grace, 0);
    const all = await whole.next();
    expect(all.event).toBe("rows");
    expect(words(all.data)).toEqual(["Ada Lovelace: Hello", "agent (streaming): "]);
    expect(all.id).toBe(before);
    const replay = await whole.nextOf("message-delta");
    expect(replay.data).toMatchObject({ index: 0 });
    expect(replay.data.texts.join("")).toBe("Hi there");
    await whole.close();

    // From where the reader already was: no rows again, the pieces again from their start.
    const caught = await w.stream(w.grace, before);
    const next = await caught.next();
    expect(next.event).toBe("message-delta");
    expect(next.data).toMatchObject({ index: 0 });
    expect(next.data.texts.join("")).toBe("Hi there");

    call.endStep();
    call.end();
    const done = await caught.nextOf("rows");
    expect(words(done.data)).toEqual(["agent (completed): Hi there"]);
    expect(done.id).toBeGreaterThan(before);
    await w.settled();
    await caught.close();
  });

  it("is sent what a running call prints, and one who opens it late what it printed so far", async () => {
    const w = await world();
    await w.post(w.ada, "Start and wait");
    const { ids } = await w.asks(w.threadId, ["probe.wait", { label: "a" }]);
    await eventually(
      () => w.tool.running("a"),
      (running) => running,
    );
    const early = await w.stream(w.grace, (await w.detail()).thread.lastEventSeq);
    await w.tool.print("a", "one\n");
    expect((await early.nextOf("tool-output")).data).toEqual({
      callId: ids[0],
      offset: 0,
      text: "one\n",
      from: 0,
    });
    await w.tool.print("a", "two\n");
    expect((await early.nextOf("tool-output")).data).toMatchObject({ offset: 4, text: "two\n" });

    const late = await w.stream(w.alan, (await w.detail()).thread.lastEventSeq);
    expect((await late.nextOf("tool-output")).data).toEqual({
      callId: ids[0],
      offset: 0,
      text: "one\ntwo\n",
      from: 0,
    });
    w.tool.finish("a", "ok");
    await w.answers(w.threadId);
    await w.settled();
    await early.close();
    await late.close();
  });

  it("who opens it behind a rename is sent the thread as it now is", async () => {
    const w = await world();
    const read = (await w.detail(w.grace)).thread.lastEventSeq;
    expect(await w.act(w.ada, "PATCH", "", { title: "Renamed since" })).toBe(200);
    const stream = await w.stream(w.grace, read);
    expect((await stream.nextOf("thread")).data.thread.title).toBe("Renamed since");
    await stream.close();
  });

  it("is told when they may no longer read the thread, and the stream ends", async () => {
    const w = await world();
    const stream = await w.stream(w.grace, 0);
    await w.loses(w.grace);
    let ended = await stream.next();
    while (ended.event !== "access-ended") ended = await stream.next();
    expect(ended.data).toEqual({});
    await expect(stream.next()).rejects.toThrow("stream ended");
  });

  it("is refused a thread they may not read", async () => {
    const w = await world();
    const eve = await w.signUp("Eve Outsider", "eve@example.com");
    expect((await w.stream(eve, 0)).status).toBe(404);
  });

  it("who is a guest whose access ends is told so at the next delivery, and sent no row after it", async () => {
    // Beats seldom, so that what is written after the access ends comes before the next beat.
    const w = await world({}, { heartbeatMs: 60_000 });
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    const stream = await w.stream(hedy, (await w.detail()).thread.lastEventSeq);
    expect(await w.act(w.ada, "DELETE", `/guests/${hedy.userId}`)).toBe(200);
    await w.post(w.ada, "// After she left");
    const sent: string[] = [];
    for (let item = await stream.next(); ; item = await stream.next()) {
      if (item.event === "access-ended") break;
      if (item.event === "rows") sent.push(...words(item.data));
    }
    expect(sent).toEqual([]);
    await expect(stream.next()).rejects.toThrow("stream ended");
  });

  it("is sent an event this instance did not hear of at its next beat, while no gap is told", async () => {
    const w = await world();
    const other = await w.deaf();
    const stream = await w.stream(w.ada, (await w.detail()).thread.lastEventSeq);
    await stream.until(1);
    expect(
      await other.act(w.grace, "POST", "/messages", { text: "// Unheard", mode: "steer" }),
    ).toBe(202);
    const sent = (await stream.until(5)).filter((item) => item.event === "rows");
    expect(sent.flatMap((item) => words(item.data))).toEqual(["Grace Hopper: // Unheard"]);
    expect((await w.shown()).rows).toEqual(["Grace Hopper: // Unheard"]);
    await stream.close();
  });

  it("who opens it late is first sent the tasks, then the rows, a reply's pieces, a call's output, the activity and the thread", async () => {
    const w = await world();
    await w.post(w.ada, "Plan");
    await w.asks(w.threadId, ["tasks.add", { tasks: [{ title: "First" }] }]);
    await w.answers(w.threadId, "Planned.");
    await w.post(w.ada, "Start a job");
    await w.asks(w.threadId, ["jobs.start", { tool: "probe.wait", input: { label: "job" } }]);
    await w.answers(w.threadId, "Started.");
    await w.settled();
    await w.tool.print("job", "printed\n");
    await w.post(w.ada, "Go on");
    const call = await w.next(w.threadId);
    call.startStep();
    call.delta("Writing");
    await call.drained();
    // Once another reader is sent the pieces, they are stored.
    const watching = await w.stream(w.ada, 0);
    await watching.nextOf("message-delta");
    await watching.close();

    const stream = await w.stream(w.grace, 0);
    const first: string[] = [];
    while (first.length < 6) first.push((await stream.next()).event);
    expect(first).toEqual(["tasks", "rows", "message-delta", "tool-output", "activity", "thread"]);
    await stream.close();

    call.endStep();
    call.end();
    w.tool.finish("job", "done");
    await w.answers(w.threadId, "Noted.");
    await w.settled();
  });
});

describe("a reader's list feed", () => {
  it("is told of a thread that changed on an instance this one did not hear at its next beat, while no gap is told", async () => {
    const w = await world();
    const other = await w.deaf();
    const feed = await w.feed(w.ada);
    await feed.ready();
    expect(
      await other.act(w.grace, "POST", "/messages", { text: "// Unheard", mode: "steer" }),
    ).toBe(202);
    const told = await feed.nextThat(
      (item) => item.event === "thread" && item.data.thread.id === w.threadId,
    );
    expect(told.data.thread.status).toBe("unread");
    expect((await w.listed()).status).toBe("unread");
    await feed.close();
  });
});

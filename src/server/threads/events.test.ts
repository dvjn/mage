import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { openInbox, openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";

// Posts quiet asides, which wake no agent, so the log holds only these messages.
async function withThread(messages: string[]) {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  const post = (text: string) =>
    workspace.api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: `// ${text}` });
  for (const text of messages) await post(text);
  return { ...workspace, ada, thread, post };
}

describe("live thread events", () => {
  it("sends the rows changed after the cursor, then the rows each new event changes", async () => {
    const { app, ada, thread, post } = await withThread(["one", "two", "three"]);

    const stream = await openStream(app, ada.cookie, thread.id, { after: 1 });
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    const replayed = await stream.nextRows();
    await post("four");
    const four = await stream.nextRows();
    await stream.close();

    expect([replayed, four].map((update) => [update.sseId, update.seq, update.sseEvent])).toEqual([
      ["3", 3, "rows"],
      ["4", 4, "rows"],
    ]);
    expect(replayed.rows.map((row) => [row.order, row.seq])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    // The message before may now be restored from, as one follows it.
    expect(four).toMatchObject({
      rows: [
        { kind: "human", text: "// three", can: ["edit", "restore", "fork", "aside"] },
        {
          kind: "human",
          order: 3,
          seq: 4,
          author: { kind: "user", name: "Ada Lovelace" },
          text: "// four",
          quiet: true,
          turn: null,
        },
      ],
      pending: [],
      run: null,
    });
  });

  it("resumes after the Last-Event-ID a reconnecting browser sends", async () => {
    const { app, ada, thread } = await withThread(["one", "two", "three"]);

    const stream = await openStream(app, ada.cookie, thread.id, { lastEventId: "2" });
    const next = await stream.nextRows();
    await stream.close();

    expect(next.seq).toBe(3);
    expect(next.rows.map((row) => row.order)).toEqual([2]);
  });

  it("sends a heartbeat comment while nothing happens", async () => {
    const { app, ada, thread } = await withThread([]);

    const stream = await openStream(app, ada.cookie, thread.id);
    const frame = await stream.next();
    await stream.close();

    expect(frame).toEqual({ comment: "heartbeat" });
  });

  it("stops listening when the client goes away", async () => {
    const { app, ada, thread, listening } = await withThread(["one"]);

    const stream = await openStream(app, ada.cookie, thread.id);
    await stream.nextRows();
    expect(listening.count).toBe(1);
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listening.count).toBe(0);
  });

  it("ends the stream of a member who loses their place in the space", async () => {
    const { app, db, join, signUp, thread, listening } = await withThread(["one"]);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), thread.spaceId, "viewer");

    const stream = await openStream(app, grace.cookie, thread.id);
    await stream.nextRows();
    db.run(sql`delete from space_member where subject_id = ${grace.userId}`);
    let frame = await stream.next();
    while (frame.comment === "heartbeat") frame = await stream.next();

    expect(frame.event).toBe("access-ended");
    await expect(stream.next()).rejects.toThrow("stream ended");
    expect(listening.count).toBe(0);
  });

  it("ends the open streams when the server stops", async () => {
    const { app, ada, thread, listening, shutdown } = await withThread(["one"]);

    const stream = await openStream(app, ada.cookie, thread.id);
    const inbox = await openInbox(app, ada.cookie);
    await Promise.all([stream.nextRows(), inbox.next()]);
    shutdown.abort();

    await expect(stream.nextItem()).rejects.toThrow("stream ended");
    await expect(inbox.nextItem()).rejects.toThrow("stream ended");
    expect(listening.count).toBe(0);
  });

  it("answers 404 for a thread the user cannot see and 400 for a bad cursor", async () => {
    const { app, ada, thread, signUp } = await withThread([]);
    const grace = await signUp("Grace Hopper", "grace@example.com");

    expect((await openStream(app, grace.cookie, thread.id)).res.status).toBe(404);
    const bad = await openStream(app, ada.cookie, thread.id, { lastEventId: "x" });
    expect(bad.res.status).toBe(400);
  });
});

describe("following a thread", () => {
  for (const when of ["before", "after"] as const) {
    it(`delivers a row added during the replay once, read ${when} it`, async () => {
      const { threads, threadStore, ada, thread } = await withThread(["one", "two"]);
      const eventsAfter = threadStore.eventsAfter.bind(threadStore);
      // An event arrives while the stored ones are being read.
      let arrived = false;
      threadStore.eventsAfter = (id, after) => {
        const arrive = () => {
          if (arrived) return;
          arrived = true;
          threads.postMessage(ada, id, "// three");
        };
        if (when === "before") arrive();
        const stored = eventsAfter(id, after);
        arrive();
        return stored;
      };
      // Each message as delivered, with what the reader may do from it, which changes as messages
      // follow it.
      const delivered: string[] = [];

      const stop = threads.follow(ada, thread.id, 0, (item) => {
        if (item.kind !== "rows") return;
        for (const row of item.update.rows) {
          if (row.kind === "human") delivered.push(JSON.stringify([row.text, row.can]));
        }
      });
      threadStore.eventsAfter = eventsAfter;
      threads.postMessage(ada, thread.id, "// four");
      stop();
      threads.postMessage(ada, thread.id, "// five");

      expect(new Set(delivered).size).toBe(delivered.length);
      const texts = delivered.map((each) => (JSON.parse(each) as [string])[0]);
      expect([...new Set(texts)]).toEqual(["// one", "// two", "// three", "// four"]);
    });
  }
});

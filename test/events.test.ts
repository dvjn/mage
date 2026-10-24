import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { openInbox, openStream } from "./sse.ts";
import { setup } from "./workspace.ts";

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
  it("replays the events after the cursor, then sends new ones as they are posted", async () => {
    const { app, ada, thread, post } = await withThread(["one", "two", "three"]);

    const stream = await openStream(app, ada.cookie, thread.id, { after: 1 });
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    const two = await stream.nextEvent();
    const three = await stream.nextEvent();
    await post("four");
    const four = await stream.nextEvent();
    await stream.close();

    expect([two, three, four].map((event) => [event.sseId, event.seq, event.sseEvent])).toEqual([
      ["2", 2, "thread-event"],
      ["3", 3, "thread-event"],
      ["4", 4, "thread-event"],
    ]);
    expect(four).toMatchObject({
      type: "message",
      actor: { kind: "user", name: "Ada Lovelace" },
      data: { parts: [{ type: "text", text: "// four" }], quiet: true },
    });
  });

  it("resumes after the Last-Event-ID a reconnecting browser sends", async () => {
    const { app, ada, thread } = await withThread(["one", "two", "three"]);

    const stream = await openStream(app, ada.cookie, thread.id, { lastEventId: "2" });
    const next = await stream.nextEvent();
    await stream.close();

    expect(next.seq).toBe(3);
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
    await stream.nextEvent();
    expect(listening.count).toBe(1);
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listening.count).toBe(0);
  });

  it("ends the stream of a member who loses their place in the space", async () => {
    const { app, db, join, signUp, thread, listening } = await withThread(["one"]);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), thread.spaceId, "viewer");

    const stream = await openStream(app, grace.cookie, thread.id);
    await stream.nextEvent();
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
    await Promise.all([stream.nextEvent(), inbox.next()]);
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
    it(`delivers an event appended during the replay once, read ${when} it`, async () => {
      const { threads, threadStore, ada, thread } = await withThread(["one", "two"]);
      const eventsAfter = threadStore.eventsAfter.bind(threadStore);
      // An event arrives while the stored ones are being read.
      threadStore.eventsAfter = (id, after) => {
        if (when === "after") {
          const stored = eventsAfter(id, after);
          threads.postMessage(ada, id, "// three");
          return stored;
        }
        threads.postMessage(ada, id, "// three");
        return eventsAfter(id, after);
      };
      const delivered: number[] = [];

      const stop = threads.follow(ada, thread.id, 0, (item) => {
        if (item.kind === "event") delivered.push(item.event.seq);
      });
      threadStore.eventsAfter = eventsAfter;
      threads.postMessage(ada, thread.id, "// four");
      stop();
      threads.postMessage(ada, thread.id, "// five");

      expect(delivered).toEqual([1, 2, 3, 4]);
    });
  }
});

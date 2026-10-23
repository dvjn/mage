import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";
import { titleFrom } from "@/services/threads.ts";

import { setup } from "./workspace.ts";

type EventBody = {
  seq: number;
  type: string;
  actor: { kind: string; userId?: string; name?: string };
  data: { parts: { type: string; text: string }[] };
};

describe("threads", () => {
  it("starts untitled on the org's default model", async () => {
    const { org, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    org.defaultModel = "codex/gpt-big";

    const thread = await createThread(cookie, (await yourSpace(cookie)).id);

    expect(thread).toMatchObject({ title: "Untitled", untitled: true, model: "codex/gpt-big" });
  });

  it("starts without a model when the org has no default", async () => {
    const { signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    expect(await createThread(cookie, (await yourSpace(cookie)).id)).toMatchObject({
      model: null,
    });
  });

  it("is named after its first message and keeps that name", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);

    const thread = await createThread(cookie, space.id, "  How do\n engines   compute?  ");
    expect(thread.title).toBe("How do engines compute?");
    await api("POST", `/threads/${thread.id}/messages`, cookie, { text: "Another question" });

    const res = await api("GET", `/threads/${thread.id}`, cookie);
    const body = (await res.json()) as { thread: { title: string }; events: EventBody[] };
    expect(body.thread.title).toBe("How do engines compute?");
    const messages = body.events.filter((event) => event.type === "message");
    expect(messages.map((event) => event.data.parts[0]?.text)).toEqual([
      "How do\n engines   compute?",
      "Another question",
    ]);
  });

  it("keeps a title someone set before the first message", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(cookie, (await yourSpace(cookie)).id);

    await api("PATCH", `/threads/${thread.id}`, cookie, { title: "Engines" });
    const res = await api("POST", `/threads/${thread.id}/messages`, cookie, { text: "Hello" });
    expect(res.status).toBe(202);

    const detail = await api("GET", `/threads/${thread.id}`, cookie);
    expect(((await detail.json()) as { thread: { title: string } }).thread.title).toBe("Engines");
  });

  it("lists a space's threads, most recently active first", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const first = await createThread(cookie, space.id, "First");
    await createThread(cookie, space.id, "Second");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await api("POST", `/threads/${first.id}/messages`, cookie, { text: "Again" });

    const res = await api("GET", `/spaces/${space.id}/threads`, cookie);
    const list = (await res.json()) as { title: string; lastEventSeq: number }[];
    expect(list).toEqual([
      // The first message also started a run that took it in; the second waits for that run.
      expect.objectContaining({ title: "First", lastEventSeq: 4 }),
      expect.objectContaining({ title: "Second", lastEventSeq: 3 }),
    ]);
  });

  it("changes the model only to one the org can use", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(cookie, (await yourSpace(cookie)).id);

    const ok = await api("PATCH", `/threads/${thread.id}`, cookie, { model: "codex/gpt-big" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ model: "codex/gpt-big" });

    const refused = await api("PATCH", `/threads/${thread.id}`, cookie, { model: "claude/x" });
    expect(refused.status).toBe(400);
    expect((await api("PATCH", `/threads/${thread.id}`, cookie, {})).status).toBe(200);
  });

  it("keeps a reasoning effort, or the usual one", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(cookie, (await yourSpace(cookie)).id);
    expect(thread).toMatchObject({ effort: null });

    const high = await api("PATCH", `/threads/${thread.id}`, cookie, { effort: "high" });
    expect(await high.json()).toMatchObject({ effort: "high" });
    const usual = await api("PATCH", `/threads/${thread.id}`, cookie, { effort: null });
    expect(await usual.json()).toMatchObject({ effort: null });
    expect((await api("PATCH", `/threads/${thread.id}`, cookie, { effort: "max" })).status).toBe(
      400,
    );
  });

  it("is deleted with its events", async () => {
    const { api, threadStore, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const thread = await createThread(cookie, space.id, "Going");
    const kept = await createThread(cookie, space.id, "Staying");

    expect((await api("DELETE", `/threads/${thread.id}`, cookie)).status).toBe(200);

    expect((await api("GET", `/threads/${thread.id}`, cookie)).status).toBe(404);
    expect(threadStore.eventsAfter(thread.id, 0)).toEqual([]);
    const res = await api("GET", `/spaces/${space.id}/threads`, cookie);
    expect((await res.json()) as { id: string }[]).toEqual([
      expect.objectContaining({ id: kept.id }),
    ]);
  });

  it("answers a posted message with its event and author", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(cookie, (await yourSpace(cookie)).id);

    const res = await api("POST", `/threads/${thread.id}/messages`, cookie, { text: "Hello" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      seq: 1,
      type: "message",
      actor: { kind: "user", userId, name: "Ada Lovelace" },
      data: { parts: [{ type: "text", text: "Hello" }] },
    });
    for (const text of ["", "   "]) {
      expect((await api("POST", `/threads/${thread.id}/messages`, cookie, { text })).status).toBe(
        400,
      );
    }
  });
});

describe("event log", () => {
  it("numbers each thread's events 1, 2, 3… without gaps under concurrent appends", async () => {
    const { api, threadStore, signUp, yourSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const one = await createThread(cookie, space.id);
    const two = await createThread(cookie, space.id);

    const posts = Array.from({ length: 20 }, (_, i) =>
      api("POST", `/threads/${i % 2 ? one.id : two.id}/messages`, cookie, { text: `m${i}` }),
    );
    expect((await Promise.all(posts)).map((res) => res.status)).toEqual(Array(20).fill(202));

    for (const thread of [one, two]) {
      const events = threadStore.eventsAfter(thread.id, 0);
      expect(events.filter((event) => event.type === "message")).toHaveLength(10);
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      expect(threadStore.find(thread.id)?.lastEventSeq).toBe(events.length);
    }
  });

  it("names a user who is gone as a former member", async () => {
    const { db, threads, signUp, yourSpace, createThread, api } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = await yourSpace(ada.cookie);
    const thread = await createThread(ada.cookie, space.id, "Hello");
    // Grace joins Ada's space, posts, and her account is later removed.
    db.insert(schema.spaceMember)
      .values({ spaceId: space.id, userId: grace.userId, role: "messager", source: "direct" })
      .run();
    const asGrace = { userId: grace.userId, orgId: ada.orgId, role: "member" };
    threads.postMessage(asGrace, thread.id, "Hi Ada");
    await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi Grace" });
    db.delete(schema.user).where(eq(schema.user.id, grace.userId)).run();

    const { events } = await threads.get(ada, thread.id);
    const messages = events.filter((event) => event.type === "message");

    expect(messages.map((event) => event.actor)).toEqual([
      { kind: "user", userId: ada.userId, name: "Ada Lovelace" },
      { kind: "user", userId: grace.userId, name: "(former member)" },
      { kind: "user", userId: ada.userId, name: "Ada Lovelace" },
    ]);
  });
});

describe("thread visibility", () => {
  it("answers 404 to people outside the thread's space", async () => {
    const { api, signUp, yourSpace, createThread } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = await yourSpace(ada.cookie);
    const thread = await createThread(ada.cookie, space.id, "Private");

    const attempts = [
      api("GET", `/spaces/${space.id}/threads`, grace.cookie),
      api("POST", `/spaces/${space.id}/threads`, grace.cookie, {}),
      api("GET", `/threads/${thread.id}`, grace.cookie),
      api("PATCH", `/threads/${thread.id}`, grace.cookie, { title: "Mine" }),
      api("POST", `/threads/${thread.id}/messages`, grace.cookie, { text: "Hi" }),
      api("DELETE", `/threads/${thread.id}`, grace.cookie),
      api("GET", "/threads/no-such-thread", ada.cookie),
    ];
    expect((await Promise.all(attempts)).map((res) => res.status)).toEqual(Array(7).fill(404));
    expect((await api("GET", `/threads/${thread.id}`, ada.cookie)).status).toBe(200);
  });

  it("is unauthorized when signed out", async () => {
    const { api } = setup();

    expect((await api("GET", "/threads/anything", "")).status).toBe(401);
  });
});

describe("titleFrom", () => {
  it("cuts long text near 60 characters at a word", () => {
    const title = titleFrom(`${"word ".repeat(30)}end`);

    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toMatch(/^word( word)+…$/);
    expect(titleFrom("x".repeat(100))).toBe(`${"x".repeat(59)}…`);
  });

  it("leaves markdown out", () => {
    expect(titleFrom("# Why do **gears** _turn_?")).toBe("Why do gears turn?");
    expect(titleFrom("> Read [the notes](https://example.com) on `snake_case_names`")).toBe(
      "Read the notes on snake_case_names",
    );
    expect(titleFrom("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(titleFrom("- one\n- two ~~three~~")).toBe("one two three");
    expect(titleFrom("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("a space's thread list", () => {
  it("shows the start of each thread's newest message or reply, and who wrote it", async () => {
    const { api, signUp, yourSpace, createThread, threadStore } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const blank = await createThread(cookie, space.id);
    const talk = await createThread(
      cookie,
      space.id,
      `**Engines**   and\n\n${"looms ".repeat(40)}`,
    );
    threadStore.append(talk.id, {
      type: "message.completed",
      actor: { kind: "agent" },
      data: {
        messageId: "m1",
        runId: "r1",
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "They turn." },
        ],
        status: "completed",
      },
    });

    const list = (await (await api("GET", `/spaces/${space.id}/threads`, cookie)).json()) as {
      id: string;
      preview: { author: string; text: string } | null;
    }[];
    expect(list.find((t) => t.id === blank.id)?.preview).toBeNull();
    expect(list.find((t) => t.id === talk.id)?.preview).toEqual({
      author: "Agent",
      text: "They turn.",
    });

    const other = await createThread(
      cookie,
      space.id,
      `**Engines**   and\n\n${"looms ".repeat(40)}`,
    );
    const again = (await (await api("GET", `/spaces/${space.id}/threads`, cookie)).json()) as {
      id: string;
      preview: { author: string; text: string };
    }[];
    const preview = again.find((t) => t.id === other.id)?.preview;
    expect(preview?.author).toBe("Ada");
    expect(preview?.text.startsWith("Engines and looms looms")).toBe(true);
    expect(preview?.text).toHaveLength(120);
  });
});

import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/server/schema.ts";
import { setup } from "@/server/testing/workspace.ts";

import { SEARCH_LIMIT } from "./service.ts";

type ResultBody = { id: string; title: string; spaceId: string; spaceName: string };

function workspace() {
  const env = setup();
  async function search(cookie: string, q: string) {
    const res = await env.api("GET", `/threads/search?q=${encodeURIComponent(q)}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as ResultBody[];
  }
  // A titled thread straight in the store, in any space.
  function storedThread(spaceId: string, createdBy: string, title: string) {
    const thread = env.threadStore.create({ spaceId, model: null, createdBy });
    return env.threadStore.update(thread.id, { title });
  }
  return { ...env, search, storedThread };
}

describe("thread search", () => {
  it("finds threads only in the spaces the person can see in their org", async () => {
    const { db, spaceStore, signUp, yourSpace, createSpace, createThread, search, storedThread } =
      workspace();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const yours = await yourSpace(ada.cookie);
    const work = await createSpace(ada.cookie, "Work");
    const notes = await createThread(ada.cookie, yours.id, "Engine notes");
    const plans = await createThread(ada.cookie, work.id, "Engine plans");
    await createThread(ada.cookie, yours.id, "Looms");
    // A space in Ada's org she is not a member of.
    const hidden = spaceStore.create({
      orgId: ada.orgId,
      kind: "shared",
      name: "Hidden",
      createdBy: grace.userId,
    });
    storedThread(hidden.id, grace.userId, "Engine secrets");
    // Grace's own space, which Ada is a member of from Grace's org.
    const graces = await yourSpace(grace.cookie);
    db.insert(schema.spaceMember)
      .values({
        spaceId: graces.id,
        subjectKind: "user",
        subjectId: ada.userId,
        role: "messager",
        source: "direct",
      })
      .run();
    await createThread(grace.cookie, graces.id, "Engine of another org");

    const results = await search(ada.cookie, "engine");

    expect(results.map(({ id, spaceId, spaceName }) => ({ id, spaceId, spaceName }))).toEqual(
      expect.arrayContaining([
        { id: notes.id, spaceId: yours.id, spaceName: "Personal Space" },
        { id: plans.id, spaceId: work.id, spaceName: "Work" },
      ]),
    );
    expect(results).toHaveLength(2);
    expect((await search(grace.cookie, "engine")).map((result) => result.title)).toEqual([
      "Engine of another org",
    ]);
  });

  it("matches titles ignoring case, and wildcards only as themselves", async () => {
    const { signUp, yourSpace, createThread, search } = workspace();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    await createThread(cookie, space.id, "The Analytical ENGINE");
    await createThread(cookie, space.id, "100% done");

    for (const q of ["engine", "EnGiNe", "analytical engine"]) {
      expect((await search(cookie, q)).map((result) => result.title)).toEqual([
        "The Analytical ENGINE",
      ]);
    }
    expect((await search(cookie, "%")).map((result) => result.title)).toEqual(["100% done"]);
    expect(await search(cookie, "_")).toEqual([]);
  });

  it("finds untitled threads as Untitled", async () => {
    const { signUp, yourSpace, createSpace, createThread, search } = workspace();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const yours = await yourSpace(cookie);
    const work = await createSpace(cookie, "Work");
    const blank = await createThread(cookie, yours.id);
    await createThread(cookie, work.id, "Untitled draft notes");

    const found = await search(cookie, "untitled");
    expect(found).toHaveLength(2);
    expect(found.find((result) => result.id === blank.id)).toMatchObject({
      title: "Untitled",
      untitled: true,
      shared: false,
    });
  });

  it("returns at most 200, the most recently active first", async () => {
    const { signUp, yourSpace, search, storedThread } = workspace();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    for (let i = 0; i < SEARCH_LIMIT + 5; i++) storedThread(space.id, ada.userId, `Note ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const touched = storedThread(space.id, ada.userId, "Note touched");

    const results = await search(ada.cookie, "note");

    expect(SEARCH_LIMIT).toBe(200);
    expect(results).toHaveLength(200);
    expect(results[0]?.id).toBe(touched.id);
  });

  it("lists every thread without text, each with what it holds for the reader", async () => {
    const { signUp, yourSpace, createThread, search } = workspace();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    await createThread(cookie, space.id, "Engines");
    await createThread(cookie, space.id, "Looms");

    for (const q of ["", "  "]) {
      const found = await search(cookie, q);
      expect(found.map((result) => result.title)).toEqual(["Looms", "Engines"]);
      expect(found[0]).toHaveProperty("activity.lastSeenSeq");
    }
  });

  it("refuses text over 200 characters", async () => {
    const { api, signUp } = workspace();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    expect((await api("GET", `/threads/search?q=${"a".repeat(201)}`, cookie)).status).toBe(400);
  });

  it("is unauthorized when signed out", async () => {
    const { api } = workspace();

    expect((await api("GET", "/threads/search?q=engine", "")).status).toBe(401);
  });
});

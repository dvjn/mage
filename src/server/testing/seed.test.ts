import { describe, expect, it } from "vite-plus/test";

import { setup } from "./workspace.ts";

async function seeded() {
  const t = setup();
  const ada = await t.signUp("Ada Lovelace", "ada@example.com");
  const grace = await t.signUp("Grace Hopper", "grace@example.com");
  const seed = async <T>(input: object) => {
    const res = await t.app.request("/api/test/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const threadsOf = async (cookie: string, spaceId: string, org?: string) => {
    const res = await t.api("GET", `/spaces/${spaceId}/threads`, cookie, undefined, org);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; title: string; status: string }[];
  };
  return { ...t, ada, grace, seed, threadsOf, space: await t.yourSpace(ada.cookie) };
}

describe("seeding for tests", () => {
  it("makes someone a member of another person's space", async () => {
    const { ada, grace, seed, listSpaces, space } = await seeded();
    expect((await listSpaces(grace.cookie)).map((one) => one.id)).not.toContain(space.id);
    const { orgId } = await seed<{ orgId: string }>({
      joinSpace: { ownerEmail: "ada@example.com", email: "grace@example.com", role: "viewer" },
    });
    expect(orgId).toBe(ada.orgId);
    // Her session now acts in that org without naming it.
    expect(await listSpaces(grace.cookie)).toEqual([
      expect.objectContaining({ id: space.id, role: "viewer" }),
    ]);
  });

  it("adds threads, each newer than the last, and shares them", async () => {
    const { ada, grace, seed, api, threadsOf, space } = await seeded();
    await seed({ threads: { email: "ada@example.com", count: 5, prefix: "Loom" } });
    expect((await threadsOf(ada.cookie, space.id)).map((thread) => thread.title)).toEqual([
      "Loom 5",
      "Loom 4",
      "Loom 3",
      "Loom 2",
      "Loom 1",
    ]);
    await seed({
      shareThreads: { ownerEmail: "ada@example.com", guestEmail: "grace@example.com" },
    });
    const shared = await api("GET", "/shared-threads", grace.cookie);
    expect(((await shared.json()) as unknown[]).length).toBe(5);
  });

  it("adds a thread of asides, those from its owner seen and the others not", async () => {
    const { ada, seed, api, threadsOf, space } = await seeded();
    const { threadId } = await seed<{ threadId: string }>({
      notesThread: {
        email: "ada@example.com",
        title: "Catching up",
        count: 3,
        unread: { email: "grace@example.com", count: 2 },
      },
    });
    const [listed] = await threadsOf(ada.cookie, space.id);
    expect(listed).toMatchObject({ id: threadId, title: "Catching up", status: "unread" });
    const detail = (await (await api("GET", `/threads/${threadId}`, ada.cookie)).json()) as {
      rows: { kind: string; text: string; quiet: boolean; author: { name: string } }[];
    };
    expect(detail.rows.map((row) => [row.author.name, row.text.split("\n")[0], row.quiet])).toEqual(
      [
        ["Ada Lovelace", "Note 1", true],
        ["Ada Lovelace", "Note 2", true],
        ["Ada Lovelace", "Note 3", true],
        ["Grace Hopper", "Note 4", true],
        ["Grace Hopper", "Note 5", true],
      ],
    );
  });

  it("is not there in an app made without it", async () => {
    const { app } = setup({}, { testRoutes: false });
    const res = await app.request("/api/test/seed", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect((await app.request("/api/test/invariants")).status).toBe(404);
  });

  it("answers that the data holds together", async () => {
    const { app } = await seeded();
    const res = await app.request("/api/test/invariants");
    expect(await res.json()).toEqual({ violations: [] });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { setup } from "@/server/testing/workspace.ts";

async function sharedSpace() {
  const workspace = setup();
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id, "Engines");
  const grace = workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    space.id,
    "viewer",
  );
  const alan = workspace.join(
    await workspace.signUp("Alan Turing", "alan@example.com"),
    space.id,
    "messager",
  );
  return { ...workspace, ada, grace, alan, space, thread };
}

describe("space roles", () => {
  it("lets a viewer read the space's threads", async () => {
    const { api, grace, space, thread, listSpaces } = await sharedSpace();

    expect(await listSpaces(grace.cookie)).toEqual([
      expect.objectContaining({ id: space.id, role: "viewer" }),
    ]);
    const reads = [
      api("GET", `/spaces/${space.id}/threads`, grace.cookie),
      api("GET", `/threads/${thread.id}`, grace.cookie),
    ];
    expect((await Promise.all(reads)).map((res) => res.status)).toEqual([200, 200]);
  });

  it("refuses a viewer anything that writes", async () => {
    const { api, grace, space, thread } = await sharedSpace();

    const writes = [
      api("POST", `/spaces/${space.id}/threads`, grace.cookie, { text: "Hi" }),
      api("POST", `/threads/${thread.id}/messages`, grace.cookie, { text: "Hi" }),
      api("PATCH", `/threads/${thread.id}`, grace.cookie, { title: "Mine" }),
      api("DELETE", `/threads/${thread.id}`, grace.cookie),
      api("PATCH", `/spaces/${space.id}`, grace.cookie, { name: "Mine" }),
    ];
    expect((await Promise.all(writes)).map((res) => res.status)).toEqual(Array(5).fill(403));
  });

  it("lets a messager post and arrange threads but not manage the space", async () => {
    const { api, alan, space, thread } = await sharedSpace();

    expect(
      (await api("POST", `/threads/${thread.id}/messages`, alan.cookie, { text: "Hi" })).status,
    ).toBe(202);
    expect(
      (await api("PATCH", `/threads/${thread.id}`, alan.cookie, { title: "Ours" })).status,
    ).toBe(200);
    expect((await api("POST", `/spaces/${space.id}/threads`, alan.cookie, {})).status).toBe(200);
    expect((await api("DELETE", `/threads/${thread.id}`, alan.cookie)).status).toBe(403);
    expect((await api("PATCH", `/spaces/${space.id}`, alan.cookie, { name: "Ours" })).status).toBe(
      403,
    );
  });

  it("keeps the space's settings to its owner", async () => {
    const { api, ada, grace, alan, space } = await sharedSpace();

    for (const cookie of [grace.cookie, alan.cookie]) {
      const writes = [
        api("PATCH", `/spaces/${space.id}`, cookie, { name: "Mine" }),
        api("PATCH", `/spaces/${space.id}/defaults`, cookie, { effort: "low" }),
        api("PUT", `/spaces/${space.id}/members`, cookie, {
          kind: "user",
          id: ada.userId,
          role: null,
        }),
        api("PUT", `/spaces/${space.id}/everyone`, cookie, { role: "viewer" }),
        api("DELETE", `/spaces/${space.id}`, cookie),
      ];
      expect((await Promise.all(writes)).map((res) => res.status)).toEqual(Array(5).fill(403));
    }
  });

  it("tells each role what it may do with the space and its threads", async () => {
    const { api, ada, grace, alan, space, thread, listSpaces } = await sharedSpace();

    const told = async (cookie: string) => {
      const [listed] = await listSpaces(cookie);
      const detail = (await (await api("GET", `/threads/${thread.id}`, cookie)).json()) as {
        can: unknown;
      };
      return { space: listed, can: detail.can };
    };
    expect(await told(grace.cookie)).toMatchObject({
      space: { id: space.id, post: false, manage: false, remove: false },
      can: { post: false, arrange: false, move: false, delete: false },
    });
    expect(await told(alan.cookie)).toMatchObject({
      space: { post: true, manage: false, remove: false },
      can: { post: true, arrange: true, move: false, delete: false },
    });
    expect(await told(ada.cookie)).toMatchObject({
      space: { post: true, manage: true, remove: true },
      can: { post: true, arrange: true, move: true, delete: true },
    });
  });

  it("lets the owner manage the space", async () => {
    const { api, ada, space, thread } = await sharedSpace();

    expect((await api("DELETE", `/threads/${thread.id}`, ada.cookie)).status).toBe(200);
    expect(
      (await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, { effort: "low" })).status,
    ).toBe(200);
  });
});

describe("can", () => {
  it("allows each role its actions and nothing outside the space's org", async () => {
    const { spaces, spaceStore, ada, grace, alan, space: summary } = await sharedSpace();
    const space = spaceStore.find(summary.id);
    if (!space) throw new Error("no space");
    const actions = ["read", "message", "manage"] as const;
    const allowed = (who: { userId: string; orgId: string }) =>
      actions.filter((action) => spaces.can(who, space, action));

    expect(allowed(ada)).toEqual(["read", "message", "manage"]);
    expect(allowed(alan)).toEqual(["read", "message"]);
    expect(allowed(grace)).toEqual(["read"]);
    expect(allowed({ ...alan, orgId: "another-org" })).toEqual([]);
  });
});

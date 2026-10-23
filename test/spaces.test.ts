import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";

import { setup } from "./workspace.ts";

describe("spaces", () => {
  it("starts every personal org with a space named for the user, owned by them", async () => {
    const { db, signUp, listSpaces } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");

    expect(await listSpaces(cookie)).toEqual([
      expect.objectContaining({
        name: "Ada Lovelace's Space",
        kind: "personal",
        primary: true,
        role: "owner",
      }),
    ]);
    expect(db.select().from(schema.spaceMember).all()).toEqual([
      expect.objectContaining({ subjectKind: "user", subjectId: userId, role: "owner" }),
    ]);
  });

  it("creates, renames and deletes more spaces", async () => {
    const { api, signUp, listSpaces, createSpace } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const work = await createSpace(cookie, "  Work  ");
    expect(work).toMatchObject({ name: "Work", primary: false, role: "owner" });

    const renamed = await api("PATCH", `/spaces/${work.id}`, cookie, { name: "Research" });
    expect(renamed.status).toBe(200);
    expect((await listSpaces(cookie)).map((space) => space.name)).toEqual([
      "Ada Lovelace's Space",
      "Research",
    ]);

    expect((await api("DELETE", `/spaces/${work.id}`, cookie)).status).toBe(200);
    expect((await listSpaces(cookie)).map((space) => space.name)).toEqual(["Ada Lovelace's Space"]);
  });

  it("renames the first space but does not delete it", async () => {
    const { api, signUp, listSpaces } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const [yours] = await listSpaces(cookie);

    expect((await api("PATCH", `/spaces/${yours?.id}`, cookie, { name: "Home" })).status).toBe(200);
    expect((await api("DELETE", `/spaces/${yours?.id}`, cookie)).status).toBe(409);
    expect(await listSpaces(cookie)).toEqual([expect.objectContaining({ name: "Home" })]);
  });

  it("needs a name of 1 to 80 characters", async () => {
    const { api, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    for (const name of ["", "   ", "x".repeat(81)]) {
      expect((await api("POST", "/spaces", cookie, { name })).status).toBe(400);
    }
  });

  it("does not show another org's spaces and answers 404 for them", async () => {
    const { api, signUp, listSpaces, createSpace } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const work = await createSpace(ada.cookie, "Work");

    expect((await listSpaces(grace.cookie)).map((space) => space.name)).toEqual([
      "Grace Hopper's Space",
    ]);
    expect((await api("PATCH", `/spaces/${work.id}`, grace.cookie, { name: "Mine" })).status).toBe(
      404,
    );
    expect((await api("DELETE", `/spaces/${work.id}`, grace.cookie)).status).toBe(404);
    expect((await api("DELETE", "/spaces/no-such-space", grace.cookie)).status).toBe(404);
  });

  it("deletes only a space without threads", async () => {
    const { api, signUp, createSpace, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const work = await createSpace(cookie, "Work");
    await createThread(cookie, work.id, "Hello");

    const res = await api("DELETE", `/spaces/${work.id}`, cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Only a space without threads can be deleted" });
  });

  it("is unauthorized when signed out", async () => {
    const { api } = setup();

    expect((await api("GET", "/spaces", "")).status).toBe(401);
    expect((await api("POST", "/spaces", "", { name: "Work" })).status).toBe(401);
  });
});

describe("canSee", () => {
  it("is true only for members in the space's own org", async () => {
    const { spaceStore, spaces, signUp } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = spaceStore.create({
      orgId: ada.orgId,
      kind: "personal",
      name: "Work",
      createdBy: ada.userId,
    });

    expect(spaces.canSee(ada, space)).toBe(true);
    // A member acting in another org.
    expect(spaces.canSee({ ...ada, orgId: grace.orgId }, space)).toBe(false);
    // Someone in the org who is not a member.
    expect(spaces.canSee({ ...grace, orgId: ada.orgId }, space)).toBe(false);
    expect(spaces.canSee(grace, space)).toBe(false);
  });
});

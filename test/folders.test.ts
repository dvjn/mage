import { describe, expect, it } from "vite-plus/test";

import { type ThreadBody, setup } from "./workspace.ts";

describe("folders", () => {
  it("are listed by name and hold threads started in them", async () => {
    const { api, signUp, yourSpace, createFolder, listFolders } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);

    const looms = await createFolder(cookie, space.id, "Looms");
    const engines = await createFolder(cookie, space.id, "Engines");
    const res = await api("POST", `/spaces/${space.id}/threads`, cookie, {
      text: "Punched cards",
      folderId: looms.id,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Punched cards", folderId: looms.id });
    expect((await listFolders(cookie, space.id)).map((folder) => folder.id)).toEqual([
      engines.id,
      looms.id,
    ]);
  });

  it("is renamed", async () => {
    const { api, signUp, yourSpace, createFolder } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const folder = await createFolder(cookie, (await yourSpace(cookie)).id, "Engines");

    const res = await api("PATCH", `/folders/${folder.id}`, cookie, { name: " Looms " });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: folder.id, name: "Looms" });
  });

  it("takes a thread in and lets it back out to the top of the space", async () => {
    const { api, signUp, yourSpace, createFolder, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const folder = await createFolder(cookie, space.id, "Engines");
    const thread = await createThread(cookie, space.id);
    expect(thread.folderId).toBeNull();

    const into = await api("PATCH", `/threads/${thread.id}`, cookie, { folderId: folder.id });
    expect(((await into.json()) as ThreadBody).folderId).toBe(folder.id);
    const out = await api("PATCH", `/threads/${thread.id}`, cookie, { folderId: null });
    expect(((await out.json()) as ThreadBody).folderId).toBeNull();
  });

  it("does not take a thread from another space", async () => {
    const { api, signUp, yourSpace, createSpace, createFolder, createThread } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const elsewhere = await createFolder(cookie, (await createSpace(cookie, "Research")).id, "X");
    const thread = await createThread(cookie, space.id);

    const moved = await api("PATCH", `/threads/${thread.id}`, cookie, { folderId: elsewhere.id });
    const started = await api("POST", `/spaces/${space.id}/threads`, cookie, {
      folderId: elsewhere.id,
    });

    expect(moved.status).toBe(400);
    expect(started.status).toBe(400);
  });

  it("is deleted with its threads moved to the top of the space", async () => {
    const { api, signUp, yourSpace, createFolder, createThread, listFolders } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const engines = await createFolder(cookie, space.id, "Engines");
    const looms = await createFolder(cookie, space.id, "Looms");
    const thread = await createThread(cookie, space.id);
    await api("PATCH", `/threads/${thread.id}`, cookie, { folderId: engines.id });

    expect((await api("DELETE", `/folders/${engines.id}`, cookie)).status).toBe(200);

    expect(await listFolders(cookie, space.id)).toEqual([
      expect.objectContaining({ id: looms.id }),
    ]);
    const res = await api("GET", `/threads/${thread.id}`, cookie);
    expect(((await res.json()) as { thread: ThreadBody }).thread.folderId).toBeNull();
  });

  it("goes with its space", async () => {
    const { api, signUp, createSpace, createFolder } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await createSpace(cookie, "Research");
    const folder = await createFolder(cookie, space.id, "Engines");

    expect((await api("DELETE", `/spaces/${space.id}`, cookie)).status).toBe(200);
    expect((await api("PATCH", `/folders/${folder.id}`, cookie, { name: "X" })).status).toBe(404);
  });

  it("is not found from another org", async () => {
    const { api, signUp, yourSpace, createFolder } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = await yourSpace(ada.cookie);
    const folder = await createFolder(ada.cookie, space.id, "Engines");

    const attempts = [
      api("GET", `/spaces/${space.id}/folders`, grace.cookie),
      api("POST", `/spaces/${space.id}/folders`, grace.cookie, { name: "Mine" }),
      api("PATCH", `/folders/${folder.id}`, grace.cookie, { name: "Mine" }),
      api("DELETE", `/folders/${folder.id}`, grace.cookie),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    const graceSpace = await yourSpace(grace.cookie);
    const res = await api("POST", `/spaces/${graceSpace.id}/threads`, grace.cookie, {
      folderId: folder.id,
    });
    expect(res.status).toBe(400);
  });

  it("needs a name of 1 to 80 characters", async () => {
    const { api, signUp, yourSpace, createFolder } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(cookie);
    const folder = await createFolder(cookie, space.id, "Engines");

    for (const name of ["", "   ", "x".repeat(81)]) {
      expect((await api("POST", `/spaces/${space.id}/folders`, cookie, { name })).status).toBe(400);
      expect((await api("PATCH", `/folders/${folder.id}`, cookie, { name })).status).toBe(400);
    }
  });
});

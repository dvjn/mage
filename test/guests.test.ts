import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadPeople } from "@/shared/guests.ts";

import { agentThread } from "./agent-thread.ts";
import { openStream } from "./sse.ts";
import { setup } from "./workspace.ts";

type Workspace = ReturnType<typeof setup>;
type Person = { userId: string; orgId: string; cookie: string };

// Ada's space with a thread, Alan as its messager, Grace as its viewer, and Hedy and Joan in orgs
// of their own.
async function sharedThread(workspace: Workspace = setup()) {
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id, "// Engines");
  const alan = workspace.join(
    await workspace.signUp("Alan Turing", "alan@example.com"),
    space.id,
    "messager",
  );
  const grace = workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    space.id,
    "viewer",
  );
  const hedy = await workspace.signUp("Hedy Lamarr", "hedy@example.com");
  const joan = await workspace.signUp("Joan Clarke", "joan@example.com");
  return { ...workspace, ada, alan, grace, hedy, joan, space, thread };
}

async function invite(workspace: Workspace, by: Person, threadId: string, accessFor = "1d") {
  return workspace.api("POST", `/threads/${threadId}/invites`, by.cookie, { accessFor });
}

// Makes a link as `by` and opens it as `guest`; returns the link's token and the answer.
async function letIn(
  workspace: Workspace,
  by: Person,
  threadId: string,
  guest: Person,
  accessFor = "1d",
) {
  const res = await invite(workspace, by, threadId, accessFor);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const token = url.split("/invite/")[1]!;
  const accepted = await accept(workspace, guest, token);
  return { token, accepted };
}

function accept(workspace: Workspace, who: Person, token: string) {
  return workspace.api("POST", "/invites/accept", who.cookie, { token });
}

// Ends the guest's access as though its time ran out.
function expire(workspace: Workspace, threadId: string, userId: string) {
  workspace.db.run(
    sql`update thread_guest set access_until = ${Date.now() - 1000} where thread_id = ${threadId} and user_id = ${userId}`,
  );
}

async function people(workspace: Workspace, who: Person, threadId: string) {
  const res = await workspace.api("GET", `/threads/${threadId}/people`, who.cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as ThreadPeople;
}

describe("thread access", () => {
  it("comes from a role in the space or from a guest row that has not ended", async () => {
    const workspace = await sharedThread();
    const { access, threadStore, ada, alan, grace, hedy, joan, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);
    await letIn(workspace, ada, thread.id, joan);
    const stored = threadStore.find(thread.id)!;

    expect(access.of(ada, stored)).toEqual({ via: "space", role: "owner" });
    expect(access.of(alan, stored)).toEqual({ via: "space", role: "messager" });
    expect(access.of(grace, stored)).toEqual({ via: "space", role: "viewer" });
    expect(access.of(hedy, stored)).toEqual({ via: "guest", spaceName: "Ada Lovelace's Space" });
    expect(access.can(hedy, stored, "post")).toBe(true);
    expect(access.can(grace, stored, "post")).toBe(false);
    for (const action of ["arrange", "share", "delete"] as const) {
      expect(access.can(hedy, stored, action)).toBe(false);
    }

    expire(workspace, thread.id, hedy.userId);
    await workspace.api("DELETE", `/threads/${thread.id}/guests/${joan.userId}`, ada.cookie);
    expect(access.of(hedy, stored)).toBeNull();
    expect(access.of(joan, stored)).toBeNull();
    // A member of the space acting in another org reaches nothing there.
    expect(access.of({ ...alan, orgId: hedy.orgId }, stored)).toBeNull();
  });

  it("lets a guest read, post, change their waiting messages, stop and retry", async () => {
    const workspace = await sharedThread();
    const { api, ada, hedy, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);

    const read = await api("GET", `/threads/${thread.id}`, hedy.cookie);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      access: { via: "guest", spaceName: "Ada Lovelace's Space" },
    });
    const posted = await api("POST", `/threads/${thread.id}/messages`, hedy.cookie, {
      text: "// Hello",
    });
    expect(posted.status).toBe(202);
    expect(await posted.json()).toMatchObject({ data: { guest: true } });
    // Nothing is running or waiting, so these are refused for that, not for who asks.
    const stop = await api("POST", `/threads/${thread.id}/stop`, hedy.cookie);
    const retry = await api("POST", `/threads/${thread.id}/retry`, hedy.cookie, { runId: "r" });
    const change = await api("PATCH", `/threads/${thread.id}/messages/m`, hedy.cookie, {
      text: "Hi",
    });
    expect([stop.status, retry.status, change.status]).toEqual([409, 409, 409]);
  });

  it("refuses a guest the thread's settings, its sharing and its space", async () => {
    const workspace = await sharedThread();
    const { api, ada, hedy, space, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);

    const refused = [
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { title: "Mine" }),
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { model: "codex/gpt-big" }),
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { effort: "high" }),
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { folderId: null }),
      api("DELETE", `/threads/${thread.id}`, hedy.cookie),
      api("POST", `/threads/${thread.id}/invites`, hedy.cookie, { accessFor: "1h" }),
      api("GET", `/threads/${thread.id}/people`, hedy.cookie),
    ];
    expect((await Promise.all(refused)).map((res) => res.status)).toEqual(Array(7).fill(403));
    const space404 = [
      api("GET", `/spaces/${space.id}/threads`, hedy.cookie),
      api("GET", `/spaces/${space.id}/folders`, hedy.cookie),
      api("POST", `/spaces/${space.id}/threads`, hedy.cookie, {}),
    ];
    expect((await Promise.all(space404)).map((res) => res.status)).toEqual([404, 404, 404]);
  });

  it("answers 410 to a guest whose access ended and 404 to a stranger on every thread route", async () => {
    const workspace = await sharedThread();
    const { api, app, ada, hedy, joan, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);
    expire(workspace, thread.id, hedy.userId);
    const routes = (cookie: string) => [
      api("GET", `/threads/${thread.id}`, cookie),
      Promise.resolve(
        app.request(`/api/v1/threads/${thread.id}/events`, { headers: { Cookie: cookie } }),
      ),
      api("POST", `/threads/${thread.id}/messages`, cookie, { text: "Hi" }),
      api("PATCH", `/threads/${thread.id}/messages/m`, cookie, { text: "Hi" }),
      api("DELETE", `/threads/${thread.id}/messages/m`, cookie),
      api("POST", `/threads/${thread.id}/stop`, cookie),
      api("POST", `/threads/${thread.id}/retry`, cookie, { runId: "r" }),
      api("PATCH", `/threads/${thread.id}`, cookie, { title: "Mine" }),
      api("DELETE", `/threads/${thread.id}`, cookie),
    ];

    const ended = await Promise.all(routes(hedy.cookie));
    expect(ended.map((res) => res.status)).toEqual(Array(9).fill(410));
    expect(await ended[0]!.json()).toEqual({
      error: "Your access to this thread has ended",
      reason: "access_ended",
    });
    const stranger = await Promise.all(routes(joan.cookie));
    expect(stranger.map((res) => res.status)).toEqual(Array(9).fill(404));
  });

  it("ends a guest's live stream once they are revoked", async () => {
    const workspace = await sharedThread();
    const { app, api, ada, hedy, thread, listening } = workspace;
    await letIn(workspace, ada, thread.id, hedy);
    const stream = await openStream(app, hedy.cookie, thread.id);
    expect((await stream.nextEvent()).seq).toBe(1);

    await api("DELETE", `/threads/${thread.id}/guests/${hedy.userId}`, ada.cookie);
    let frame = await stream.next();
    while (frame.comment === "heartbeat") frame = await stream.next();
    expect(frame.event).toBe("access-ended");
    await expect(stream.next()).rejects.toThrow("stream ended");
    expect(listening.count).toBe(0);
  });

  it("lists the threads shared with a guest and finds them by title or place", async () => {
    const workspace = await sharedThread();
    const { api, ada, hedy, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy, "never");

    const shared = await api("GET", "/shared-threads", hedy.cookie);
    expect(await shared.json()).toEqual([
      expect.objectContaining({
        id: thread.id,
        title: "// Engines",
        spaceName: "Ada Lovelace's Space",
        orgName: "Ada Lovelace",
        accessUntil: null,
        participants: { people: [{ userId: ada.userId, name: "Ada Lovelace" }], total: 1 },
      }),
    ]);
    const found = await api("GET", "/threads/search?q=engi", hedy.cookie);
    expect(await found.json()).toEqual([
      expect.objectContaining({ id: thread.id, spaceName: "Ada Lovelace's Space", shared: true }),
    ]);
    const pageOf = async (query: string) =>
      (await (await api("GET", `/shared-threads/page?${query}`, hedy.cookie)).json()) as {
        items: { id: string }[];
        total: number;
      };
    expect(await pageOf("q=lovelace")).toMatchObject({ items: [{ id: thread.id }], total: 1 });
    expect(await pageOf("q=looms")).toMatchObject({ items: [], total: 0 });

    expire(workspace, thread.id, hedy.userId);
    expect(await (await api("GET", "/shared-threads", hedy.cookie)).json()).toEqual([]);
    expect(await (await api("GET", "/threads/search?q=engi", hedy.cookie)).json()).toEqual([]);
  });

  it("lets the agent take in a guest's message, named like anyone's", async () => {
    const workspace = await agentThread();
    const { ada, model, worker, post, start, thread, transcript } = workspace;
    const hedy = await workspace.signUp("Hedy Lamarr", "hedy@example.com");
    await letIn(workspace, ada, thread.id, hedy);
    start();

    await post(hedy, "Frequency hopping?");
    const call = await model.next();
    call.reply("Yes.");
    await worker.idle();

    expect(call.texts).toEqual(["user: [Hedy Lamarr] Frequency hopping?"]);
    expect(transcript()).toEqual(["Hedy Lamarr: Frequency hopping?", "Agent (completed): Yes."]);
  });
});

describe("invite links", () => {
  it("work once and say why they no longer work", async () => {
    const workspace = await sharedThread();
    const { ada, hedy, joan, thread, db } = workspace;

    const { token, accepted } = await letIn(workspace, ada, thread.id, hedy);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ threadId: thread.id });
    // Opening it again goes to the thread; someone else is refused.
    expect((await accept(workspace, hedy, token)).status).toBe(200);
    const used = await accept(workspace, joan, token);
    expect(used.status).toBe(410);
    expect(await used.json()).toMatchObject({ reason: "used" });

    const expired = await invite(workspace, ada, thread.id);
    const expiredToken = ((await expired.json()) as { url: string }).url.split("/invite/")[1]!;
    db.run(sql`update thread_invite set link_expires_at = ${Date.now() - 1}`);
    expect(await (await accept(workspace, joan, expiredToken)).json()).toMatchObject({
      reason: "expired",
    });

    const revoked = await invite(workspace, ada, thread.id);
    const { id, url } = (await revoked.json()) as { id: string; url: string };
    await workspace.api("DELETE", `/threads/${thread.id}/invites/${id}`, ada.cookie);
    const refused = await accept(workspace, joan, url.split("/invite/")[1]!);
    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({ reason: "revoked" });

    const unknown = await accept(workspace, joan, "nothing-like-it");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ reason: "not_found" });
  });

  it("keep only the token's hash and show the link once", async () => {
    const workspace = await sharedThread();
    const { ada, thread, db } = workspace;

    const res = await invite(workspace, ada, thread.id, "7d");
    const created = (await res.json()) as { url: string; accessFor: string; linkExpiresAt: string };
    const token = created.url.split("/invite/")[1]!;
    expect(created.url).toMatch(/^http:\/\/localhost:4783\/invite\/[\w-]{43}$/);
    expect(created.accessFor).toBe("7d");
    expect(Date.parse(created.linkExpiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const stored = db.all<{ token_hash: string }>(sql`select token_hash from thread_invite`);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toContain(token);
    expect(JSON.stringify((await people(workspace, ada, thread.id)).invites)).not.toContain(token);
  });

  it("leave a member of the space with the link unused", async () => {
    const workspace = await sharedThread();
    const { ada, alan, hedy, thread } = workspace;

    const { token, accepted } = await letIn(workspace, ada, thread.id, alan);
    expect(await accepted.json()).toEqual({ threadId: thread.id });
    expect((await accept(workspace, hedy, token)).status).toBe(200);
  });

  it("renew a guest's access instead of adding another row", async () => {
    const workspace = await sharedThread();
    const { ada, alan, hedy, thread, guestStore } = workspace;

    await letIn(workspace, ada, thread.id, hedy, "1h");
    const first = guestStore.find(thread.id, hedy.userId)!;
    await letIn(workspace, alan, thread.id, hedy, "7d");
    const renewed = guestStore.find(thread.id, hedy.userId)!;
    expect(renewed.accessUntil!.getTime() - first.accessUntil!.getTime()).toBeGreaterThan(
      6 * 86_400_000,
    );
    expect(renewed.invitedBy).toBe(alan.userId);
    // A shorter access leaves the longer one as it is.
    await letIn(workspace, ada, thread.id, hedy, "1h");
    expect(guestStore.find(thread.id, hedy.userId)).toEqual(renewed);

    await workspace.api("DELETE", `/threads/${thread.id}/guests/${hedy.userId}`, ada.cookie);
    await letIn(workspace, ada, thread.id, hedy, "never");
    expect(guestStore.find(thread.id, hedy.userId)).toMatchObject({
      accessUntil: null,
      revokedAt: null,
      invitedBy: ada.userId,
    });
    const listed = (await people(workspace, ada, thread.id)).people;
    expect(listed.filter((person) => person.kind === "guest")).toHaveLength(1);
  });

  it("are made by owners and messagers only", async () => {
    const workspace = await sharedThread();
    const { ada, alan, grace, joan, thread } = workspace;

    expect((await invite(workspace, ada, thread.id)).status).toBe(200);
    expect((await invite(workspace, alan, thread.id)).status).toBe(200);
    expect((await invite(workspace, grace, thread.id)).status).toBe(403);
    expect((await invite(workspace, joan, thread.id)).status).toBe(404);
    expect((await invite(workspace, ada, thread.id, "forever")).status).toBe(400);
  });
});

describe("revoking", () => {
  it("lets owners revoke any guest or link and messagers only their own", async () => {
    const workspace = await sharedThread();
    const { api, ada, alan, hedy, joan, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);
    await letIn(workspace, alan, thread.id, joan);
    const adaLink = (await (await invite(workspace, ada, thread.id)).json()) as { id: string };
    const alanLink = (await (await invite(workspace, alan, thread.id)).json()) as { id: string };

    const asAlan = await people(workspace, alan, thread.id);
    expect(asAlan.people.map((p) => [p.name, p.kind, p.invitedBy, p.canRevoke])).toEqual([
      ["Ada Lovelace", "member", null, false],
      ["Hedy Lamarr", "guest", "Ada Lovelace", false],
      ["Joan Clarke", "guest", "Alan Turing", true],
    ]);
    expect(asAlan.invites.map((invite) => [invite.id, invite.canRevoke])).toEqual([
      [adaLink.id, false],
      [alanLink.id, true],
    ]);

    const refused = [
      api("DELETE", `/threads/${thread.id}/guests/${hedy.userId}`, alan.cookie),
      api("DELETE", `/threads/${thread.id}/invites/${adaLink.id}`, alan.cookie),
    ];
    expect((await Promise.all(refused)).map((res) => res.status)).toEqual([403, 403]);
    const allowed = [
      api("DELETE", `/threads/${thread.id}/guests/${joan.userId}`, alan.cookie),
      api("DELETE", `/threads/${thread.id}/invites/${alanLink.id}`, alan.cookie),
      api("DELETE", `/threads/${thread.id}/guests/${hedy.userId}`, ada.cookie),
      api("DELETE", `/threads/${thread.id}/invites/${adaLink.id}`, ada.cookie),
    ];
    expect((await Promise.all(allowed)).map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(await people(workspace, ada, thread.id)).toEqual({
      people: [expect.objectContaining({ name: "Ada Lovelace", kind: "member" })],
      invites: [],
    });
  });
});

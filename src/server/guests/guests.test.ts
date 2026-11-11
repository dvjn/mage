import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadPeople } from "@/shared/guests.ts";

import { ulid } from "ulid";

import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { openStream } from "@/server/testing/sse.ts";
import { setup } from "@/server/testing/workspace.ts";

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
    expect(access.of(hedy, stored)).toEqual({
      via: "guest",
      role: "message",
      viaOrg: false,
      spaceName: "Ada Lovelace's Space",
    });
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

  it("says which of the thread's writers wrote as its guest", async () => {
    const workspace = await sharedThread();
    const { api, ada, hedy, space, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);
    await api("POST", `/threads/${thread.id}/messages`, hedy.cookie, { text: "// Hello" });

    const list = (await (await api("GET", `/spaces/${space.id}/threads`, ada.cookie)).json()) as {
      id: string;
      participants: unknown;
    }[];
    expect(list.find((t) => t.id === thread.id)?.participants).toEqual({
      people: [
        { userId: hedy.userId, name: "Hedy Lamarr", guest: true, former: false },
        { userId: ada.userId, name: "Ada Lovelace", guest: false, former: false },
      ],
      total: 2,
    });
  });

  it("refuses a guest the thread's settings, its sharing and its space", async () => {
    const workspace = await sharedThread();
    const { api, ada, hedy, space, thread } = workspace;
    await letIn(workspace, ada, thread.id, hedy);

    const refused = [
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { title: "Mine" }),
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { model: "codex/gpt-big" }),
      api("PATCH", `/threads/${thread.id}`, hedy.cookie, { effort: "high" }),
      api("DELETE", `/threads/${thread.id}`, hedy.cookie),
      api("POST", `/threads/${thread.id}/invites`, hedy.cookie, { accessFor: "1h" }),
      api("GET", `/threads/${thread.id}/people`, hedy.cookie),
    ];
    expect((await Promise.all(refused)).map((res) => res.status)).toEqual(Array(6).fill(403));
    const space404 = [
      api("GET", `/spaces/${space.id}/threads`, hedy.cookie),
      api("POST", `/spaces/${space.id}/threads`, hedy.cookie, {}),
    ];
    expect((await Promise.all(space404)).map((res) => res.status)).toEqual([404, 404]);
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
    expect((await stream.nextRows()).seq).toBe(1);

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
        participants: {
          people: [{ userId: ada.userId, name: "Ada Lovelace", guest: false, former: false }],
          total: 1,
        },
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
      orgAccess: "none",
    });
  });
});

describe("adding a guest directly", () => {
  // Makes the person a member of the thread's org without a place in its space.
  function intoOrg(workspace: Workspace, person: Person, orgId: string) {
    workspace.db
      .insert(schema.member)
      .values({
        id: ulid(),
        organizationId: orgId,
        userId: person.userId,
        role: "member",
        directRole: "member",
        createdAt: new Date(),
      })
      .run();
    return { ...person, orgId };
  }

  async function candidates(workspace: Workspace, by: Person, threadId: string, q = "") {
    const res = await workspace.api(
      "GET",
      `/threads/${threadId}/guest-candidates?q=${q}`,
      by.cookie,
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        items: { kind: string; id: string; name: string; already: string | null }[];
      }
    ).items;
  }

  function add(
    workspace: Workspace,
    by: Person,
    threadId: string,
    userId: string,
    accessFor = "1d",
  ) {
    return workspace.api("POST", `/threads/${threadId}/guests`, by.cookie, { userId, accessFor });
  }

  it("lets a messager add an org member outside the space, who then finds the thread shared", async () => {
    const workspace = await sharedThread();
    const { alan, ada, thread } = workspace;
    const edsger = intoOrg(
      workspace,
      await workspace.signUp("Edsger Dijkstra", "e@example.com"),
      ada.orgId,
    );

    const res = await add(workspace, alan, thread.id, edsger.userId, "never");
    expect(res.status).toBe(200);

    const shared = await workspace.api("GET", "/shared-threads", edsger.cookie);
    expect(await shared.json()).toEqual([
      expect.objectContaining({ id: thread.id, accessUntil: null }),
    ]);
    expect((await people(workspace, ada, thread.id)).people).toContainEqual(
      expect.objectContaining({ userId: edsger.userId, kind: "guest", invitedBy: "Alan Turing" }),
    );
  });

  it("gives access for as long as asked", async () => {
    const workspace = await sharedThread();
    const { ada, thread } = workspace;
    const edsger = intoOrg(
      workspace,
      await workspace.signUp("Edsger Dijkstra", "e@example.com"),
      ada.orgId,
    );
    await add(workspace, ada, thread.id, edsger.userId, "1h");

    const { people: listed } = await people(workspace, ada, thread.id);
    const until = new Date(listed.find((p) => p.userId === edsger.userId)!.accessUntil!).getTime();
    expect(Math.abs(until - (Date.now() + 60 * 60 * 1000))).toBeLessThan(60_000);
  });

  it("refuses a viewer, and anyone in the space or outside the org", async () => {
    const workspace = await sharedThread();
    const { ada, alan, grace, hedy, thread } = workspace;
    const edsger = intoOrg(
      workspace,
      await workspace.signUp("Edsger Dijkstra", "e@example.com"),
      ada.orgId,
    );

    expect((await add(workspace, grace, thread.id, edsger.userId)).status).toBe(403);
    expect((await add(workspace, ada, thread.id, alan.userId)).status).toBe(404);
    expect((await add(workspace, ada, thread.id, hedy.userId)).status).toBe(404);
    expect((await add(workspace, ada, thread.id, edsger.userId, "forever")).status).toBe(400);
    expect((await add(workspace, ada, thread.id, edsger.userId)).status).toBe(200);
    // Already a guest.
    expect((await add(workspace, ada, thread.id, edsger.userId)).status).toBe(404);
  });

  it("offers the org's members who are not in the space or its guests, and marks the rest", async () => {
    const workspace = await sharedThread();
    const { ada, grace, thread } = workspace;
    intoOrg(workspace, await workspace.signUp("Edsger Dijkstra", "e@example.com"), ada.orgId);
    const donald = intoOrg(
      workspace,
      await workspace.signUp("Donald Knuth", "d@example.com"),
      ada.orgId,
    );

    const open = async (q = "") =>
      (await candidates(workspace, ada, thread.id, q))
        .filter((one) => !one.already)
        .map((one) => one.name);
    expect(await open()).toEqual(["Donald Knuth", "Edsger Dijkstra"]);
    expect(await open("edsg")).toEqual(["Edsger Dijkstra"]);
    await add(workspace, ada, thread.id, donald.userId);
    expect(await open()).toEqual(["Edsger Dijkstra"]);
    const refused = await workspace.api(
      "GET",
      `/threads/${thread.id}/guest-candidates`,
      grace.cookie,
    );
    expect(refused.status).toBe(403);
  });

  it("marks who already has access, and why", async () => {
    const workspace = await sharedThread();
    const { ada, thread } = workspace;
    const donald = intoOrg(
      workspace,
      await workspace.signUp("Donald Knuth", "d@example.com"),
      ada.orgId,
    );
    await add(workspace, ada, thread.id, donald.userId);
    const reasons = Object.fromEntries(
      (await candidates(workspace, ada, thread.id)).map((one) => [one.name, one.already]),
    );
    expect(reasons).toMatchObject({
      "Ada Lovelace": "Owner",
      "Alan Turing": "In the space · Message",
      "Grace Hopper": "In the space · View",
      "Donald Knuth": "Guest",
    });
  });
});

// A member of Ada's org with no role in her space.
async function orgMember(workspace: Workspace, ada: Person, name: string, email: string) {
  const user = await workspace.signUp(name, email);
  workspace.db
    .insert(schema.member)
    .values({
      id: ulid(),
      organizationId: ada.orgId,
      userId: user.userId,
      role: "member",
      directRole: "member",
      createdAt: new Date(),
    })
    .run();
  workspace.db
    .update(schema.session)
    .set({ activeOrganizationId: ada.orgId })
    .where(eq(schema.session.userId, user.userId))
    .run();
  return { ...user, orgId: ada.orgId };
}

async function sharedIds(workspace: Workspace, who: Person) {
  const res = await workspace.api("GET", "/shared-threads", who.cookie);
  return ((await res.json()) as { id: string }[]).map((one) => one.id);
}

describe("sharing with the organization", () => {
  async function withOrgMember() {
    const workspace = await sharedThread();
    const dee = await orgMember(workspace, workspace.ada, "Dee Dee", "dee@example.com");
    const set = (orgAccess: string, by: Person = workspace.ada) =>
      workspace.api("PUT", `/threads/${workspace.thread.id}/org-access`, by.cookie, { orgAccess });
    const post = () =>
      workspace.api("POST", `/threads/${workspace.thread.id}/messages`, dee.cookie, {
        text: "// Hello",
      });
    return { ...workspace, dee, set, post };
  }

  it("is off until the thread is shared with the org", async () => {
    const { api, dee, thread, post } = await withOrgMember();
    expect((await api("GET", `/threads/${thread.id}`, dee.cookie)).status).toBe(404);
    expect((await post()).status).toBe(404);
  });

  it("lets the org's members read it as View, and not post", async () => {
    const t = await withOrgMember();
    expect((await t.set("view")).status).toBe(200);
    expect((await t.api("GET", `/threads/${t.thread.id}`, t.dee.cookie)).status).toBe(200);
    expect(await sharedIds(t, t.dee)).toEqual([t.thread.id]);
    expect((await t.post()).status).toBe(403);
    expect((await t.api("GET", `/threads/${t.thread.id}/people`, t.dee.cookie)).status).toBe(403);
  });

  it("lets them post as Message, and lists it for them as shared either way", async () => {
    const t = await withOrgMember();
    await t.set("message");
    expect(await sharedIds(t, t.dee)).toEqual([t.thread.id]);
    expect((await t.post()).status).toBe(202);
    const page = await t.api("GET", "/shared-threads/page", t.dee.cookie);
    expect(((await page.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      t.thread.id,
    ]);
  });

  it("is not a way into the space, for its members or for other orgs", async () => {
    const t = await withOrgMember();
    await t.set("message");
    expect(await sharedIds(t, t.alan)).toEqual([]);
    expect(await sharedIds(t, t.hedy)).toEqual([]);
    expect((await t.api("GET", `/threads/${t.thread.id}`, t.hedy.cookie)).status).toBe(404);
  });

  it("ends when the org's access is turned off", async () => {
    const t = await withOrgMember();
    await t.set("message");
    await t.set("none");
    expect((await t.api("GET", `/threads/${t.thread.id}`, t.dee.cookie)).status).toBe(404);
    expect(await sharedIds(t, t.dee)).toEqual([]);
    expect((await t.post()).status).toBe(404);
  });

  it("is changed by those who may share the thread", async () => {
    const t = await withOrgMember();
    expect((await t.set("view", t.alan)).status).toBe(200);
    expect((await t.set("none", t.grace)).status).toBe(403);
    expect((await t.set("view", t.dee)).status).toBe(403);
    expect((await people(t, t.ada, t.thread.id)).orgAccess).toBe("view");
  });

  it("leaves a guest of the thread their own role", async () => {
    const t = await withOrgMember();
    await t.set("view");
    await letIn(t, t.ada, t.thread.id, t.dee);
    expect((await t.post()).status).toBe(202);
    await t.api("PUT", `/threads/${t.thread.id}/guests/${t.dee.userId}/role`, t.ada.cookie, {
      role: "view",
    });
    expect((await t.post()).status).toBe(403);
  });
});

describe("guest roles", () => {
  const roleOf = async (workspace: Workspace, ada: Person, threadId: string, userId: string) =>
    (await people(workspace, ada, threadId)).people.find((one) => one.userId === userId)?.access;

  it("default to Message, so guests keep posting", async () => {
    const t = await sharedThread();
    await letIn(t, t.ada, t.thread.id, t.hedy);
    expect(await roleOf(t, t.ada, t.thread.id, t.hedy.userId)).toBe("message");
    // A grant that names no role, as every one made before roles was.
    t.guestStore.grant({
      threadId: t.thread.id,
      userId: t.joan.userId,
      invitedBy: t.ada.userId,
      accessUntil: null,
    });
    expect(await roleOf(t, t.ada, t.thread.id, t.joan.userId)).toBe("message");
  });

  it("let a View guest read but not post, and a Message guest post", async () => {
    const t = await sharedThread();
    const view = await t.api("POST", `/threads/${t.thread.id}/invites`, t.ada.cookie, {
      accessFor: "1d",
      role: "view",
    });
    const { url } = (await view.json()) as { url: string };
    expect((await accept(t, t.hedy, url.split("/invite/")[1]!)).status).toBe(200);
    expect(await roleOf(t, t.ada, t.thread.id, t.hedy.userId)).toBe("view");
    expect((await t.api("GET", `/threads/${t.thread.id}`, t.hedy.cookie)).status).toBe(200);
    const body = { text: "// Hello" };
    expect(
      (await t.api("POST", `/threads/${t.thread.id}/messages`, t.hedy.cookie, body)).status,
    ).toBe(403);
    expect(t.access.can(t.hedy, t.threadStore.find(t.thread.id)!, "post")).toBe(false);

    await letIn(t, t.ada, t.thread.id, t.joan);
    expect(
      (await t.api("POST", `/threads/${t.thread.id}/messages`, t.joan.cookie, body)).status,
    ).toBe(202);
  });

  it("change at once, for a guest and for a link not yet used", async () => {
    const t = await sharedThread();
    await letIn(t, t.ada, t.thread.id, t.hedy);
    const change = (role: string) =>
      t.api("PUT", `/threads/${t.thread.id}/guests/${t.hedy.userId}/role`, t.ada.cookie, { role });
    expect((await change("view")).status).toBe(200);
    expect(await roleOf(t, t.ada, t.thread.id, t.hedy.userId)).toBe("view");
    expect(
      (await t.api("POST", `/threads/${t.thread.id}/messages`, t.hedy.cookie, { text: "Hi" }))
        .status,
    ).toBe(403);
    expect((await change("message")).status).toBe(200);

    const made = await invite(t, t.ada, t.thread.id);
    expect(made.status).toBe(200);
    const { id } = (await made.json()) as { id: string };
    expect(
      (
        await t.api("PUT", `/threads/${t.thread.id}/invites/${id}/role`, t.ada.cookie, {
          role: "view",
        })
      ).status,
    ).toBe(200);
    expect((await people(t, t.ada, t.thread.id)).invites[0]).toMatchObject({ id, role: "view" });
    expect((await change("view")).status).toBe(200);
    expect((await change("nonsense")).status).toBe(400);
  });

  it("are given when adding a member of the org directly", async () => {
    const t = await sharedThread();
    const dee = await orgMember(t, t.ada, "Dee Dee", "dee@example.com");
    const res = await t.api("POST", `/threads/${t.thread.id}/guests`, t.ada.cookie, {
      userId: dee.userId,
      accessFor: "1d",
      role: "view",
    });
    expect(res.status).toBe(200);
    expect(await roleOf(t, t.ada, t.thread.id, dee.userId)).toBe("view");
  });
});

describe("sharing with a group", () => {
  async function candidates(workspace: Workspace, by: Person, threadId: string, q = "") {
    const res = await workspace.api(
      "GET",
      `/threads/${threadId}/guest-candidates?q=${q}`,
      by.cookie,
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        items: { kind: string; id: string; name: string; already: string | null }[];
      }
    ).items;
  }

  // The thread's groups and guests, which leaves out the members who wrote in it.
  async function granted(workspace: Workspace, by: Person, threadId: string) {
    return (await people(workspace, by, threadId)).people.filter((one) => one.kind !== "member");
  }

  // A group of the directory linked to Ada's org, with these people in it, who join the org.
  async function groupOf(workspace: Workspace, ada: Person, name: string, people: Person[]) {
    const ids: string[] = [];
    for (const person of people) {
      const found = workspace.directory.user(person.userId)!;
      ids.push(await workspace.scim.createUser({ name: found.name, email: found.email }));
    }
    const groupId = await workspace.scim.createGroup(name, ids);
    workspace.db
      .insert(schema.orgGroup)
      .values({ organizationId: ada.orgId, groupId, role: "member" })
      .run();
    return { groupId, ids };
  }

  async function withGroup() {
    const workspace = await sharedThread();
    const { ada } = workspace;
    const edsger = await orgMember(workspace, ada, "Edsger Dijkstra", "e@example.com");
    const donald = await orgMember(workspace, ada, "Donald Knuth", "d@example.com");
    const group = await groupOf(workspace, ada, "Looms", [edsger]);
    const give = (accessFor = "1d", role = "view", by: Person = ada) =>
      workspace.api("POST", `/threads/${workspace.thread.id}/group-guests`, by.cookie, {
        groupId: group.groupId,
        accessFor,
        role,
      });
    const post = (who: Person) =>
      workspace.api("POST", `/threads/${workspace.thread.id}/messages`, who.cookie, {
        text: "// Hello",
      });
    const stored = () => workspace.threadStore.find(workspace.thread.id)!;
    return { ...workspace, edsger, donald, group, give, post, stored };
  }

  it("gives its members the access at its role, and lists it as one row", async () => {
    const t = await withGroup();
    expect(t.access.of(t.edsger, t.stored())).toBeNull();
    expect((await t.give("1d", "view")).status).toBe(200);
    expect(t.access.of(t.edsger, t.stored())).toMatchObject({ via: "guest", role: "view" });
    expect(t.access.can(t.edsger, t.stored(), "read")).toBe(true);
    expect(t.access.can(t.edsger, t.stored(), "post")).toBe(false);
    expect(await sharedIds(t, t.edsger)).toEqual([t.thread.id]);
    const listed = await granted(t, t.ada, t.thread.id);
    expect(listed).toEqual([
      expect.objectContaining({
        kind: "group",
        userId: t.group.groupId,
        name: "Looms",
        access: "view",
        memberCount: 1,
        canRevoke: true,
      }),
    ]);
    const roleRes = await t.api(
      "PUT",
      `/threads/${t.thread.id}/group-guests/${t.group.groupId}/role`,
      t.ada.cookie,
      { role: "message" },
    );
    expect(roleRes.status).toBe(200);
    expect(t.access.can(t.edsger, t.stored(), "post")).toBe(true);
  });

  it("follows the group: a new member gains it and a leaver loses it", async () => {
    const t = await withGroup();
    await t.give("never", "message");
    const donaldId = await t.scim.createUser({ name: "Donald Knuth", email: "d@example.com" });
    expect(t.access.of(t.donald, t.stored())).toBeNull();
    await t.scim.addMembers(t.group.groupId, [donaldId]);
    expect(t.access.of(t.donald, t.stored())).toMatchObject({ via: "guest", role: "message" });
    expect(await sharedIds(t, t.donald)).toEqual([t.thread.id]);
    await t.scim.removeMembers(t.group.groupId, [t.group.ids[0]!]);
    expect(t.access.of(t.edsger, t.stored())).toBeNull();
    expect(await sharedIds(t, t.edsger)).toEqual([]);
  });

  it("lasts as long as asked, and ends when the group is removed", async () => {
    const t = await withGroup();
    await t.give("1h", "message");
    t.db.run(
      sql`update thread_group_guest set access_until = ${Date.now() - 1000} where thread_id = ${t.thread.id}`,
    );
    expect(t.access.of(t.edsger, t.stored())).toBeNull();
    expect(await granted(t, t.ada, t.thread.id)).toEqual([]);
    await t.give("never", "message");
    expect(t.access.of(t.edsger, t.stored())).not.toBeNull();
    const gone = await t.api(
      "DELETE",
      `/threads/${t.thread.id}/group-guests/${t.group.groupId}`,
      t.ada.cookie,
    );
    expect(gone.status).toBe(200);
    expect(t.access.of(t.edsger, t.stored())).toBeNull();
    expect(await granted(t, t.ada, t.thread.id)).toEqual([]);
  });

  it("leaves those in the space as they are, and refuses viewers", async () => {
    const t = await withGroup();
    expect((await t.give("1d", "view", t.grace)).status).toBe(403);
    await t.give("1d", "view");
    const found = await candidates(t, t.ada, t.thread.id);
    expect(found.find((one) => one.kind === "group")).toMatchObject({
      name: "Looms",
      already: "Added",
    });
    const reached = t.access.of(t.edsger, t.stored());
    expect(reached).toMatchObject({ via: "guest" });
    // A member of the space keeps their space role.
    t.join(t.edsger, t.space.id, "messager");
    expect(t.access.of(t.edsger, t.stored())).toEqual({ via: "space", role: "messager" });
  });

  it("offers groups beside people", async () => {
    const t = await withGroup();
    const found = await candidates(t, t.ada, t.thread.id, "loom");
    expect(found.map((one) => [one.kind, one.name, one.already])).toEqual([
      ["group", "Looms", null],
    ]);
  });
});

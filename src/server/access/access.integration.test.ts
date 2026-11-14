import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setup } from "@/server/testing/workspace.ts";

type Workspace = ReturnType<typeof setup>;
type Person = { userId: string; orgId: string; cookie: string; role?: "owner" | "member" };

// Ada's space with a thread; Alan its messager and Grace its viewer; Hedy and Joan from orgs of
// their own, let in as guests by link; Dee in no relation to it at all.
async function arranged() {
  const t = setup();
  const ada = await t.signUp("Ada Lovelace", "ada@example.com");
  const space = await t.yourSpace(ada.cookie);
  const thread = await t.createThread(ada.cookie, space.id, "// Engines");
  const alan = await t.join(
    await t.signUp("Alan Turing", "alan@example.com"),
    space.id,
    "messager",
  );
  const grace = await t.join(
    await t.signUp("Grace Hopper", "grace@example.com"),
    space.id,
    "viewer",
  );
  const hedy = await t.signUp("Hedy Lamarr", "hedy@example.com");
  const joan = await t.signUp("Joan Clarke", "joan@example.com");
  const dee = await t.signUp("Dee Dee", "dee@example.com");
  await letIn(t, ada, thread.id, hedy, "message");
  await letIn(t, ada, thread.id, joan, "view");
  const found = (await t.threadStore.find(thread.id))!;
  return { ...t, ada, alan, grace, hedy, joan, dee, space, thread: found };
}

async function letIn(t: Workspace, by: Person, threadId: string, guest: Person, role: string) {
  const res = await t.api("POST", `/threads/${threadId}/invites`, by.cookie, {
    accessFor: "1d",
    role,
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const accepted = await t.api("POST", "/invites/accept", guest.cookie, {
    token: url.split("/invite/")[1],
  });
  expect(accepted.status).toBe(200);
}

const ACTIONS = ["read", "post", "arrange", "share", "rewrite", "delete", "move"] as const;

// What the reader may do, and what requiring each action answers.
async function answers(t: Awaited<ReturnType<typeof arranged>>, who: Person) {
  const principal = { ...who, role: who.role ?? "member" } as never;
  const reader = await t.access.reader(principal, t.thread);
  const statuses: Record<string, number> = {};
  for (const action of ACTIONS) {
    try {
      await t.access.require(principal, t.thread.id, action);
      statuses[action] = 200;
    } catch (err) {
      statuses[action] = (err as { status: number }).status;
    }
  }
  return {
    via: reader.via?.via ?? null,
    can: ACTIONS.filter((action) => reader.can(action)),
    statuses,
  };
}

describe("a reader", () => {
  it("of a member acts as their role in the space allows", async () => {
    const t = await arranged();
    expect(await answers(t, { ...t.ada, role: "owner" })).toEqual({
      via: "space",
      can: [...ACTIONS],
      statuses: {
        read: 200,
        post: 200,
        arrange: 200,
        share: 200,
        rewrite: 200,
        delete: 200,
        move: 200,
      },
    });
    expect(await answers(t, t.alan)).toEqual({
      via: "space",
      can: ["read", "post", "arrange", "share"],
      statuses: {
        read: 200,
        post: 200,
        arrange: 200,
        share: 200,
        rewrite: 403,
        delete: 403,
        move: 403,
      },
    });
    expect(await answers(t, t.grace)).toEqual({
      via: "space",
      can: ["read"],
      statuses: {
        read: 200,
        post: 403,
        arrange: 403,
        share: 403,
        rewrite: 403,
        delete: 403,
        move: 403,
      },
    });
  });

  it("of a guest reads, and posts only with a role to message", async () => {
    const t = await arranged();
    expect(await answers(t, t.hedy)).toEqual({
      via: "guest",
      can: ["read", "post"],
      statuses: {
        read: 200,
        post: 200,
        arrange: 403,
        share: 403,
        rewrite: 403,
        delete: 403,
        move: 403,
      },
    });
    expect(await answers(t, t.joan)).toEqual({
      via: "guest",
      can: ["read"],
      statuses: {
        read: 200,
        post: 403,
        arrange: 403,
        share: 403,
        rewrite: 403,
        delete: 403,
        move: 403,
      },
    });
  });

  it("of a guest whose access ended is told so, and a stranger finds nothing", async () => {
    const t = await arranged();
    await t.db.execute(
      sql`update thread_guest set access_until = ${new Date(Date.now() - 1000)} where user_id = ${t.hedy.userId}`,
    );
    const ended = await answers(t, t.hedy);
    expect(ended).toMatchObject({ via: null, can: [] });
    expect(Object.values(ended.statuses)).toEqual(ACTIONS.map(() => 410));
    expect((await t.access.reader(t.hedy as never, t.thread)).ended).toBe(true);
    const stranger = await answers(t, t.dee);
    expect(stranger).toMatchObject({ via: null, can: [] });
    expect(Object.values(stranger.statuses)).toEqual(ACTIONS.map(() => 404));
  });

  it("of anyone but a member finds nothing in a space in trash", async () => {
    const t = await arranged();
    await t.spaceStore.trash(t.space.id, t.ada.userId, new Date());
    for (const who of [t.alan, t.hedy]) {
      const gone = await answers(t, who);
      expect(gone).toMatchObject({ via: null, can: [] });
      expect(Object.values(gone.statuses)).toEqual(ACTIONS.map(() => 404));
    }
  });

  it("of an org member reads a thread shared with the org at the role it is shared with", async () => {
    const t = await arranged();
    await t.db.execute(sql`update thread set org_access = 'view' where id = ${t.thread.id}`);
    const member = await t.join(
      await t.signUp("Mary Sue", "mary@example.com"),
      t.space.id,
      "viewer",
    );
    await t.db.execute(
      sql`delete from space_member where space_id = ${t.space.id} and subject_id = ${member.userId}`,
    );
    expect(await answers(t, member)).toMatchObject({ via: "guest", can: ["read"] });
  });
});

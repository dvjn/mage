import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { openInbox } from "@/server/testing/sse.ts";
import { sharedThreadListSchema } from "@/shared/guests.ts";
import { statusOf } from "@/shared/thread-status.ts";
import { type ThreadActivity, threadListSchema } from "@/shared/threads/list.ts";

const ME = "u-me";

function activity(facts: Partial<ThreadActivity> = {}): ThreadActivity {
  return {
    run: null,
    lastNotableSeq: 0,
    lastNotableBy: null,
    failed: null,
    lastSeenSeq: 0,
    canApprove: false,
    ...facts,
  };
}

const since = new Date(0).toISOString();
const waiting = { status: "waiting" as const, since, toolId: "thread.move" };
const running = { status: "running" as const, since };

describe("a thread's status", () => {
  const cases: [string, Partial<ThreadActivity>, ReturnType<typeof statusOf>][] = [
    ["nothing happened", {}, "read"],
    ["someone else wrote after I looked", { lastNotableSeq: 4, lastSeenSeq: 2 }, "unread"],
    ["I saw it all", { lastNotableSeq: 4, lastSeenSeq: 4 }, "read"],
    ["the newest is mine", { lastNotableSeq: 4, lastNotableBy: ME, lastSeenSeq: 2 }, "read"],
    ["working beats unread", { run: running, lastNotableSeq: 4 }, "working"],
    ["queued shows as working", { run: { status: "queued", since } }, "working"],
    [
      "waiting on me beats unread",
      { run: waiting, canApprove: true, lastNotableSeq: 4 },
      "waiting",
    ],
    ["waiting on someone else", { run: waiting, lastNotableSeq: 4 }, "paused"],
    ["failed after I looked", { failed: { seq: 5, error: "No" }, lastSeenSeq: 4 }, "failed"],
    [
      "failed beats unread",
      { failed: { seq: 5, error: "No" }, lastNotableSeq: 5, lastSeenSeq: 1 },
      "failed",
    ],
    [
      "a failure I saw is only read",
      { failed: { seq: 5, error: "No" }, lastNotableSeq: 5, lastSeenSeq: 5 },
      "read",
    ],
    [
      "waiting on me beats a failure",
      { run: waiting, canApprove: true, failed: { seq: 5, error: "No" } },
      "waiting",
    ],
  ];
  it.each(cases)("%s", (_name, facts, status) => {
    expect(statusOf(activity(facts), ME)).toBe(status);
  });
});

describe("what a thread holds for each reader", () => {
  async function listed(workspace: Awaited<ReturnType<typeof agentThread>>, cookie: string) {
    const res = await workspace.api("GET", `/spaces/${workspace.space.id}/threads`, cookie);
    const list = threadListSchema.parse(await res.json());
    return list.find((item) => item.id === workspace.thread.id)!.activity;
  }

  it("counts others' messages and asides as new, and the author has seen their own", async () => {
    const workspace = await agentThread();
    const { ada, grace, post } = workspace;

    await post(grace, "// Between us");
    const graceSees = await listed(workspace, grace.cookie);
    expect(statusOf(graceSees, grace.userId)).toBe("read");
    expect(graceSees.lastSeenSeq).toBe(graceSees.lastNotableSeq);
    const adaSees = await listed(workspace, ada.cookie);
    expect(adaSees).toMatchObject({ lastNotableBy: grace.userId, lastSeenSeq: 0 });
    expect(statusOf(adaSees, ada.userId)).toBe("unread");

    const read = await workspace.api("PUT", `/threads/${workspace.thread.id}/read`, ada.cookie, {
      seq: 1000,
    });
    expect(await read.json()).toEqual({
      seq: workspace.threadStore.find(workspace.thread.id)!.lastEventSeq,
    });
    expect(statusOf(await listed(workspace, ada.cookie), ada.userId)).toBe("read");
  });

  it("gives each reader the status the thread shows them", async () => {
    const workspace = await agentThread();
    const { ada, grace, post, api, space, thread } = workspace;
    await post(grace, "// Between us");
    const statusFor = async (who: { cookie: string }) => {
      const res = await api("GET", `/spaces/${space.id}/threads`, who.cookie);
      const list = threadListSchema.parse(await res.json());
      return list.find((item) => item.id === thread.id)?.status;
    };

    expect(await statusFor(ada)).toBe("unread");
    expect(await statusFor(grace)).toBe("read");
  });

  it("keeps how far a reader saw from moving back, gives it with the thread's entry, and hides threads they cannot read", async () => {
    const workspace = await agentThread();
    const { ada, post, api, thread, signUp } = workspace;
    await post(ada, "// One");
    await post(ada, "// Two");

    expect(
      await (await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq: 2 })).json(),
    ).toEqual({ seq: 2 });
    expect(
      await (await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq: 1 })).json(),
    ).toEqual({ seq: 2 });
    expect(await listed(workspace, ada.cookie)).toMatchObject({ lastSeenSeq: 2 });
    const stranger = await signUp("Hedy Lamarr", "hedy@example.com");
    expect(
      (await api("PUT", `/threads/${thread.id}/read`, stranger.cookie, { seq: 1 })).status,
    ).toBe(404);
  });

  it("shows a failed run until it is seen or another run starts", async () => {
    const workspace = await agentThread();
    const { ada, grace, post, model, worker, start, api, thread } = workspace;
    start();
    await post(grace, "Hello");
    (await model.next()).fail("The provider said no.");
    await worker.idle();

    const failed = await listed(workspace, ada.cookie);
    expect(failed.failed?.error).toContain("The provider said no.");
    expect(statusOf(failed, ada.userId)).toBe("failed");
    expect(statusOf(await listed(workspace, grace.cookie), grace.userId)).toBe("failed");

    await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq: failed.failed!.seq });
    expect(statusOf(await listed(workspace, ada.cookie), ada.userId)).toBe("read");

    await post(grace, "Again");
    const again = await listed(workspace, grace.cookie);
    expect(again.failed).toBeNull();
    (await model.next()).reply("Done.");
    await worker.idle();
  });

  it("parses in both lists", async () => {
    const workspace = await agentThread();
    const { ada, api, guestStore, thread, signUp } = workspace;
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
    guestStore.grant({
      threadId: thread.id,
      userId: hedy.userId,
      invitedBy: ada.userId,
      accessUntil: null,
    });

    const shared = sharedThreadListSchema.parse(
      await (await api("GET", "/shared-threads", hedy.cookie)).json(),
    );
    expect(shared[0]?.activity).toMatchObject({ run: null, canApprove: false, lastSeenSeq: 0 });
  });
});

describe("a person's inbox", () => {
  it("tells them about threads they can read as they change, and their own reads", async () => {
    const workspace = await agentThread();
    const { ada, alan, grace, post, app, api, thread, signUp } = workspace;
    const stranger = await signUp("Hedy Lamarr", "hedy@example.com");
    const adaInbox = await openInbox(app, ada.cookie);
    const alanInbox = await openInbox(app, alan.cookie);
    const strangerInbox = await openInbox(app, stranger.cookie);
    // Listening once each has sent a heartbeat.
    await Promise.all([adaInbox.next(), alanInbox.next(), strangerInbox.next()]);

    await post(grace, "// For everyone");
    const told = await adaInbox.nextInbox();
    expect(told).toMatchObject({
      event: "thread",
      data: { shared: false, thread: { id: thread.id } },
    });
    expect(told.data.thread.status).toBe("unread");
    expect((await alanInbox.nextInbox()).event).toBe("thread");

    await api("PUT", `/threads/${thread.id}/read`, ada.cookie, { seq: 1 });
    expect(await adaInbox.nextInbox()).toEqual({
      event: "thread-read",
      data: { threadId: thread.id, seq: 1 },
    });
    // Then the thread again, with the status that follows from it.
    expect(await adaInbox.nextInbox()).toMatchObject({
      event: "thread",
      data: { thread: { id: thread.id, status: "read" } },
    });

    // Alan hears nothing of Ada's reads; the stranger hears nothing at all.
    await post(grace, "// Again");
    expect((await alanInbox.nextInbox()).event).toBe("thread");
    const strangerNext = await Promise.race([
      strangerInbox.nextItem(),
      new Promise((resolve) => setTimeout(() => resolve("quiet"), 150)),
    ]);
    expect(strangerNext).toBe("quiet");
    await Promise.all([adaInbox.close(), alanInbox.close(), strangerInbox.close()]);
  });

  it("says a thread is gone when it is deleted or a guest's access ends", async () => {
    const workspace = await agentThread();
    const { ada, alan, app, api, thread, signUp, guestStore, db, createThread, space } = workspace;
    const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
    guestStore.grant({
      threadId: thread.id,
      userId: hedy.userId,
      invitedBy: ada.userId,
      accessUntil: null,
    });
    const hedyInbox = await openInbox(app, hedy.cookie);
    await hedyInbox.next();

    db.run(
      sql`update thread_guest set access_until = ${Date.now() - 1000} where thread_id = ${thread.id} and user_id = ${hedy.userId}`,
    );
    expect(await hedyInbox.nextInbox()).toEqual({
      event: "thread-gone",
      data: { threadId: thread.id },
    });

    const other = await createThread(ada.cookie, space.id);
    const alanInbox = await openInbox(app, alan.cookie);
    await alanInbox.next();
    expect((await api("DELETE", `/threads/${other.id}`, ada.cookie)).status).toBe(200);
    expect(await alanInbox.nextInbox()).toEqual({
      event: "thread-gone",
      data: { threadId: other.id },
    });
    await Promise.all([hedyInbox.close(), alanInbox.close()]);
  });
});

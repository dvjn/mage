import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { openStream } from "@/server/testing/sse.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { RowsPage, ShownRow } from "@/shared/threads/rows.ts";

import type { ThreadFollowItem } from "./service.ts";

// A thread of `count` quiet asides from Ada, which wake no agent.
async function asides(count: number) {
  const workspace = await agentThread();
  const { threads, ada, thread } = workspace;
  for (let i = 1; i <= count; i++) threads.postMessage(ada, thread.id, `// Note ${i}`);
  async function detail(who: { cookie: string }) {
    return (await (
      await workspace.api("GET", `/threads/${thread.id}`, who.cookie)
    ).json()) as ThreadDetail;
  }
  async function page(who: { cookie: string }, before: number, limit?: number, at?: string) {
    const query = `before=${before}${limit ? `&limit=${limit}` : ""}${at ? `&at=${at}` : ""}`;
    const res = await workspace.api("GET", `/threads/${thread.id}/rows?${query}`, who.cookie);
    return { status: res.status, body: (await res.json()) as RowsPage };
  }
  return { ...workspace, detail, page };
}

const orders = (rows: { order: number }[]) => [rows[0]?.order, rows.at(-1)?.order, rows.length];

describe("a thread's rows", () => {
  it("come as the newest page, and the pages before it down to the start", async () => {
    const { ada, detail, page } = await asides(250);

    const newest = await detail(ada);
    expect(orders(newest.rows)).toEqual([150, 249, 100]);
    expect(newest.before).toBe(150);
    expect(newest.newFrom).toBeNull();
    expect(newest.rows[0]).toMatchObject({ kind: "human", text: "// Note 151", seq: 151 });

    const middle = await page(ada, 150);
    expect(orders(middle.body.rows)).toEqual([50, 149, 100]);
    expect(middle.body.before).toBe(50);
    const first = await page(ada, 50);
    expect(orders(first.body.rows)).toEqual([0, 49, 50]);
    expect(first.body.before).toBeNull();
    expect(orders((await page(ada, 20, 5)).body.rows)).toEqual([15, 19, 5]);
  });

  it("come as a page reaching back to a row, for a link to it", async () => {
    const { ada, page } = await asides(250);
    const target = (await page(ada, 50)).body.rows[20]!;

    const reaching = (await page(ada, 150, undefined, target.id)).body;
    expect(orders(reaching.rows)).toEqual([20, 149, 130]);
    expect(reaching.rows[0]!.id).toBe(target.id);
    expect(reaching.before).toBe(20);
    // A row within the usual page, past it, or none by the id, gives the usual page.
    expect(orders((await page(ada, 150, undefined, reaching.rows[90]!.id)).body.rows)).toEqual([
      50, 149, 100,
    ]);
    expect(orders((await page(ada, 10, undefined, target.id)).body.rows)).toEqual([0, 9, 10]);
    expect(orders((await page(ada, 150, undefined, "nothing")).body.rows)).toEqual([50, 149, 100]);
  });

  it("reach back to the first row a reader has not seen", async () => {
    const { ada, grace, api, thread, detail } = await asides(250);
    expect((await api("PUT", `/threads/${thread.id}/read`, grace.cookie, { seq: 30 })).status).toBe(
      200,
    );

    const opened = await detail(grace);
    expect(opened.newFrom).toBe(opened.rows[0]!.id);
    expect(orders(opened.rows)).toEqual([30, 249, 220]);
    expect(opened.before).toBe(30);
    // What the reader wrote themselves is never new to them.
    expect((await detail(ada)).newFrom).toBeNull();
  });

  it("refuse a bad place, and a reader who cannot see the thread", async () => {
    const { ada, page, signUp } = await asides(3);
    const stranger = await signUp("Hedy Lamarr", "hedy@example.com");

    expect((await page(ada, -1)).status).toBe(400);
    expect((await page(ada, 3, 101)).status).toBe(400);
    expect((await page(stranger, 3)).status).toBe(404);
  });

  it("say who may try a failed run again, until a run starts", async () => {
    const workspace = await agentThread();
    const { ada, alan, org, db, thread, worker, post, start, threads } = workspace;
    org.defaultModel = null;
    db.run(sql`update thread set model = null where id = ${thread.id}`);
    start();
    await post(ada, "Hello");
    await worker.idle();
    const items: ThreadFollowItem[] = [];
    const stop = threads.follow(
      ada,
      thread.id,
      threads.visible(ada, thread.id).lastEventSeq,
      (item) => items.push(item),
    );

    expect((await threads.get(ada, thread.id)).rows.at(-1)).toMatchObject({
      kind: "failure",
      canRetry: true,
    });
    expect((await threads.get(alan, thread.id)).rows.at(-1)).toMatchObject({ canRetry: false });
    // Followed from the newest event, the row that may be tried again still comes once.
    expect(items).toMatchObject([{ kind: "rows", update: { rows: [{ canRetry: true }] } }]);

    // A message starts a run, which takes the retry away from the row while it stays as it was.
    await worker.stop();
    threads.postMessage(ada, thread.id, "Again");
    stop();
    const update = items.at(-1);
    expect(update?.kind === "rows" && update.update).toMatchObject({
      rows: [
        { kind: "failure", seq: 4, canRetry: false },
        { kind: "human", text: "Again" },
      ],
      run: { waiting: null },
    });
  });
});

describe("following a thread's rows", () => {
  it("sends each row's turn again when a later row changes it", async () => {
    const workspace = await agentThread();
    const { ada, thread, model, worker, post, start, app } = workspace;
    start();
    const stream = await openStream(app, ada.cookie, thread.id);
    await post(ada, "Hello");
    const call = await model.next();
    call.startStep();
    call.toolCall("call-1", "thread.info", {});
    call.endStep();
    call.end();
    (await model.next()).reply("Done.");
    await worker.idle();
    const sent: ShownRow[] = [];
    const done = (row: ShownRow) => row.kind === "agent" && !!row.text;
    while (!sent.some((row) => done(row))) {
      const next = await stream.nextRows();
      if (next.sseEvent === "rows") sent.push(...next.rows);
    }
    await stream.close();

    // The call opened the turn before the reply that names its model began.
    const tool = sent.filter((row) => row.kind === "tool");
    expect(tool[0]).toMatchObject({ turn: { continued: false, model: null } });
    expect(tool.at(-1)).toMatchObject({ turn: { continued: false, model: "codex/gpt-big" } });
    expect(tool.at(-1)!.seq).toBeGreaterThan(tool[0]!.seq);
  });
});

import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createCipher } from "@/server/kernel/cipher.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { setup } from "@/server/testing/workspace.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { eventSummary } from "@/server/threads/log.ts";
import { HISTORY_PAGE, type FiredHistory } from "@/shared/schedules-and-webhooks.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import { transcriptOf } from "@/shared/transcript.ts";

async function webhookThread() {
  const workspace = await agentThread();
  const { model, threadStore, thread } = workspace;
  const taken = new Set<Call>();
  let count = 0;

  async function callIn(threadId: string): Promise<Call> {
    for (;;) {
      const call = model.calls.find(
        (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
      );
      if (call) {
        taken.add(call);
        return call;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function calls(threadId: string, ...asked: [string, unknown][]) {
    const call = await callIn(threadId);
    call.startStep();
    call.delta("On it.");
    for (const [toolId, input] of asked) {
      count += 1;
      call.toolCall(`call-${count}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }

  async function answer(threadId: string, text = "Done.") {
    const call = await callIn(threadId);
    call.reply(text);
    return call;
  }

  async function rowsOf() {
    return transcriptOf((await threadStore.eventsAfter(thread.id, 0)).map(eventSummary)).rows;
  }

  // Sets webhooks and schedules the way the agent does, and returns what the tool gave back.
  async function set(...asked: [string, unknown][]) {
    await workspace.post(workspace.ada, "Set it up");
    await calls(thread.id, ...asked);
    return answer(thread.id);
  }

  return { ...workspace, calls, answer, rowsOf, set };
}

const MINUTE = 60_000;

function decide(t: Awaited<ReturnType<typeof webhookThread>>, callId: string, scope: string) {
  return t.api("POST", `/threads/${t.thread.id}/tools/${callId}/decision`, t.ada.cookie, {
    allow: true,
    scope,
  });
}

async function hook() {
  const t = await webhookThread();
  await t.start();
  await t.post(t.ada, "Set it up");
  await t.calls(t.thread.id, ["webhooks.add", { name: "Deploys", note: "Check the deploy" }]);
  await t.worker.idle();
  const pending = (await t.rowsOf()).find((one) => one.kind === "tool");
  expect((await decide(t, pending!.id, "once")).status).toBe(200);
  expect((await t.answer(t.thread.id)).texts.at(-1)).toBeDefined();
  await t.worker.idle();
  const row = (await t.rowsOf()).find(
    (one) => one.kind === "tool" && one.toolId === "webhooks.add",
  );
  const made = (row as { output?: { value?: { id: string; url: string } } }).output!.value!;
  // Its card, as a reader who may change it or not sees it.
  const card = async (canChange: boolean) => {
    const reader = await t.access.require(canChange ? t.ada : t.alan, t.thread.id);
    const call = { id: row!.id } as ToolRow;
    return (await t.webhooks.present(reader, [call]))(call)?.work;
  };
  const path = new URL(made.url).pathname;
  const post = (body: string, headers: Record<string, string> = {}, at = path) =>
    t.app.request(at, { method: "POST", body, headers });
  return { ...t, made, path, post, card };
}

describe("webhooks", () => {
  it("wait for a person every time, and cannot be allowed for now", async () => {
    const t = await webhookThread();
    await t.start();
    await t.post(t.ada, "Set it up");
    await t.calls(t.thread.id, ["webhooks.add", { name: "One", note: "a" }]);
    await t.worker.idle();
    const first = (await t.rowsOf()).find((one) => one.kind === "tool");
    expect(first).toMatchObject({ risk: "ask", state: "waiting" });
    expect((await decide(t, first!.id, "for_now")).status).toBe(400);
    expect((await decide(t, first!.id, "once")).status).toBe(200);
    await t.answer(t.thread.id);
    await t.worker.idle();

    await t.post(t.ada, "Another");
    await t.calls(t.thread.id, ["webhooks.add", { name: "Two", note: "b" }]);
    await t.worker.idle();
    const second = (await t.rowsOf()).filter((one) => one.kind === "tool").at(-1);
    expect(second).toMatchObject({ risk: "ask", state: "waiting" });
    expect(second!.id).not.toBe(first!.id);
  });

  it("takes a post as data for the agent, from outside the login", async () => {
    const t = await hook();
    expect(t.path).toMatch(/^\/api\/hooks\/.{20,}$/);
    const res = await t.post('{"ref":"main"}', {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    // The post starts the agent, which reads it as a notice.
    const call = await t.answer(t.thread.id);
    expect(JSON.stringify(call.request)).toContain("not a message from a person");
    await t.worker.idle();
    const notice = (await t.rowsOf()).find(
      (row) => row.kind === "notice" && row.type === "webhook.received",
    );
    expect(notice).toMatchObject({ text: expect.stringContaining("Deploys") });
    expect((notice as { last?: string }).last).toContain('{"ref":"main"}');
    expect(notice).toMatchObject({
      delivery: { contentType: "application/json", bytes: 14, signed: false },
    });
    expect((await t.card(true))?.webhook).toMatchObject({
      name: "Deploys",
      signed: false,
      canChange: true,
    });
    expect((await t.card(false))?.webhook?.path).toBeUndefined();
  });

  it("refuses a name another live schedule or webhook has, whatever the case, and takes it again once deleted", async () => {
    const t = await webhookThread();
    await t.start();
    const clash = await t.set(
      ["schedules.add", { name: "Daily", cron: "0 9 * * *", prompt: "Go" }],
      ["schedules.add", { name: "daily", cron: "0 10 * * *", prompt: "Go" }],
    );
    expect(clash.texts.join("\n")).toContain("A schedule named Daily already exists here");
    await t.worker.idle();
    const [made] = await t.schedules.inThread(t.thread.id);
    expect(await t.schedules.inThread(t.thread.id)).toHaveLength(1);

    expect(await t.schedules.removeFor(t.thread.id, made!.id)).toBe(true);
    await t.post(t.ada, "Again");
    await t.calls(t.thread.id, [
      "schedules.add",
      { name: "daily", cron: "0 10 * * *", prompt: "Go" },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    expect((await t.schedules.inThread(t.thread.id)).map((one) => one.name)).toEqual(["daily"]);
  });

  it("lists what it took, newest first, a page at a time, to anyone who may read the thread", async () => {
    const t = await hook();
    const url = `/threads/${t.thread.id}/webhooks/${t.made.id}/history`;
    const page = async (who: { cookie: string }, offset = 0) => {
      const res = await t.api("GET", `${url}?offset=${offset}`, who.cookie);
      return { status: res.status, body: (await res.json()) as FiredHistory };
    };
    expect((await page(t.ada)).body).toMatchObject({ entries: [], total: 0 });

    for (let n = 1; n <= 12; n += 1) {
      t.clock.now = new Date(t.clock.now.getTime() + MINUTE);
      const res = await t.post(JSON.stringify({ n }), {
        "content-type": "application/json",
      });
      expect(res.status).toBe(200);
    }
    const first = (await page(t.ada)).body;
    expect(first.total).toBe(12);
    expect(first.entries).toHaveLength(HISTORY_PAGE);
    const times = first.entries.map((entry) => entry.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(first.entries[0]).toMatchObject({
      delivery: { contentType: "application/json", bytes: 8, signed: false },
    });
    expect((await t.card(true))?.webhook?.fired).toBe(12);

    const second = (await page(t.ada, HISTORY_PAGE)).body;
    expect(second.entries).toHaveLength(2);
    expect(second.entries[0]!.at < times.at(-1)!).toBe(true);
    const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(12);

    // A reader sees it as well; someone with no access to the thread, or a bad offset, does not.
    expect((await page(t.alan)).body.total).toBe(12);
    const hedy = await t.signUp("Hedy Lamarr", "hedy@example.com");
    expect((await page(hedy)).status).toBeGreaterThanOrEqual(400);
    expect((await t.api("GET", `${url}?offset=-1`, t.ada.cookie)).status).toBe(400);
    expect(
      (await t.api("GET", `/threads/${t.thread.id}/webhooks/nope/history`, t.ada.cookie)).status,
    ).toBe(404);
  });

  it("is not found once unknown or deleted, and refuses what is too big or paused", async () => {
    const t = await hook();
    expect((await t.post("{}", {}, "/api/hooks/nope")).status).toBe(404);
    expect((await t.post("x".repeat(300 * 1024))).status).toBe(413);
    const base = `/threads/${t.thread.id}/webhooks/${t.made.id}`;
    expect((await t.api("POST", `${base}/pause`, t.ada.cookie)).status).toBe(200);
    expect((await t.post("{}")).status).toBe(409);
    expect((await t.api("POST", `${base}/resume`, t.ada.cookie)).status).toBe(200);
    expect((await t.post("{}")).status).toBe(200);
    expect((await t.api("DELETE", base, t.ada.cookie)).status).toBe(200);
    expect((await t.post("{}")).status).toBe(404);
  });

  it("tells the agent, without waking it, when a person sets or clears the signature", async () => {
    const t = await hook();
    const calls = t.model.calls.length;
    const base = `/threads/${t.thread.id}/webhooks/${t.made.id}/secret`;
    await t.api("PUT", base, t.grace.cookie, { secret: "s3" });
    await t.api("PUT", base, t.grace.cookie, { secret: null });
    await t.worker.idle();
    expect(t.model.calls.length).toBe(calls);
    const told = (await t.rowsOf()).flatMap((row) => (row.kind === "notice" ? [row] : []));
    expect(told.map((row) => [row.type, row.text, row.tray])).toEqual([
      ["change", "Grace Hopper set the signature of webhook Deploys", "webhooks"],
      ["change", "Grace Hopper cleared the signature of webhook Deploys", "webhooks"],
    ]);
  });

  it("takes only signed posts once a person sets a signing secret", async () => {
    const t = await hook();
    const base = `/threads/${t.thread.id}/webhooks/${t.made.id}`;
    expect(
      (await t.api("PUT", `${base}/secret`, t.alan.cookie, { secret: "s3" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await t.api("PUT", `${base}/secret`, t.ada.cookie, { secret: "s3" })).status).toBe(200);
    expect((await t.card(true))?.webhook?.signed).toBe(true);
    expect((await t.post("{}")).status).toBe(403);
    expect((await t.post("{}", { "x-hub-signature-256": "sha256=00" })).status).toBe(403);
    const sign = createHmac("sha256", "s3").update("{}").digest("hex");
    expect((await t.post("{}", { "x-hub-signature-256": `sha256=${sign}` })).status).toBe(200);
    expect((await t.api("PUT", `${base}/secret`, t.ada.cookie, { secret: null })).status).toBe(200);
    expect((await t.post("{}")).status).toBe(200);
  });
});

describe("a post", () => {
  it("and its noting are one write: a listener that throws leaves neither", async () => {
    const t = await hook();
    t.queue.onEnqueued(async () => {
      throw new Error("after the post, for this test");
    });
    const res = await t.post("{}");
    expect(res.status).toBe(500);
    expect((await t.rowsOf()).filter((row) => row.kind === "notice")).toHaveLength(0);
    const row = await t.webhooks.find(t.thread.id, t.made.id);
    expect(row?.lastReceivedAt).toBeNull();
  });

  it("with a delivery id longer than a key holds is taken once", async () => {
    const t = await hook();
    const headers = { "X-GitHub-Delivery": "d".repeat(5000) };
    expect((await t.post("{}", headers)).status).toBe(200);
    expect((await t.post("{}", headers)).status).toBe(200);
    await t.answer(t.thread.id);
    await t.worker.idle();
    expect((await t.rowsOf()).filter((row) => row.kind === "notice")).toHaveLength(1);
  });

  it("opens a secret sealed to the webhook as it always was", async () => {
    const t = await hook();
    const cipher = createCipher({ version: 1, key: Buffer.alloc(32, 7) });
    const sealed = cipher.seal(Buffer.from("old-secret"), `thread_trigger.secret:${t.made.id}`);
    await t.db.execute(
      sql`update webhook set secret = ${sealed.data}, secret_key_version = ${sealed.keyVersion}
           where id = ${t.made.id}`,
    );
    const body = "{}";
    const signature = `sha256=${createHmac("sha256", "old-secret").update(body).digest("hex")}`;
    expect((await t.post(body, { "X-Hub-Signature-256": signature })).status).toBe(200);
    await t.answer(t.thread.id);
    await t.worker.idle();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("on Postgres, a delivery", () => {
  it("waits for a pause committing first, and is refused", async () => {
    const t = await hook();
    let delivered: Promise<Response> | Response | undefined;
    await t.database.db.transaction(async (tx) => {
      await tx.execute(sql`update webhook set status = 'paused' where id = ${t.made.id}`);
      delivered = t.post("{}");
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect((await delivered!).status).toBe(409);
    expect((await t.rowsOf()).filter((row) => row.kind === "notice")).toHaveLength(0);
  });

  it("posted twice at once through two instances is taken once", async () => {
    const t = await hook();
    const other = setup({}, { database: t.database });
    const headers = { "X-GitHub-Delivery": "d-1" };
    const codes = await Promise.all([
      t.post("{}", headers),
      other.app.request(t.path, { method: "POST", body: "{}", headers }),
    ]);
    expect(codes.map((res) => res.status)).toEqual([200, 200]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    expect((await t.rowsOf()).filter((row) => row.kind === "notice")).toHaveLength(1);
  });
});

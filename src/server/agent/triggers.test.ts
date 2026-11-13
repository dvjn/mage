import { createHmac } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { NOTIFICATIONS_HEADING } from "@/server/agent/context.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import { eventSummary } from "@/server/threads/log.ts";
import { describeCron, HISTORY_PAGE, type TriggerHistory } from "@/shared/triggers.ts";
import { transcriptOf } from "@/shared/transcript.ts";

async function triggerThread() {
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

  function rowsOf() {
    return transcriptOf(threadStore.eventsAfter(thread.id, 0).map(eventSummary)).rows;
  }

  // Sets triggers the way the agent does, and returns what the tool gave back.
  async function set(...asked: [string, unknown][]) {
    await workspace.post(workspace.ada, "Set it up");
    await calls(thread.id, ...asked);
    return answer(thread.id);
  }

  return { ...workspace, calls, answer, rowsOf, set };
}

const MINUTE = 60_000;

describe("describeCron", () => {
  it("puts common expressions in words and leaves the rest as written", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30");
    expect(describeCron("0 8 * * *")).toBe("Every day at 08:00");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 08:00");
    expect(describeCron("5 4 1,15 * *")).toBe("5 4 1,15 * *");
  });
});

describe("wake-up timers", () => {
  it("wake the agent once, with the note and the people who steered the call", async () => {
    const t = await triggerThread();
    t.start();
    const set = await t.set(["triggers.wake_at", { in_seconds: 600, note: "Check the build" }]);
    expect(set.texts.at(-1)).toContain('"id"');
    await t.worker.idle();

    // Nothing happens before its time.
    expect(t.triggers.tick()).toBe(0);
    t.clock.now = new Date(t.clock.now.getTime() + 11 * MINUTE);
    expect(t.triggers.tick()).toBe(1);
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toContain("Wake-up timer went off");
    expect(told.texts.at(-1)).toContain("Check the build");
    await t.worker.idle();

    // It was the notification that carried the people.
    const relay = t.rowsOf().find((row) => row.kind === "relay");
    expect(relay).toMatchObject({ type: "trigger.fired" });
    expect(relay?.kind === "relay" && relay.steeredBy.map((one) => one.name)).toEqual([
      "Ada Lovelace",
    ]);

    // It does not go off again, and is gone from the list.
    t.clock.now = new Date(t.clock.now.getTime() + 60 * MINUTE);
    expect(t.triggers.tick()).toBe(0);
    await t.post(t.ada, "What is set?");
    await t.calls(t.thread.id, ["triggers.list", {}]);
    const listed = await t.answer(t.thread.id);
    expect(listed.texts.at(-1)).toContain('"triggers":[]');
  });

  it("refuse a time that is unclear or has passed", async () => {
    const t = await triggerThread();
    t.start();
    await t.post(t.ada, "Set it up");
    await t.calls(
      t.thread.id,
      ["triggers.wake_at", { note: "x" }],
      ["triggers.wake_at", { in_seconds: 5, at: "2099-01-01T00:00:00Z", note: "x" }],
      ["triggers.wake_at", { at: "2001-01-01T00:00:00Z", note: "x" }],
      ["triggers.wake_at", { at: "soon", note: "x" }],
    );
    const refused = (await t.answer(t.thread.id)).texts.join("\n");
    expect(refused).toContain("Give in_seconds or at");
    expect(refused).toContain("That time has passed.");
    expect(refused).toContain("is not a time");
  });
});

describe("schedules", () => {
  it("fire on their cron in their zone, and once for what was missed while down", async () => {
    const t = await triggerThread();
    t.start();
    t.clock.now = new Date("2030-01-07T08:59:00Z");
    await t.set([
      "triggers.schedule",
      {
        name: "Digest",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Write the digest",
      },
    ]);
    await t.worker.idle();
    t.clock.now = new Date("2030-01-07T09:00:30Z");
    expect(t.triggers.tick()).toBe(1);
    const told = await t.answer(t.thread.id);
    expect(told.texts.at(-1)).toContain('Schedule "Digest" fired');
    expect(told.texts.at(-1)).toContain("Write the digest");
    await t.worker.idle();
    expect(t.rowsOf().find((row) => row.kind === "relay")).toMatchObject({
      schedule: "Every day at 09:00",
    });

    // Days pass with the server down: it fires once, then waits for the next 09:00.
    t.clock.now = new Date("2030-01-10T12:00:00Z");
    expect(t.triggers.tick()).toBe(1);
    expect(t.triggers.tick()).toBe(0);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [record] = t.db.all<{ next_run_at: number }>(
      "select next_run_at from thread_trigger" as never,
    );
    expect(new Date(record!.next_run_at).toISOString()).toBe("2030-01-11T09:00:00.000Z");
  });

  it("are listed and deleted by the agent, and refuse a bad cron or zone", async () => {
    const t = await triggerThread();
    t.start();
    const bad = await t.set(
      ["triggers.schedule", { name: "A", cron: "* * *", prompt: "x" }],
      ["triggers.schedule", { name: "B", cron: "0 9 * * *", timezone: "Mars/Base", prompt: "x" }],
      ["triggers.schedule", { name: "C", cron: "99 9 * * *", prompt: "x" }],
    );
    const refused = bad.texts.join("\n");
    expect(refused).toContain("needs five fields");
    expect(refused).toContain("not a time zone");
    expect(refused).toContain("not valid");
    await t.worker.idle();

    await t.post(t.ada, "Again");
    await t.calls(t.thread.id, [
      "triggers.schedule",
      { name: "Daily", cron: "0 9 * * *", prompt: "Go" },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    const [made] = t.triggerStore.inThread(t.thread.id);
    expect(made).toMatchObject({
      name: "Daily",
      timezone: "UTC",
      status: "active",
    });

    await t.post(t.ada, "Remove it");
    await t.calls(t.thread.id, ["triggers.list", {}], ["triggers.delete", { id: made!.id }]);
    const after = await t.answer(t.thread.id);
    expect(after.texts.join("\n")).toContain('"name":"Daily"');
    expect(after.texts.join("\n")).toContain(`"deleted":"${made!.id}"`);
    expect(t.triggerStore.inThread(t.thread.id)).toEqual([]);
  });
});

describe("with several server instances", () => {
  async function due() {
    const t = await triggerThread();
    t.start();
    await t.set(["triggers.wake_at", { in_seconds: 60, note: "Once only" }]);
    await t.worker.idle();
    t.clock.now = new Date(t.clock.now.getTime() + 2 * MINUTE);
    return t;
  }

  it("fire a due trigger once, whichever instance looks first", async () => {
    const t = await due();
    const other = t.triggersFor();
    expect(t.triggers.tick() + other.tick()).toBe(1);
    expect(other.tick() + t.triggers.tick()).toBe(0);
    await t.answer(t.thread.id);
    expect(t.rowsOf().filter((row) => row.kind === "relay")).toHaveLength(1);
  });

  it("move a due trigger on once: a move on the row as it was read before loses", async () => {
    const t = await due();
    const [seen] = t.triggerStore.due(t.clock.now, 10);
    expect(
      t.triggerStore.advance(seen!, { nextRunAt: null, lastFiredAt: t.clock.now }),
    ).not.toBeNull();
    expect(t.triggerStore.advance(seen!, { nextRunAt: null, lastFiredAt: t.clock.now })).toBeNull();
  });
});

describe("the card and its controls", () => {
  it("show a schedule's state, and people who may post pause, resume and delete it", async () => {
    const t = await triggerThread();
    t.start();
    t.clock.now = new Date("2030-01-07T08:00:00Z");
    await t.set([
      "triggers.schedule",
      {
        name: "Digest",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
        prompt: "Write it",
      },
    ]);
    await t.worker.idle();
    const [made] = t.triggerStore.inThread(t.thread.id);
    const path = (action: string) => `/threads/${t.thread.id}/triggers/${made!.id}${action}`;

    const card = () => t.triggers.workFor(made!.id, t.thread.id, true)!;
    expect(card()).toMatchObject({
      kind: "schedule",
      status: "scheduled",
      schedule: {
        name: "Digest",
        words: "Weekdays at 09:00",
        nextRunAt: "2030-01-07T09:00:00.000Z",
        canChange: true,
      },
    });
    expect(t.triggers.workFor(made!.id, t.thread.id, false)?.schedule?.canChange).toBe(false);

    // A reader may not.
    expect((await t.api("POST", path("/pause"), t.alan.cookie)).status).toBeGreaterThanOrEqual(400);

    expect((await t.api("POST", path("/pause"), t.grace.cookie)).status).toBe(200);
    expect(card().status).toBe("paused");
    // Nothing fires while it is paused; resuming works the next time out from now.
    t.clock.now = new Date("2030-01-07T10:00:00Z");
    expect(t.triggers.tick()).toBe(0);
    expect((await t.api("POST", path("/resume"), t.ada.cookie)).status).toBe(200);
    expect(card().schedule?.nextRunAt).toBe("2030-01-08T09:00:00.000Z");

    expect((await t.api("DELETE", path(""), t.ada.cookie)).status).toBe(200);
    expect(card().status).toBe("cancelled");
    t.clock.now = new Date("2030-01-09T10:00:00Z");
    expect(t.triggers.tick()).toBe(0);
    expect((await t.api("POST", path("/pause"), t.ada.cookie)).status).toBe(404);
  });

  it("tell the agent, without waking it, what a person did to them, and who", async () => {
    const t = await triggerThread();
    t.start();
    await t.set([
      "triggers.schedule",
      { name: "Digest", cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Go" },
    ]);
    await t.worker.idle();
    const [schedule] = t.triggerStore.inThread(t.thread.id);
    const base = `/threads/${t.thread.id}/triggers/${schedule!.id}`;
    const calls = t.model.calls.length;
    await t.api("POST", `${base}/pause`, t.grace.cookie);
    await t.api("POST", `${base}/resume`, t.grace.cookie);
    await t.api("DELETE", base, t.grace.cookie);
    await t.worker.idle();
    expect(t.model.calls.length).toBe(calls);
    const told = t.rowsOf().flatMap((row) => (row.kind === "relay" ? [row] : []));
    expect(told.map((row) => [row.type, row.text, row.tray])).toEqual([
      ["change", "Grace Hopper paused schedule Digest", "triggers"],
      ["change", "Grace Hopper resumed schedule Digest", "triggers"],
      ["change", "Grace Hopper deleted schedule Digest", "triggers"],
    ]);
    expect(told.map((row) => row.change)).toEqual([
      { subject: { kind: "schedule", name: "Digest" }, action: "pause" },
      { subject: { kind: "schedule", name: "Digest" }, action: "resume" },
      { subject: { kind: "schedule", name: "Digest" }, action: "delete" },
    ]);
    await t.post(t.ada, "Go on");
    const next = await t.answer(t.thread.id);
    expect(next.texts.at(-1)).toBe(
      `user: ${NOTIFICATIONS_HEADING}\n\n${told.map((row) => row.text).join("\n\n")}`,
    );
  });

  it("shows on the tool call's row in the thread", async () => {
    const t = await triggerThread();
    t.start();
    await t.set(["triggers.wake_at", { in_seconds: 600, note: "Look again" }]);
    await t.worker.idle();
    const res = await t.api("GET", `/threads/${t.thread.id}`, t.ada.cookie);
    const { rows } = (await res.json()) as {
      rows: {
        kind: string;
        toolId?: string;
        background?: { kind: string; status: string };
      }[];
    };
    const call = rows.find((row) => row.toolId === "triggers.wake_at");
    expect(call?.background).toMatchObject({
      kind: "schedule",
      status: "scheduled",
    });
  });
});

function decide(t: Awaited<ReturnType<typeof triggerThread>>, callId: string, scope: string) {
  return t.api("POST", `/threads/${t.thread.id}/tools/${callId}/decision`, t.ada.cookie, {
    allow: true,
    scope,
  });
}

describe("webhooks", () => {
  it("wait for a person every time, and cannot be allowed for now", async () => {
    const t = await triggerThread();
    t.start();
    await t.post(t.ada, "Set it up");
    await t.calls(t.thread.id, ["triggers.add_webhook", { name: "One", note: "a" }]);
    await t.worker.idle();
    const first = t.rowsOf().find((one) => one.kind === "tool");
    expect(first).toMatchObject({ risk: "ask", state: "pending" });
    expect((await decide(t, first!.id, "for_now")).status).toBe(400);
    expect((await decide(t, first!.id, "once")).status).toBe(200);
    await t.answer(t.thread.id);
    await t.worker.idle();

    await t.post(t.ada, "Another");
    await t.calls(t.thread.id, ["triggers.add_webhook", { name: "Two", note: "b" }]);
    await t.worker.idle();
    const second = t
      .rowsOf()
      .filter((one) => one.kind === "tool")
      .at(-1);
    expect(second).toMatchObject({ risk: "ask", state: "pending" });
    expect(second!.id).not.toBe(first!.id);
  });

  async function hook() {
    const t = await triggerThread();
    t.start();
    await t.post(t.ada, "Set it up");
    await t.calls(t.thread.id, [
      "triggers.add_webhook",
      { name: "Deploys", note: "Check the deploy" },
    ]);
    await t.worker.idle();
    const pending = t.rowsOf().find((one) => one.kind === "tool");
    expect((await decide(t, pending!.id, "once")).status).toBe(200);
    expect((await t.answer(t.thread.id)).texts.at(-1)).toBeDefined();
    await t.worker.idle();
    const row = t
      .rowsOf()
      .find((one) => one.kind === "tool" && one.toolId === "triggers.add_webhook");
    const made = (row as { output?: { value?: { id: string; url: string } } }).output!.value!;
    const path = new URL(made.url).pathname;
    const post = (body: string, headers: Record<string, string> = {}, at = path) =>
      t.app.request(at, { method: "POST", body, headers });
    return { ...t, made, path, post };
  }

  it("takes a post as data for the agent, from outside the login", async () => {
    const t = await hook();
    expect(t.path).toMatch(/^\/api\/hooks\/.{20,}$/);
    const res = await t.post('{"ref":"main"}', {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    // The post starts the agent, which reads it as a notification.
    const call = await t.answer(t.thread.id);
    expect(JSON.stringify(call.request)).toContain("not a message from a person");
    await t.worker.idle();
    const notice = t
      .rowsOf()
      .find((row) => row.kind === "relay" && row.type === "webhook.received");
    expect(notice).toMatchObject({ text: expect.stringContaining("Deploys") });
    expect((notice as { last?: string }).last).toContain('{"ref":"main"}');
    expect(notice).toMatchObject({
      delivery: { contentType: "application/json", bytes: 14, signed: false },
    });
    expect(t.triggers.workFor(t.made.id, t.thread.id, true)?.webhook).toMatchObject({
      name: "Deploys",
      signed: false,
      canChange: true,
    });
    expect(t.triggers.workFor(t.made.id, t.thread.id, false)?.webhook?.path).toBeUndefined();
  });

  it("counts and lists a firing recorded before notifications carried the trigger's id", async () => {
    const t = await hook();
    const at = (ms: number) => new Date(Date.now() + ms);
    const old = (name: string, createdAt: Date, kind = "webhook.received") =>
      t.log.write(t.thread.id, (append) =>
        append({
          type: "notification",
          actor: { kind: "agent" },
          createdAt,
          data: {
            kind,
            source: { threadId: t.thread.id, name, main: true },
            text: `Webhook "${name}" was posted to: {}`,
            people: [],
            wake: false,
          },
        } as never),
      );
    old("Deploys", at(MINUTE));
    old("Deploys", at(-MINUTE));
    old("Other", at(2 * MINUTE));
    old("Deploys", at(3 * MINUTE), "trigger.fired");
    const res = await t.api(
      "GET",
      `/threads/${t.thread.id}/triggers/${t.made.id}/history`,
      t.ada.cookie,
    );
    expect(((await res.json()) as TriggerHistory).total).toBe(1);
    expect(t.triggers.workFor(t.made.id, t.thread.id, true)?.webhook?.fired).toBe(1);
  });

  it("leaves an old firing with no one when two triggers of the name could own it", async () => {
    const t = await hook();
    const second = t.triggerStore.create({
      id: "second-deploys",
      threadId: t.thread.id,
      kind: "webhook",
      name: "Deploys",
      cron: null,
      timezone: null,
      prompt: "Again",
      steeredBy: [],
      createdByLabel: "Mage",
      status: "active",
      nextRunAt: null,
      hookToken: "second-token",
    });
    t.log.write(t.thread.id, (append) =>
      append({
        type: "notification",
        actor: { kind: "agent" },
        createdAt: new Date(Date.now() + MINUTE),
        data: {
          kind: "webhook.received",
          source: { threadId: t.thread.id, name: "Deploys", main: true },
          text: 'Webhook "Deploys" was posted to: {}',
          people: [],
          wake: false,
        },
      } as never),
    );
    const fired = () => t.triggers.workFor(t.made.id, t.thread.id, true)?.webhook?.fired;
    expect(fired()).toBe(0);
    // Once the other is deleted without ever firing, the event can only be this one's.
    t.triggerStore.update(second.id, { status: "deleted" });
    expect(fired()).toBe(1);
  });

  it("refuses a name another live trigger has, whatever the case, and takes it again once deleted", async () => {
    const t = await triggerThread();
    t.start();
    const clash = await t.set(
      ["triggers.schedule", { name: "Daily", cron: "0 9 * * *", prompt: "Go" }],
      ["triggers.schedule", { name: "daily", cron: "0 10 * * *", prompt: "Go" }],
    );
    expect(clash.texts.join("\n")).toContain("A schedule named Daily already exists here");
    await t.worker.idle();
    const [made] = t.triggerStore.inThread(t.thread.id);
    expect(t.triggerStore.inThread(t.thread.id)).toHaveLength(1);

    t.triggerStore.update(made!.id, { status: "deleted" });
    await t.post(t.ada, "Again");
    await t.calls(t.thread.id, [
      "triggers.schedule",
      { name: "daily", cron: "0 10 * * *", prompt: "Go" },
    ]);
    await t.answer(t.thread.id);
    await t.worker.idle();
    expect(t.triggerStore.inThread(t.thread.id).map((one) => one.name)).toEqual(["daily"]);
  });

  it("lists what it took, newest first, a page at a time, to anyone who may read the thread", async () => {
    const t = await hook();
    const url = `/threads/${t.thread.id}/triggers/${t.made.id}/history`;
    const page = async (who: { cookie: string }, offset = 0) => {
      const res = await t.api("GET", `${url}?offset=${offset}`, who.cookie);
      return { status: res.status, body: (await res.json()) as TriggerHistory };
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
    expect(t.triggers.workFor(t.made.id, t.thread.id, true)?.webhook?.fired).toBe(12);

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
      (await t.api("GET", `/threads/${t.thread.id}/triggers/nope/history`, t.ada.cookie)).status,
    ).toBe(404);
  });

  it("is not found once unknown or deleted, and refuses what is too big or paused", async () => {
    const t = await hook();
    expect((await t.post("{}", {}, "/api/hooks/nope")).status).toBe(404);
    expect((await t.post("x".repeat(300 * 1024))).status).toBe(413);
    const base = `/threads/${t.thread.id}/triggers/${t.made.id}`;
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
    const base = `/threads/${t.thread.id}/triggers/${t.made.id}/secret`;
    await t.api("PUT", base, t.grace.cookie, { secret: "s3" });
    await t.api("PUT", base, t.grace.cookie, { secret: null });
    await t.worker.idle();
    expect(t.model.calls.length).toBe(calls);
    const told = t.rowsOf().flatMap((row) => (row.kind === "relay" ? [row] : []));
    expect(told.map((row) => [row.type, row.text, row.tray])).toEqual([
      ["change", "Grace Hopper set the signature of webhook Deploys", "webhooks"],
      ["change", "Grace Hopper cleared the signature of webhook Deploys", "webhooks"],
    ]);
  });

  it("takes only signed posts once a person sets a signing secret", async () => {
    const t = await hook();
    const base = `/threads/${t.thread.id}/triggers/${t.made.id}`;
    expect(
      (await t.api("PUT", `${base}/secret`, t.alan.cookie, { secret: "s3" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await t.api("PUT", `${base}/secret`, t.ada.cookie, { secret: "s3" })).status).toBe(200);
    expect(t.triggers.workFor(t.made.id, t.thread.id, true)?.webhook?.signed).toBe(true);
    expect((await t.post("{}")).status).toBe(403);
    expect((await t.post("{}", { "x-hub-signature-256": "sha256=00" })).status).toBe(403);
    const sign = createHmac("sha256", "s3").update("{}").digest("hex");
    expect((await t.post("{}", { "x-hub-signature-256": `sha256=${sign}` })).status).toBe(200);
    expect((await t.api("PUT", `${base}/secret`, t.ada.cookie, { secret: null })).status).toBe(200);
    expect((await t.post("{}")).status).toBe(200);
  });
});

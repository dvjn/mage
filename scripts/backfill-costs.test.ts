import { describe, expect, it } from "vite-plus/test";

import { connection } from "../src/server/models/schema.ts";
import { agentThread } from "../src/server/testing/agent-thread.ts";
import type { Usage } from "../src/shared/usage.ts";

import { applyCostBackfill, planCostBackfill } from "./backfill-costs.ts";

async function fixture() {
  const workspace = await agentThread();
  const { ada, db, thread, threadStore } = workspace;
  db.insert(connection)
    .values({
      id: "cloud",
      organizationId: ada.orgId,
      createdBy: ada.userId,
      host: "bedrock",
      authKind: "cloud",
      account: "test",
    })
    .run();
  let next = 0;
  function reply(
    model: string | undefined,
    usage: Usage = { inputTokens: 1000, outputTokens: 100 },
  ) {
    const messageId = `message-${++next}`;
    threadStore.append(thread.id, {
      type: "message.started",
      actor: { kind: "agent" },
      data: { messageId, runId: "run", ...(model && { model }) },
    });
    return threadStore.append(thread.id, {
      type: "message.completed",
      actor: { kind: "agent" },
      data: {
        messageId,
        runId: "run",
        parts: [{ type: "text", text: "Reply" }],
        status: "completed",
        usage,
      },
    });
  }
  function stored(id: string) {
    const row = db.$client.prepare("select data from thread_event where id = ?").get(id) as {
      data: string;
    };
    return JSON.parse(row.data);
  }
  return { ...workspace, reply, stored };
}

const model = "cloud/anthropic.claude-haiku-5-5";
const ratesAsOf = "2026-11-10";

describe("historical cost backfill", () => {
  it("previews without writing, preserves recorded fields and costs, and is idempotent", async () => {
    const { db, reply, stored } = await fixture();
    const old = reply(model);
    const cached = reply(model, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 });
    const reported = reply(model, {
      inputTokens: 1000,
      outputTokens: 100,
      cost: { usd: 0.123, source: "provider" },
    });
    db.$client
      .prepare(
        "update thread_event set data = json_set(data, '$.unrelated', 'keep', '$.usage.future', 123) where id = ?",
      )
      .run(old.id);
    const before = stored(old.id);
    const plan = planCostBackfill(db.$client, ratesAsOf);
    expect(plan.summary).toMatchObject({
      eligible: 2,
      cacheUnknown: 1,
      skipped: { existingCost: 1 },
    });
    expect(stored(old.id)).toEqual(before);
    expect(applyCostBackfill(db.$client, plan)).toEqual({ updated: 2, conflicts: 0 });
    expect(stored(old.id)).toMatchObject({
      unrelated: "keep",
      usage: {
        future: 123,
        cost: { source: "estimated", backfilled: true, cacheUnknown: true, ratesAsOf },
      },
    });
    expect(stored(cached.id).usage.cost.cacheUnknown).toBeUndefined();
    expect(stored(cached.id).usage.cost.usd).toBeLessThan(stored(old.id).usage.cost.usd);
    expect(stored(reported.id).usage.cost).toEqual({ usd: 0.123, source: "provider" });
    expect(planCostBackfill(db.$client, ratesAsOf).summary.eligible).toBe(0);
  });

  it("skips subscriptions, unknown models and cross-org or deleted connections without guessing defaults", async () => {
    const { db, reply, thread, threadStore, signUp } = await fixture();
    reply("codex/gpt-5");
    reply(undefined);
    reply("cloud/unknown-model");
    reply("removed/gemini-3.8-flash");
    const other = await signUp("Other", "other@example.com");
    db.insert(connection)
      .values({
        id: "other-cloud",
        organizationId: other.orgId,
        createdBy: other.userId,
        host: "bedrock",
        authKind: "cloud",
        account: "test",
      })
      .run();
    reply("other-cloud/anthropic.claude-haiku-5-5");
    threadStore.append(thread.id, {
      type: "thread.renamed",
      actor: { kind: "agent" },
      data: { title: "Title", usage: { inputTokens: 10, outputTokens: 5 } },
    });
    expect(planCostBackfill(db.$client, ratesAsOf).summary).toMatchObject({
      eligible: 0,
      skipped: { subscription: 1, missingModel: 2, missingRate: 1, missingConnection: 2 },
    });
  });

  it("rolls back on failure and never replaces a charge recorded after the preview", async () => {
    const { db, reply, stored } = await fixture();
    const first = reply(model);
    const second = reply(model);
    const plan = planCostBackfill(db.$client, ratesAsOf);
    db.$client.exec(
      `create trigger fail_backfill before update on thread_event when old.id = '${second.id}' begin select raise(abort, 'blocked'); end`,
    );
    expect(() => applyCostBackfill(db.$client, plan)).toThrow("blocked");
    expect(stored(first.id).usage.cost).toBeUndefined();
    db.$client.exec("drop trigger fail_backfill");
    const data = stored(first.id);
    data.usage.cost = { usd: 0.01, source: "provider" };
    db.$client
      .prepare("update thread_event set data = ? where id = ?")
      .run(JSON.stringify(data), first.id);
    expect(applyCostBackfill(db.$client, plan)).toEqual({ updated: 1, conflicts: 1 });
    expect(stored(first.id).usage.cost).toEqual({ usd: 0.01, source: "provider" });
  });
});

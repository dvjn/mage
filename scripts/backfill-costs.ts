// Backfills missing reply costs from the model recorded when each reply started. Current
// defaults cannot identify historical models. No charge is invented for subscription sign-ins,
// removed connections, unknown rates, or background calls that did not record their model.
// Run without --apply to preview. Applying creates a SQLite backup, including its WAL.
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import Database from "better-sqlite3";

import { isHost } from "../src/shared/hosts.ts";
import { estimateCost } from "../src/shared/model-pricing.ts";
import { usageSchema } from "../src/shared/usage.ts";
import { pricingOf } from "../src/server/models/model-data.ts";

interface Candidate {
  id: string;
  data: string;
  model: string | null;
  host: string | null;
  authKind: string | null;
}

export interface BackfillPlan {
  updates: { id: string; before: string; after: string }[];
  summary: {
    eligible: number;
    estimatedUsd: number;
    cacheUnknown: number;
    skipped: {
      existingCost: number;
      missingModel: number;
      missingConnection: number;
      subscription: number;
      missingRate: number;
      invalidUsage: number;
    };
  };
}

export function planCostBackfill(db: Database.Database, ratesAsOf: string): BackfillPlan {
  const rows = db
    .prepare(`
    select e.id, e.data,
      json_extract(started.data, '$.model') as model,
      c.host, c.auth_kind as authKind
    from thread_event e
    join thread t on t.id = e.thread_id
    join space s on s.id = t.space_id
    left join thread_event started on started.id = (
      select id from thread_event
      where thread_id = e.thread_id and type = 'message.started' and seq < e.seq
        and json_extract(data, '$.messageId') = json_extract(e.data, '$.messageId')
      order by seq desc limit 1
    )
    left join connection c on c.organization_id = s.organization_id
      and c.id = substr(json_extract(started.data, '$.model'), 1,
        instr(json_extract(started.data, '$.model'), '/') - 1)
    where e.type in ('message.completed', 'thread.renamed', 'thread.compacted')
      and json_type(e.data, '$.usage') is not null
  `)
    .all() as Candidate[];
  const result: BackfillPlan = {
    updates: [],
    summary: {
      eligible: 0,
      estimatedUsd: 0,
      cacheUnknown: 0,
      skipped: {
        existingCost: 0,
        missingModel: 0,
        missingConnection: 0,
        subscription: 0,
        missingRate: 0,
        invalidUsage: 0,
      },
    },
  };
  for (const row of rows) {
    const data = JSON.parse(row.data) as { usage?: unknown };
    if (data.usage && typeof data.usage === "object" && "cost" in data.usage) {
      result.summary.skipped.existingCost++;
      continue;
    }
    const parsed = usageSchema.safeParse(data.usage);
    if (!parsed.success) {
      result.summary.skipped.invalidUsage++;
      continue;
    }
    if (typeof row.model !== "string" || !row.model.includes("/")) {
      result.summary.skipped.missingModel++;
      continue;
    }
    const slash = row.model.indexOf("/");
    const prefix = row.model.slice(0, slash);
    // Sign-in refs use the host, not a connection id, including after it was removed.
    if (prefix === "codex" || prefix === "claude" || row.authKind === "oauth") {
      result.summary.skipped.subscription++;
      continue;
    }
    if (!row.host || !isHost(row.host)) {
      result.summary.skipped.missingConnection++;
      continue;
    }
    const pricing = pricingOf(row.host, row.model.slice(slash + 1));
    const usd = pricing && estimateCost(pricing, parsed.data);
    if (usd === undefined) {
      result.summary.skipped.missingRate++;
      continue;
    }
    const cacheUnknown =
      parsed.data.cacheReadTokens === undefined && parsed.data.cacheWriteTokens === undefined;
    const usage = usageSchema.parse({
      ...parsed.data,
      cost: {
        usd,
        source: "estimated",
        backfilled: true,
        ratesAsOf,
        ...(cacheUnknown && { cacheUnknown: true }),
      },
    });
    // Preserve every original field, including any unknown to this version of the app.
    const after = JSON.stringify({
      ...data,
      usage: { ...(data.usage as Record<string, unknown>), cost: usage.cost },
    });
    result.updates.push({ id: row.id, before: row.data, after });
    result.summary.eligible++;
    result.summary.estimatedUsd += usd;
    if (cacheUnknown) result.summary.cacheUnknown++;
  }
  return result;
}

export function applyCostBackfill(db: Database.Database, plan: BackfillPlan) {
  const update = db.prepare("update thread_event set data = ? where id = ? and data = ?");
  return db
    .transaction(() => {
      let updated = 0;
      for (const row of plan.updates) {
        updated += update.run(row.after, row.id, row.before).changes;
      }
      return { updated, conflicts: plan.updates.length - updated };
    })
    .immediate();
}

async function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string", default: process.env.DATABASE_PATH ?? "data/mage.db" },
      apply: { type: "boolean", default: false },
    },
  });
  const file = path.resolve(values.database);
  const db = new Database(file, { readonly: !values.apply, fileMustExist: true });
  try {
    const license = readFileSync(
      path.join(import.meta.dirname, "../src/server/models/data/LICENSE"),
      "utf8",
    );
    const ratesAsOf = /^Retrieved:\s+(\d{4}-\d{2}-\d{2})$/m.exec(license)?.[1];
    if (!ratesAsOf) throw new Error("The bundled rates have no retrieval date");
    const plan = planCostBackfill(db, ratesAsOf);
    if (!values.apply || plan.updates.length === 0) {
      console.log(JSON.stringify({ dryRun: !values.apply, ratesAsOf, ...plan.summary }, null, 2));
      return;
    }
    const backup = `${file}.before-cost-backfill-${new Date().toISOString().replaceAll(":", "-")}.db`;
    await db.backup(backup);
    chmodSync(backup, 0o600);
    const applied = applyCostBackfill(db, plan);
    console.log(
      JSON.stringify({ dryRun: false, backup, ratesAsOf, ...plan.summary, ...applied }, null, 2),
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();

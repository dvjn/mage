// The migrations that fill tables from data already written, each run on a database of its own as
// it stood before them.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";
import { describe, expect, it } from "vite-plus/test";

import { MIGRATIONS } from "@/server/db/db.ts";

// The statements of the migration files whose names start with these numbers, in order.
function statements(...numbers: string[]) {
  return readdirSync(MIGRATIONS)
    .filter((file) => numbers.some((number) => file.startsWith(`${number}_`)))
    .toSorted()
    .flatMap((file) =>
      readFileSync(path.join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint"),
    )
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// Runs the test on a database of its own, dropped once it is done.
async function scratch(test: (db: pg.Client) => Promise<void>) {
  const server = process.env.TEST_DATABASE_URL!;
  const name = `test_migrations_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  try {
    await test(db);
  } finally {
    await db.end();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("migrations on existing data", () => {
  // A thread with two branches, notices from before the second began, a job still running and a
  // call waiting.
  it("fill inputs and calls as the logs say, and name on a job's events the run that asked", async () => {
    await scratch(async (db) => {
      for (const statement of statements("0000", "0001", "0002")) await db.query(statement);
      // Rows as the data had them, without the rows they point to.
      await db.query("set session_replication_role = replica");
      const event = (seq: number, branch: string, type: string, data: object, user?: string) =>
        db.query(
          `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, actor_user_id, data)
           values ($1, 'T', $2, $3, $4, $5, $6, $7)`,
          [
            `e${seq}`,
            branch,
            seq,
            type,
            user ? "user" : "agent",
            user ?? null,
            JSON.stringify(data),
          ],
        );
      const notice = (text: string, wake: boolean) => ({
        kind: "agent.idle",
        source: { threadId: "elsewhere", name: "Watcher", main: false },
        text,
        people: [],
        ...(!wake && { wake: false }),
      });
      const text = (said: string) => [{ type: "text", text: said }];
      await db.query(
        `insert into thread (id, space_id, current_branch_id) values ('T', 's', 'B2')`,
      );
      await db.query(
        `insert into thread_branch (id, thread_id, parent_branch_id, fork_seq, kind)
         values ('B1', 'T', null, null, 'root'), ('B2', 'T', 'B1', 5, 'retry')`,
      );
      await db.query(
        `insert into run (id, thread_id, branch_id, status, trigger_seq)
         values ('R1', 'T', 'B1', 'cancelled', 1), ('R2', 'T', 'B2', 'waiting', 7)`,
      );
      await event(1, "B1", "message", { parts: text("Go"), quiet: false, mode: "steer" }, "ada");
      await event(2, "B1", "message.admitted", { runId: "R1", messageIds: ["e1"] });
      await event(3, "B1", "notification", notice("Quiet", false));
      await event(4, "B1", "notification", notice("Wakes", true));
      await event(5, "B1", "tool.requested", {
        runId: "J",
        callId: "J",
        messageId: "",
        toolId: "probe.wait",
        input: {},
        risk: "normal",
        waits: false,
        background: true,
      });
      await event(6, "B1", "message", { parts: text("Left"), quiet: false, mode: "queue" }, "ada");
      await event(7, "B2", "branch.started", { kind: "retry", rowId: "r" });
      await event(8, "B2", "run.created", { runId: "R2", reason: "rewrite", continuesRunId: null });
      await event(9, "B2", "tool.requested", {
        runId: "R2",
        callId: "C",
        messageId: "m",
        toolId: "probe.guarded",
        input: {},
        risk: "ask",
        waits: true,
      });
      await db.query(`update thread set last_event_seq = 9`);
      await db.query(
        `insert into background_call (id, thread_id, run_id, tool_id, status, lease_owner,
                                      lease_expires_at, lease_epoch)
         values ('J', 'T', 'R1', 'probe.wait', 'running', 'holder', now() + interval '1 minute', 1)`,
      );
      await db.query("set session_replication_role = default");

      for (const statement of statements("0003", "0004")) await db.query(statement);

      const inputs = await db.query(
        `select id, branch_id, status, wake, admitted_run_id from thread_input order by seq`,
      );
      expect(inputs.rows).toEqual([
        { id: "e1", branch_id: "B1", status: "admitted", wake: true, admitted_run_id: "R1" },
        { id: "e3", branch_id: "B2", status: "waiting", wake: false, admitted_run_id: null },
        { id: "e4", branch_id: "B2", status: "waiting", wake: true, admitted_run_id: null },
        { id: "e6", branch_id: "B1", status: "dropped", wake: true, admitted_run_id: null },
      ]);
      const calls = await db.query(
        `select id, run_id, status, waits_for, background, lease_owner, lease_epoch from call order by id`,
      );
      expect(calls.rows).toEqual([
        {
          id: "C",
          run_id: "R2",
          status: "waiting",
          waits_for: "decision",
          background: false,
          lease_owner: null,
          lease_epoch: 0,
        },
        {
          id: "J",
          run_id: "R1",
          status: "running",
          waits_for: null,
          background: true,
          lease_owner: "holder",
          lease_epoch: 1,
        },
      ]);
      // The job's request names the run that asked for it, its keys in the order they had.
      const job = await db.query(`select data::text as data from thread_event where id = 'e5'`);
      expect(job.rows[0].data).toMatch(/^\{"runId":"R1","callId":"J",/);
      const gone = await db.query(`select to_regclass('background_call') as found`);
      expect(gone.rows[0].found).toBeNull();
    });
  });

  it("point artifact versions at the call that published them, where it is there", async () => {
    await scratch(async (db) => {
      for (const statement of statements("0000", "0001", "0002", "0003", "0004", "0005")) {
        await db.query(statement);
      }
      await db.query("set session_replication_role = replica");
      await db.query(
        `insert into call (thread_id, id, branch_id, run_id, tool_id, risk, status, background)
         values ('T', 'C', 'B', 'R', 'artifacts.publish', 'normal', 'completed', false),
                ('T', 'J', 'B', 'R', 'artifacts.update', 'normal', 'completed', true)`,
      );
      await db.query(
        `insert into artifact_version (artifact_id, version, html, title, description, icon,
                                       thread_id, run_id, background_call_id, call_id)
         values ('A', 1, '', 't', 'd', 'i', 'T', 'R', null, 'C'),
                ('A', 2, '', 't', 'd', 'i', 'T', null, 'J', 'J'),
                ('A', 3, '', 't', 'd', 'i', 'T', 'R', null, 'gone'),
                ('A', 4, '', 't', 'd', 'i', null, null, null, 'C')`,
      );
      await db.query("set session_replication_role = default");

      for (const statement of statements("0006")) await db.query(statement);

      const versions = await db.query(
        `select version, thread_id, call_id from artifact_version order by version`,
      );
      expect(versions.rows).toEqual([
        { version: 1, thread_id: "T", call_id: "C" },
        { version: 2, thread_id: "T", call_id: "J" },
        { version: 3, thread_id: "T", call_id: null },
        { version: 4, thread_id: null, call_id: null },
      ]);
      const columns = await db.query(
        `select column_name from information_schema.columns
         where table_name = 'artifact_version' and column_name in ('run_id', 'background_call_id')`,
      );
      expect(columns.rows).toEqual([]);
      // A call deleted leaves its versions, which point at nothing.
      await db.query(`delete from call where id = 'C'`);
      const left = await db.query(
        `select version, thread_id, call_id from artifact_version where version = 1`,
      );
      expect(left.rows).toEqual([{ version: 1, thread_id: "T", call_id: null }]);
    });
  });

  it("name on each job the call it was moved from", async () => {
    await scratch(async (db) => {
      for (const statement of statements("0000", "0001", "0002", "0003", "0004", "0005", "0006")) {
        await db.query(statement);
      }
      await db.query("set session_replication_role = replica");
      await db.query(
        `insert into call (thread_id, id, branch_id, run_id, tool_id, risk, status, background)
         values ('T', 'C', 'B', 'R', 'probe.wait', 'normal', 'completed', false),
                ('T', 'J', 'B', 'R', 'probe.wait', 'normal', 'running', true),
                ('T', 'K', 'B', 'R', 'probe.wait', 'normal', 'running', true),
                ('U', 'J', 'B', 'R', 'probe.wait', 'normal', 'running', true)`,
      );
      await db.query(
        `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, data)
         values ('e1', 'T', 'B', 1, 'tool.ran', 'agent', $1),
                ('e2', 'T', 'B', 2, 'tool.ran', 'agent', $2)`,
        [
          JSON.stringify({
            runId: "R",
            callId: "C",
            ok: true,
            ms: 0,
            value: { movedToBackground: true, callId: "J" },
          }),
          JSON.stringify({ runId: "R", callId: "K", ok: true, ms: 0, value: "plain" }),
        ],
      );
      await db.query("set session_replication_role = default");

      for (const statement of statements("0007")) await db.query(statement);

      const calls = await db.query(
        `select thread_id, id, moved_from from call order by thread_id, id`,
      );
      expect(calls.rows).toEqual([
        { thread_id: "T", id: "C", moved_from: null },
        { thread_id: "T", id: "J", moved_from: "C" },
        { thread_id: "T", id: "K", moved_from: null },
        { thread_id: "U", id: "J", moved_from: null },
      ]);
    });
  });

  it("give a new branch rows for the notices it reads, calls their seq, and sources", async () => {
    await scratch(async (db) => {
      for (const statement of statements(
        "0000",
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
      )) {
        await db.query(statement);
      }
      await db.query("set session_replication_role = replica");
      const event = (id: string, branch: string, seq: number, type: string, data: object) =>
        db.query(
          `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, data)
           values ($1, 'T', $2, $3, $4, 'agent', $5)`,
          [id, branch, seq, type, JSON.stringify(data)],
        );
      const notice = (text: string) => ({
        kind: "agent.idle",
        source: { threadId: "S", name: "Helper", main: false },
        text,
        people: [],
      });
      await db.query(
        `insert into thread (id, space_id, current_branch_id) values ('T', 's', 'B2')`,
      );
      await db.query(
        `insert into thread_branch (id, thread_id, parent_branch_id, fork_seq, kind)
         values ('B1', 'T', null, null, 'root'), ('B2', 'T', 'B1', 3, 'restore')`,
      );
      await db.query(
        `insert into thread_branch_source (branch_id, source_branch_id, until_seq)
         values ('B1', 'B1', null), ('B2', 'B1', 3), ('B2', 'B2', null)`,
      );
      await event("e1", "B1", 1, "tool.requested", {
        runId: "R",
        callId: "C",
        messageId: "",
        toolId: "subagents.start",
        input: {},
        risk: "normal",
        waits: false,
      });
      await event("e2", "B1", 2, "tool.ran", {
        runId: "R",
        callId: "C",
        ok: true,
        ms: 0,
        value: { id: "S" },
      });
      await event("e3", "B1", 3, "notification", notice("Read on both"));
      await event("e4", "B1", 4, "message.admitted", { runId: "R1", messageIds: ["e3"] });
      await event("e5", "B1", 5, "notification", notice("Left behind"));
      await event("e6", "B2", 6, "branch.started", { kind: "restore", rowId: "r" });
      await event("e7", "B1", 7, "tool.ran", {
        runId: "R",
        callId: "H",
        ok: true,
        ms: 0,
        value: { id: "W", url: "u" },
      });
      await db.query(`update thread set last_event_seq = 7`);
      await db.query(
        `insert into call (thread_id, id, branch_id, run_id, tool_id, risk, status, background)
         values ('T', 'C', 'B1', 'R', 'subagents.start', 'normal', 'completed', false)`,
      );
      await db.query(
        `insert into subagent (thread_id, parent_thread_id, name) values ('S', 'T', 'Helper')`,
      );
      await db.query(
        `insert into thread_trigger (id, thread_id, kind, name, prompt, steered_by, created_by_label,
                                     status, hook_token)
         values ('W', 'T', 'webhook', 'Hook', 'p', '[]', 'Agent', 'active', 'tok')`,
      );
      await db.query(
        `insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake, origin_kind,
                                   origin_id, admitted_run_id)
         values ('e3', 'T', 'B1', 3, 'notice', 'admitted', true, 'subagent', 'S', 'R1'),
                ('e5', 'T', 'B1', 5, 'notice', 'waiting', true, 'subagent', 'S', null)`,
      );
      await db.query("set session_replication_role = default");

      for (const statement of statements("0008")) await db.query(statement);

      const inputs = await db.query(
        `select id, branch_id, status, source_call_id from thread_input order by id, branch_id`,
      );
      expect(inputs.rows).toEqual([
        { id: "e3", branch_id: "B1", status: "admitted", source_call_id: null },
        { id: "e3", branch_id: "B2", status: "waiting", source_call_id: "C" },
        { id: "e5", branch_id: "B1", status: "waiting", source_call_id: "C" },
      ]);
      expect((await db.query(`select id, seq from call`)).rows).toEqual([{ id: "C", seq: 1 }]);
      expect((await db.query(`select call_id from subagent`)).rows).toEqual([{ call_id: "C" }]);
      expect((await db.query(`select call_id from thread_trigger`)).rows).toEqual([
        { call_id: "H" },
      ]);
    });
  });

  it("split triggers into schedules and webhooks, every kind and status kept", async () => {
    await scratch(async (db) => {
      const upto = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"];
      for (const statement of statements(...upto)) await db.query(statement);
      await db.query("set session_replication_role = replica");
      const row = (
        id: string,
        kind: string,
        status: string,
        next: string | null,
        extra: { cron?: string; timezone?: string | null; token?: string; fired?: string } = {},
      ) =>
        db.query(
          `insert into thread_trigger (id, thread_id, kind, name, cron, timezone, prompt, steered_by,
                                       created_by_label, status, next_run_at, last_fired_at,
                                       hook_token, call_id, secret, secret_key_version)
           values ($1, 'T', $2, $3, $4, $5, 'p', '[{"userId":"u","name":"Ada","via":[]}]', 'Agent',
                   $6, $7, $8, $9, $10, $11, $12)`,
          [
            id,
            kind,
            `Name ${id}`,
            extra.cron ?? null,
            extra.timezone === undefined ? null : extra.timezone,
            status,
            next,
            extra.fired ?? null,
            extra.token ?? null,
            `call-${id}`,
            kind === "webhook" ? Buffer.from("sealed") : null,
            kind === "webhook" ? 1 : null,
          ],
        );
      await db.query(`insert into thread (id, space_id, current_branch_id) values ('T', 's', 'B')`);
      const at = "2030-01-01T09:00:00Z";
      await row("o1", "once", "active", at);
      await row("o2", "once", "done", null, { fired: at });
      await row("o3", "once", "paused", at);
      await row("c1", "cron", "active", at, { cron: "0 9 * * *", timezone: "UTC" });
      await row("c2", "cron", "paused", at, { cron: "0 9 * * *", timezone: null });
      await row("c3", "cron", "deleted", null, { cron: "0 9 * * *", timezone: "UTC" });
      await row("w1", "webhook", "active", null, { token: "t1", fired: at });
      await row("w2", "webhook", "deleted", null, { token: "t2" });
      await db.query("set session_replication_role = default");

      for (const statement of statements("0009")) await db.query(statement);

      const schedules = await db.query(
        `select id, kind, status, cron, timezone, next_run_at is not null as next, call_id,
                influence::text as influence
           from schedule order by id`,
      );
      expect(schedules.rows).toEqual([
        {
          id: "c1",
          kind: "cron",
          status: "active",
          cron: "0 9 * * *",
          timezone: "UTC",
          next: true,
          call_id: "call-c1",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
        {
          id: "c2",
          kind: "cron",
          status: "paused",
          cron: "0 9 * * *",
          timezone: "UTC",
          next: true,
          call_id: "call-c2",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
        {
          id: "c3",
          kind: "cron",
          status: "deleted",
          cron: "0 9 * * *",
          timezone: "UTC",
          next: false,
          call_id: "call-c3",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
        {
          id: "o1",
          kind: "once",
          status: "active",
          cron: null,
          timezone: null,
          next: true,
          call_id: "call-o1",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
        {
          id: "o2",
          kind: "once",
          status: "completed",
          cron: null,
          timezone: null,
          next: false,
          call_id: "call-o2",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
        {
          id: "o3",
          kind: "once",
          status: "paused",
          cron: null,
          timezone: null,
          next: true,
          call_id: "call-o3",
          influence: '[{"userId":"u","name":"Ada","via":[]}]',
        },
      ]);
      const webhooks = await db.query(
        `select id, status, token, secret is not null as secret, last_received_at is not null as received
           from webhook order by id`,
      );
      expect(webhooks.rows).toEqual([
        { id: "w1", status: "active", token: "t1", secret: true, received: true },
        { id: "w2", status: "deleted", token: "t2", secret: true, received: false },
      ]);
      const gone = await db.query(`select to_regclass('thread_trigger') as found`);
      expect(gone.rows[0].found).toBeNull();
    });
  });

  it("judge each call under the model its run replied with", async () => {
    await scratch(async (db) => {
      const upto = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"];
      for (const statement of statements(...upto, "0009", "0010")) await db.query(statement);
      await db.query("set session_replication_role = replica");
      await db.query(
        `insert into run (id, thread_id, branch_id, status, trigger_seq, model)
         values ('R1', 'T', 'B', 'completed', 1, 'codex/gpt-big'), ('R2', 'T', 'B', 'completed', 2, null)`,
      );
      await db.query(
        `insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, background)
         values ('T', 'C1', 'B', 1, 'R1', 'probe.wait', 'normal', 'completed', false),
                ('T', 'C2', 'B', 2, 'R2', 'probe.wait', 'normal', 'completed', false),
                ('T', 'C3', 'B', 3, 'gone', 'probe.wait', 'normal', 'completed', true)`,
      );
      await db.query("set session_replication_role = default");
      for (const statement of statements("0011")) await db.query(statement);
      expect((await db.query(`select id, model from call order by id`)).rows).toEqual([
        { id: "C1", model: "codex/gpt-big" },
        { id: "C2", model: null },
        { id: "C3", model: null },
      ]);
    });
  });

  // Two branches, a notice steered by two people through an agent, an aside, an answer, a refusal,
  // and a notice that does not wake the agent.
  it("record whose words each thread's agent read, and where each call was decided", async () => {
    await scratch(async (db) => {
      const upto = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"];
      for (const statement of statements(...upto, "0009", "0010", "0011"))
        await db.query(statement);
      await db.query("set session_replication_role = replica");
      const event = (
        id: string,
        branch: string,
        seq: number,
        type: string,
        data: object,
        user: string | null = null,
      ) =>
        db.query(
          `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, actor_user_id, data)
           values ($1, 'T', $2, $3, $4, $5, $6, $7)`,
          [id, branch, seq, type, user ? "user" : "agent", user, JSON.stringify(data)],
        );
      const helper = { threadId: "S", name: "Helper", main: false };
      await db.query(
        `insert into thread (id, space_id, current_branch_id) values ('T', 's', 'B2')`,
      );
      await db.query(
        `insert into thread_branch (id, thread_id, parent_branch_id, fork_seq, kind, row_id)
         values ('B1', 'T', null, null, 'root', null), ('B2', 'T', 'B1', 6, 'restore', 'm1')`,
      );
      await db.query(
        `insert into thread_branch_source (branch_id, source_branch_id, until_seq)
         values ('B1', 'B1', null), ('B2', 'B1', 6), ('B2', 'B2', null)`,
      );
      await event("m1", "B1", 1, "message", { parts: [], quiet: false, mode: "steer" }, "U1");
      await event("n1", "B1", 2, "notification", {
        kind: "agent.idle",
        source: helper,
        text: "Done",
        people: [
          { userId: "U2", name: "Bo", via: ["Helper"] },
          { userId: "U3", name: "Cy", via: ["Helper"] },
        ],
      });
      await event("a1", "B1", 3, "message.admitted", { runId: "R", messageIds: ["m1", "n1"] });
      await event("q1", "B1", 4, "message", { parts: [], quiet: true, mode: "steer" }, "U2");
      await event("c1", "B1", 5, "tool.requested", {
        runId: "R",
        callId: "C",
        messageId: "",
        toolId: "thread.ask",
        input: {},
        risk: "normal",
        waits: true,
      });
      await event(
        "d1",
        "B1",
        6,
        "tool.answered",
        { runId: "R", callId: "C", answers: { x: "y" } },
        "U3",
      );
      await event("m2", "B2", 7, "message", { parts: [], quiet: false, mode: "steer" }, "U1");
      await event("a2", "B2", 8, "message.admitted", { runId: "R2", messageIds: ["m2"] });
      await event("c2", "B2", 9, "tool.requested", {
        runId: "R2",
        callId: "D",
        messageId: "",
        toolId: "probe.guarded",
        input: {},
        risk: "ask",
        waits: true,
      });
      await event(
        "d2",
        "B2",
        10,
        "tool.denied",
        { runId: "R2", callId: "D", reason: "denied" },
        "U1",
      );
      await event("n2", "B2", 11, "notification", {
        kind: "schedule.changed",
        source: { threadId: "T", name: "Wake", main: true },
        text: "Paused",
        wake: false,
        people: [{ userId: "U1", name: "Ada", via: [] }],
      });
      await db.query(
        `insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, background,
                           decided_by, scope)
         values ('T', 'C', 'B1', 5, 'R', 'thread.ask', 'normal', 'completed', false, 'U3', 'once'),
                ('T', 'D', 'B2', 9, 'R2', 'probe.guarded', 'ask', 'denied', false, 'U1', null)`,
      );
      await db.query("set session_replication_role = default");
      for (const statement of statements("0012")) await db.query(statement);
      expect(
        (
          await db.query(
            `select branch_id, seq, ord, user_id, name, via from thread_word order by seq, ord`,
          )
        ).rows,
      ).toEqual([
        { branch_id: "B1", seq: 3, ord: 1000, user_id: "U1", name: null, via: [] },
        { branch_id: "B1", seq: 3, ord: 2001, user_id: "U2", name: "Bo", via: ["Helper"] },
        { branch_id: "B1", seq: 3, ord: 2002, user_id: "U3", name: "Cy", via: ["Helper"] },
        { branch_id: "B1", seq: 4, ord: 0, user_id: "U2", name: null, via: [] },
        { branch_id: "B1", seq: 6, ord: 0, user_id: "U3", name: null, via: [] },
        { branch_id: "B2", seq: 8, ord: 1000, user_id: "U1", name: null, via: [] },
        { branch_id: "B2", seq: 11, ord: 1, user_id: "U1", name: "Ada", via: [] },
      ]);
      // B2 was restored from Ada's message, taken in first at seq 3.
      expect(
        (await db.query(`select id, read_seq, read_ord from thread_branch order by id`)).rows,
      ).toEqual([
        { id: "B1", read_seq: null, read_ord: null },
        { id: "B2", read_seq: 3, read_ord: 1000 },
      ]);
      expect((await db.query(`select id, decided_seq from call order by id`)).rows).toEqual([
        { id: "C", decided_seq: 6 },
        { id: "D", decided_seq: 10 },
      ]);
    });
  });

  it("keep every subagent that shares its starter's list sharing it", async () => {
    await scratch(async (db) => {
      const upto = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"];
      for (const statement of statements(...upto, "0009", "0010", "0011", "0012")) {
        await db.query(statement);
      }
      await db.query("set session_replication_role = replica");
      await db.query(
        `insert into thread (id, space_id, current_branch_id)
         values ('P', 's', 'B'), ('S1', 's', 'B1'), ('S2', 's', 'B2')`,
      );
      await db.query(
        `insert into subagent (thread_id, parent_thread_id, name, share_tasks)
         values ('S1', 'P', 'One', true), ('S2', 'P', 'Two', false)`,
      );
      await db.query("set session_replication_role = default");
      for (const statement of statements("0013")) await db.query(statement);
      expect((await db.query(`select thread_id, owner_thread_id from task_share`)).rows).toEqual([
        { thread_id: "S1", owner_thread_id: "P" },
      ]);
      expect(
        (
          await db.query(
            `select 1 from information_schema.columns where column_name = 'share_tasks'`,
          )
        ).rows,
      ).toEqual([]);
    });
  });
  it("rename what is stored to the words read now, a permission to list or delete kept for both kinds", async () => {
    await scratch(async (db) => {
      const upto = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"];
      for (const statement of statements(...upto, "0009", "0010", "0011", "0012", "0013"))
        await db.query(statement);
      for (const statement of statements("0014", "0015")) await db.query(statement);
      await db.query("set session_replication_role = replica");
      const event = (id: string, seq: number, type: string, data: object) =>
        db.query(
          `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, actor_user_id, data)
           values ($1, 'T', 'B', $2, $3, 'agent', null, $4)`,
          [id, seq, type, JSON.stringify(data)],
        );
      const source = { threadId: "T", name: "Digest", main: true };
      const ada = { userId: "U1", name: "Ada", via: [] };
      const requested = (callId: string, toolId: string, input: object, toolset?: string) => ({
        runId: "R",
        callId,
        messageId: "",
        toolId,
        input,
        risk: "normal",
        waits: false,
        ...(toolset && { toolset }),
      });
      await db.query(
        `insert into webhook (id, thread_id, name, prompt, influence, status, token)
         values ('W1', 'T', 'Deploys', 'Look', '[]', 'active', 'tok')`,
      );
      await event("n1", 1, "notification", {
        kind: "trigger.fired",
        source,
        text: "Go",
        people: [ada],
        trigger: "S1",
      });
      await event("n2", 2, "notification", {
        kind: "webhook.received",
        source,
        text: "Posted",
        people: [],
        trigger: "W1",
      });
      await event("n3", 3, "notification", {
        kind: "change",
        source,
        text: "Paused",
        people: [],
        tray: "triggers",
      });
      await event("d1", 4, "tool.denied", { runId: "R", callId: "c0", reason: "stopped" });
      await event(
        "c1",
        5,
        "tool.requested",
        requested("c1", "triggers.delete", { id: "W1" }, "Triggers"),
      );
      await event(
        "c2",
        6,
        "tool.requested",
        requested("c2", "triggers.delete", { id: "S1" }, "Triggers"),
      );
      await event(
        "c3",
        7,
        "tool.requested",
        requested("c3", "calls.start", { tool: "triggers.add_webhook", input: {} }),
      );
      await event("c4", 8, "tool.requested", requested("c4", "calls.status", { id: "c3" }));
      for (const [id, seq, tool] of [
        ["c1", 5, "triggers.delete"],
        ["c2", 6, "triggers.delete"],
        ["c3", 7, "calls.start"],
        ["j3", 7, "triggers.add_webhook"],
      ] as const) {
        await db.query(
          `insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, background)
           values ('T', $1, 'B', $2, 'R', $3, 'normal', 'completed', $4)`,
          [id, seq, tool, id === "j3"],
        );
      }
      await db.query(
        `insert into tool_setting (organization_id, space_id, tool_id, policy_id)
         values ('O', null, 'triggers.list', 'P'), ('O', 'S', 'triggers.delete', null), ('O', null, 'calls.start', 'P')`,
      );
      await db.query(
        `insert into toolset_setting (organization_id, space_id, toolset_id, enabled)
         values ('O', 'S', 'triggers', false), ('O', null, 'calls', true)`,
      );
      await db.query(
        `insert into toolset_option (organization_id, space_id, toolset_id, option, enabled)
         values ('O', null, 'triggers', 'x', true)`,
      );
      await db.query(
        `insert into thread_tool (thread_id, tool_id, call_id, position) values ('T', 'triggers.list', 'c9', 0)`,
      );
      await db.query(
        `insert into thread_background_seen (user_id, thread_id, kind, seen_at) values ('U1', 'T', 'triggers', now())`,
      );
      await db.query(
        `insert into run (id, thread_id, branch_id, status, trigger_seq) values ('R', 'T', 'B', 'completed', 1)`,
      );
      // The rows above stand for real ones, so what the migration copies is not checked against
      // what they point at either.
      for (const statement of statements("0016")) await db.query(statement);
      await db.query("set session_replication_role = default");

      const data = async (id: string) =>
        (await db.query(`select type, data from thread_event where id = $1`, [id])).rows[0];
      expect(await data("n1")).toEqual({
        type: "notice",
        data: { kind: "schedule.fired", source, text: "Go", influence: [ada], scheduleId: "S1" },
      });
      expect((await data("n2")).data).toMatchObject({ kind: "webhook.received", webhookId: "W1" });
      expect((await data("n2")).data).not.toHaveProperty("trigger");
      expect((await data("n3")).data).toMatchObject({ tray: "schedules", influence: [] });
      expect((await data("d1")).data).toMatchObject({ reason: "cancelled" });
      expect((await data("c1")).data).toMatchObject({
        toolId: "webhooks.delete",
        toolset: "Webhooks",
      });
      expect((await data("c2")).data).toMatchObject({
        toolId: "schedules.delete",
        toolset: "Schedules",
      });
      expect((await data("c3")).data).toMatchObject({
        toolId: "jobs.start",
        input: { tool: "webhooks.add" },
      });
      expect((await data("c4")).data).toMatchObject({ toolId: "jobs.check" });
      expect(
        (await db.query(`select id, tool_id from call order by id`)).rows.map((row) => [
          row.id,
          row.tool_id,
        ]),
      ).toEqual([
        ["c1", "webhooks.delete"],
        ["c2", "schedules.delete"],
        ["c3", "jobs.start"],
        ["j3", "webhooks.add"],
      ]);
      expect(
        (await db.query(`select space_id, tool_id, policy_id from tool_setting order by tool_id`))
          .rows,
      ).toEqual([
        { space_id: null, tool_id: "jobs.start", policy_id: "P" },
        { space_id: "S", tool_id: "schedules.delete", policy_id: null },
        { space_id: null, tool_id: "schedules.list", policy_id: "P" },
        { space_id: "S", tool_id: "webhooks.delete", policy_id: null },
        { space_id: null, tool_id: "webhooks.list", policy_id: "P" },
      ]);
      expect(
        (await db.query(`select toolset_id, enabled from toolset_setting order by toolset_id`))
          .rows,
      ).toEqual([
        { toolset_id: "jobs", enabled: true },
        { toolset_id: "schedules", enabled: false },
        { toolset_id: "webhooks", enabled: false },
      ]);
      expect(
        (await db.query(`select toolset_id from toolset_option order by toolset_id`)).rows,
      ).toEqual([{ toolset_id: "schedules" }, { toolset_id: "webhooks" }]);
      expect((await db.query(`select tool_id from thread_tool order by tool_id`)).rows).toEqual([
        { tool_id: "schedules.list" },
        { tool_id: "webhooks.list" },
      ]);
      expect((await db.query(`select kind from thread_activity_seen`)).rows).toEqual([
        { kind: "schedules" },
      ]);
      expect((await db.query(`select woken_by_seq from run`)).rows).toEqual([{ woken_by_seq: 1 }]);
    });
  });

  it("name on each call a script made the script, as its request in the log does", async () => {
    await scratch(async (db) => {
      const before = Array.from({ length: 19 }, (_, n) => String(n).padStart(4, "0"));
      for (const statement of statements(...before)) await db.query(statement);
      await db.query("set session_replication_role = replica");
      await db.query(
        `insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, background)
         values ('T', 'S', 'B', 1, 'R', 'scripts.run', 'normal', 'completed', false),
                ('T', 'C', 'B', 2, 'R', 'probe.wait', 'normal', 'completed', false)`,
      );
      await db.query(
        `insert into thread_event (id, thread_id, branch_id, seq, type, actor_kind, data)
         values ('e1', 'T', 'B', 1, 'tool.requested', 'agent', $1),
                ('e2', 'T', 'B', 2, 'tool.requested', 'agent', $2)`,
        [
          JSON.stringify({ runId: "R", callId: "S", messageId: "m", toolId: "scripts.run" }),
          JSON.stringify({
            runId: "R",
            callId: "C",
            messageId: "",
            toolId: "probe.wait",
            within: "S",
          }),
        ],
      );
      await db.query("set session_replication_role = default");

      for (const statement of statements("0019")) await db.query(statement);

      const calls = await db.query(`select id, parent_id from call order by seq`);
      expect(calls.rows).toEqual([
        { id: "S", parent_id: null },
        { id: "C", parent_id: "S" },
      ]);
    });
  });
});

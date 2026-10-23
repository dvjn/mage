import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { openDatabase } from "@/adapters/db.ts";

describe("openDatabase", () => {
  it("applies migrations", () => {
    const db = openDatabase(":memory:");
    const table = db.get(
      sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
    );
    expect(table).toEqual({ name: "__drizzle_migrations" });
  });
});

describe("removing the Claude sign-in", () => {
  it("deletes its connections, with their credentials and models, and its sign-ins", () => {
    const db = openDatabase(":memory:");
    for (const statement of [
      "insert into organization (id, name, slug, created_at, kind) values ('o1', 'Ada', 'ada', 0, 'personal')",
      "insert into user (id, name, email) values ('u1', 'Ada', 'ada@example.com')",
      "insert into connection (id, organization_id, provider, auth_kind, account) values ('codex', 'o1', 'openai', 'codex', 'a'), ('claude', 'o1', 'anthropic', 'claude', 'a'), ('key', 'o1', 'anthropic', 'api_key', 'k')",
      "insert into credential (connection_id, key_version, sealed) values ('codex', 1, x'00'), ('claude', 1, x'00'), ('key', 1, x'00')",
      "insert into connection_model (connection_id, model_id, enabled, first_seen_at) values ('claude', 'm', 1, 0), ('key', 'm', 1, 0)",
      "insert into sign_in_attempt (state, kind, code_verifier, organization_id, user_id, expires_at) values ('s1', 'codex', 'v', 'o1', 'u1', 0), ('s2', 'claude', 'v', 'o1', 'u1', 0)",
    ]) {
      db.run(sql.raw(statement));
    }

    const migration = readFileSync(
      path.join(import.meta.dirname, "../src/adapters/migrations/0020_remove_claude_sign_in.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      db.run(sql.raw(statement));
    }

    const ids = (table: string, column: string) =>
      db.all<{ id: string }>(sql.raw(`select ${column} as id from ${table} order by 1`));
    expect(ids("connection", "id")).toEqual([{ id: "codex" }, { id: "key" }]);
    expect(ids("credential", "connection_id")).toEqual([{ id: "codex" }, { id: "key" }]);
    expect(ids("connection_model", "connection_id")).toEqual([{ id: "key" }]);
    expect(ids("sign_in_attempt", "state")).toEqual([{ id: "s1" }]);
  });
});

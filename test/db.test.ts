import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vite-plus/test";

import { openDatabase } from "@/adapters/db.ts";

const MIGRATIONS = path.join(import.meta.dirname, "../src/adapters/migrations");

// A database migrated up to, not including, the migration with this tag, and that migration's
// statements to run on it.
function before(tag: string) {
  const folder = mkdtempSync(path.join(tmpdir(), "mage-migrations-"));
  try {
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = path.join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    journal.entries = journal.entries.slice(0, index);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = drizzle({ client: new Database(":memory:") });
    migrate(db, { migrationsFolder: folder });
    const statements = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8").split(
      "--> statement-breakpoint",
    );
    return { db, statements };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

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
    const { db, statements } = before("0020_remove_claude_sign_in");
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

    for (const statement of statements) db.run(sql.raw(statement));

    const ids = (table: string, column: string) =>
      db.all<{ id: string }>(sql.raw(`select ${column} as id from ${table} order by 1`));
    expect(ids("connection", "id")).toEqual([{ id: "codex" }, { id: "key" }]);
    expect(ids("credential", "connection_id")).toEqual([{ id: "codex" }, { id: "key" }]);
    expect(ids("connection_model", "connection_id")).toEqual([{ id: "key" }]);
    expect(ids("sign_in_attempt", "state")).toEqual([{ id: "s1" }]);
  });
});

describe("splitting hosts from providers", () => {
  it("names each connection's host, the sign-in by its own, and keeps their credentials", () => {
    const { db, statements } = before("0026_providers");
    for (const statement of [
      "insert into organization (id, name, slug, created_at, kind) values ('o1', 'Ada', 'ada', 0, 'personal')",
      "insert into connection (id, organization_id, provider, auth_kind, account, label) values ('codex', 'o1', 'openai', 'codex', 'a', null), ('ant', 'o1', 'anthropic', 'api_key', 'k', 'Work'), ('oai', 'o1', 'openai', 'api_key', 'k', null)",
      "insert into credential (connection_id, key_version, sealed) values ('codex', 1, x'00'), ('ant', 1, x'00'), ('oai', 1, x'00')",
      "insert into connection_model (connection_id, model_id, enabled, first_seen_at) values ('ant', 'm', 0, 0)",
    ]) {
      db.run(sql.raw(statement));
    }

    for (const statement of statements) db.run(sql.raw(statement));

    expect(
      db.all(sql.raw("select id, host, auth_kind, label, settings from connection order by id")),
    ).toEqual([
      { id: "ant", host: "anthropic", auth_kind: "api_key", label: "Work", settings: null },
      { id: "codex", host: "codex", auth_kind: "oauth", label: null, settings: null },
      { id: "oai", host: "openai", auth_kind: "api_key", label: null, settings: null },
    ]);
    expect(db.all(sql.raw("select connection_id from credential order by 1"))).toHaveLength(3);
    expect(db.all(sql.raw("select enabled from connection_model"))).toEqual([{ enabled: 0 }]);
    // Still one sign-in of a host per org.
    expect(() =>
      db.run(
        sql.raw(
          "insert into connection (id, organization_id, host, auth_kind, account) values ('codex2', 'o1', 'codex', 'oauth', 'b')",
        ),
      ),
    ).toThrow();
  });
});

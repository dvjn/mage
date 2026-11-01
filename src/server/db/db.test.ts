import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vite-plus/test";

import { openDatabase } from "./db.ts";

const MIGRATIONS = path.join(import.meta.dirname, "migrations");

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

describe("tool policies in place of tool modes", () => {
  it("seeds the org policies the modes need, and sets each tool to its policy or off", () => {
    const { db, statements } = before("0031_tool_policies");
    for (const statement of [
      "insert into organization (id, name, slug, created_at, kind) values ('o1', 'Ada', 'ada', 0, 'personal'), ('o2', 'Bo', 'bo', 0, 'personal'), ('o3', 'Cy', 'cy', 0, 'personal')",
      "insert into space (id, organization_id, kind, name) values ('s1', 'o1', 'personal', 'Ada'), ('s2', 'o2', 'personal', 'Bo')",
      "insert into org_tool_setting (organization_id, tool_id, mode) values ('o1', 'a', 'allow'), ('o1', 'b', 'ask'), ('o1', 'c', 'review'), ('o1', 'd', 'block'), ('o3', 'a', 'allow')",
      "insert into space_tool_setting (space_id, tool_id, mode) values ('s1', 'a', 'block'), ('s1', 'e', 'allow'), ('s2', 'a', 'review')",
    ]) {
      db.run(sql.raw(statement));
    }

    for (const statement of statements) db.run(sql.raw(statement));

    expect(
      db.all(
        sql.raw(
          "select id, organization_id, space_id, name, use, users, approvers, independent from tool_policy order by id",
        ),
      ),
    ).toEqual([
      {
        id: "o1-independent-review",
        organization_id: "o1",
        space_id: null,
        name: "Independent review",
        use: "none",
        users: "[]",
        approvers: '["editors"]',
        independent: 1,
      },
      {
        id: "o1-sign-off",
        organization_id: "o1",
        space_id: null,
        name: "Sign-off",
        use: "none",
        users: "[]",
        approvers: '["editors"]',
        independent: 0,
      },
      {
        id: "o2-independent-review",
        organization_id: "o2",
        space_id: null,
        name: "Independent review",
        use: "none",
        users: "[]",
        approvers: '["editors"]',
        independent: 1,
      },
    ]);
    expect(
      db.all(
        sql.raw("select organization_id, tool_id, policy_id from org_tool_setting order by 1, 2"),
      ),
    ).toEqual([
      { organization_id: "o1", tool_id: "b", policy_id: "o1-sign-off" },
      { organization_id: "o1", tool_id: "c", policy_id: "o1-independent-review" },
      { organization_id: "o1", tool_id: "d", policy_id: null },
    ]);
    expect(
      db.all(sql.raw("select space_id, tool_id, policy_id from space_tool_setting order by 1, 2")),
    ).toEqual([
      { space_id: "s1", tool_id: "a", policy_id: null },
      { space_id: "s2", tool_id: "a", policy_id: "o2-independent-review" },
    ]);
  });
});

describe("personal spaces opt-in", () => {
  it("keeps each team org's setting, storing the old default for those without one", () => {
    const { db, statements } = before("0035_personal_spaces");
    for (const statement of [
      "insert into organization (id, name, slug, created_at, kind) values ('o1', 'Ada', 'ada', 0, 'personal'), ('t1', 'Looms', 'looms', 0, 'team'), ('t2', 'Engines', 'engines', 0, 'team'), ('t3', 'Codes', 'codes', 0, 'team')",
      "insert into org_setting (organization_id, member_spaces, default_model) values ('t2', 0, 'codex/gpt'), ('t3', 1, null)",
    ]) {
      db.run(sql.raw(statement));
    }

    for (const statement of statements) db.run(sql.raw(statement));

    expect(
      db.all(
        sql.raw("select organization_id, member_spaces, default_model from org_setting order by 1"),
      ),
    ).toEqual([
      { organization_id: "t1", member_spaces: 1, default_model: null },
      { organization_id: "t2", member_spaces: 0, default_model: "codex/gpt" },
      { organization_id: "t3", member_spaces: 1, default_model: null },
    ]);
    // An org that stores a setting from here on starts with them off.
    db.run(sql.raw("insert into org_setting (organization_id) values ('o1')"));
    expect(
      db.get(sql.raw("select member_spaces from org_setting where organization_id = 'o1'")),
    ).toEqual({ member_spaces: 0 });
  });
});

describe("clearing out members' spaces made for them", () => {
  it("deletes team orgs' personal spaces without threads, and keeps the rest", () => {
    const { db, statements } = before("0036_space_retention");
    for (const statement of [
      "insert into organization (id, name, slug, created_at, kind) values ('o1', 'Ada', 'ada', 0, 'personal'), ('t1', 'Looms', 'looms', 0, 'team')",
      "insert into space (id, organization_id, kind, name, is_primary) values ('own', 'o1', 'personal', 'Your space', 1), ('empty', 't1', 'personal', 'Your space', 1), ('used', 't1', 'personal', 'Your space', 1), ('general', 't1', 'shared', 'General', 0)",
      "insert into space_member (space_id, subject_kind, subject_id, role, source) values ('empty', 'user', 'u1', 'owner', 'direct'), ('used', 'user', 'u2', 'owner', 'direct')",
      "insert into thread (id, space_id) values ('th', 'used')",
    ]) {
      db.run(sql.raw(statement));
    }

    for (const statement of statements) db.run(sql.raw(statement));

    expect(db.all(sql.raw("select id from space order by 1"))).toEqual([
      { id: "general" },
      { id: "own" },
      { id: "used" },
    ]);
    expect(db.all(sql.raw("select space_id from space_member"))).toEqual([{ space_id: "used" }]);
    expect(
      db.get(sql.raw("select archived_at, trashed_at, trashed_by from space where id = 'used'")),
    ).toEqual({ archived_at: null, trashed_at: null, trashed_by: null });
  });
});

// Runs once before the tests: migrates an empty database and keeps it where each test's own
// database starts from. On a real server, when the tests run on one, that is a template database.
// With REQUIRE_PG set, a run without a real server fails rather than skipping the tests that need
// one.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import type { TestProject } from "vite-plus/test/node";

import { MIGRATIONS } from "@/server/db/db.ts";

export default async function setup(project: TestProject) {
  const server = process.env.TEST_DATABASE_URL;
  // The tests that need a real server skip without one; a run that must include them fails.
  if (process.env.REQUIRE_PG === "1" && !server) {
    throw new Error("REQUIRE_PG is set but TEST_DATABASE_URL names no server.");
  }
  if (server) return template(project, server);
  const client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS });
  const snapshot = await client.dumpDataDir("none");
  await client.close();
  const dir = mkdtempSync(path.join(tmpdir(), "mage-test-"));
  const file = path.join(dir, "snapshot.tar");
  writeFileSync(file, Buffer.from(await snapshot.arrayBuffer()));
  project.provide("databaseSnapshot", file);
  return () => rmSync(dir, { recursive: true, force: true });
}

async function template(project: TestProject, server: string) {
  const name = `test_template_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: server });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  await admin(`create database "${name}"`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href });
  try {
    await migratePostgres(drizzlePostgres({ client: pool }), { migrationsFolder: MIGRATIONS });
  } finally {
    await pool.end();
  }
  project.provide("databaseTemplate", name);
  return () => admin(`drop database if exists "${name}" with (force)`);
}

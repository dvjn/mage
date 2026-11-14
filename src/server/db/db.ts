// Opens the Postgres database and applies pending migrations.

import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { listenAt } from "./listen.ts";

export type Db = NodePgDatabase;

export const MIGRATIONS = path.join(import.meta.dirname, "migrations");

// Connects to the database at the URL and brings it up to date. Answers the database itself,
// outside any transaction, a way to hear its notifications, and a way to close its connections.
export async function openDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  const db: Db = drizzle({ client: pool });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, listen: listenAt(url), close: () => pool.end() };
}

export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

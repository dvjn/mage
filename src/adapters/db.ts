// Opens the SQLite file in WAL mode and applies pending migrations.

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export type Db = BetterSQLite3Database;

export function openDatabase(file: string): Db {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: path.join(import.meta.dirname, "migrations") });
  return db;
}

export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    db.get(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

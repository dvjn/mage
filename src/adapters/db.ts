// Opens the SQLite file in WAL mode and applies pending migrations, and runs store work in one
// transaction that holds the write lock from its start.

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Transact } from "@/ports/transaction.ts";

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

// Taking the write lock as a transaction begins makes another connection's write wait out the
// busy timeout; a transaction that read first and then wrote would fail at once instead.
export const writeLock = { behavior: "immediate" } as const;

// Every store shares the database's one connection, so their writes inside the work join its
// transaction; a transaction already open nests as a savepoint.
export function createTransact(db: Db): Transact {
  return (work) => db.transaction(() => work(), writeLock);
}

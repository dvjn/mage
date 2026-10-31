// Opens the SQLite file in WAL mode and applies pending migrations, and runs store work in one
// transaction that holds the write lock from its start. The auth library's transactions await
// between their statements, so they get their own kind: one at a time, on the same connection.

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export type Transact = <T>(work: () => T) => T;

export type Db = BetterSQLite3Database & { $client: Database.Database };

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

// The database with a `transaction` that takes async work: the work runs between BEGIN IMMEDIATE
// and COMMIT on the one connection, or is rolled back when it throws, and such transactions wait
// for each other. Store transactions begun meanwhile nest in it as savepoints, so writes made
// while it awaits are part of it.
export function withAsyncTransactions(db: Db): Db {
  const client = db.$client;
  let last: Promise<unknown> = Promise.resolve();
  async function transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const turn = last.then(async () => {
      client.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(db);
        client.exec("COMMIT");
        return result;
      } catch (error) {
        if (client.inTransaction) client.exec("ROLLBACK");
        throw error;
      }
    });
    last = turn.catch(() => {});
    return turn;
  }
  return new Proxy(db, {
    get: (target, key, receiver) =>
      key === "transaction" ? transaction : Reflect.get(target, key, receiver),
  });
}

// Databases for the tests: each a Postgres of its own inside the test's process, started from a
// copy, made once for the whole run, of an empty database with every migration applied. With
// TEST_DATABASE_URL set, each is instead a database of its own on that server, made from a
// migrated template, so the tests also run where statements go over several connections at once.

import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { afterEach, inject } from "vite-plus/test";

import type { Db } from "@/server/db/db.ts";
import { listenAt } from "@/server/db/listen.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import { createSync, type Listen } from "@/server/sync/sync.ts";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    // Where the migrated empty database is kept for the run.
    databaseSnapshot: string;
    // The migrated database on the real server that each test's database is copied from.
    databaseTemplate: string;
  }
}

let snapshot: Blob | undefined;
const closing = new Set<() => Promise<void>>();

export interface TestDatabase {
  // The database itself, outside any transaction.
  db: Db;
  listen: Listen;
}

// A fresh database, and a way to hear its notifications. It starts as it is first used, so making
// one waits for nothing.
export function openTestDatabase(): TestDatabase {
  if (!inject("databaseSnapshot") && !inject("databaseTemplate")) {
    throw new Error("Only integration tests, named *.integration.test.ts, open a database.");
  }
  const server = process.env.TEST_DATABASE_URL;
  if (server) return onServer(server);
  snapshot ??= new Blob([readFileSync(inject("databaseSnapshot"))]);
  const client = new PGlite({ loadDataDir: snapshot });
  closing.add(() => client.close());
  // One connection, which every listener shares, and never loses.
  const listen: Listen = async (channel, onMessage) => {
    const stop = await client.listen(channel, onMessage);
    // Closing the database stops listening too.
    return async () => stop().catch(() => {});
  };
  return { db: drizzle({ client }) as unknown as Db, listen };
}

// Makes every lease on the table run out, as when the instance holding them died.
export async function expireLeases(db: Db, table: string) {
  await db.execute(
    sql.raw(`update ${table} set lease_expires_at = to_timestamp(0) where lease_owner is not null`),
  );
}

// A fresh database as stores hold it, whose statements join the transaction their caller is in, for
// tests that make stores of their own.
export function openStoreDatabase(): Db {
  return createSync({ db: openTestDatabase().db, logger: createLogger({ write() {} }) }).db;
}

type Connected = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

// A pool whose connections wait until its database has been made.
class PoolAfter extends pg.Pool {
  made: Promise<void> = Promise.resolve();

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: Connected): void;
  override connect(callback?: Connected) {
    if (!callback) return this.made.then(() => super.connect());
    this.made.then(
      () => super.connect(callback),
      (error: Error) => callback(error, undefined, () => {}),
    );
  }
}

function onServer(server: string): TestDatabase {
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: server });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  const made = admin(`create database "${name}" template "${inject("databaseTemplate")}"`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const pool = new PoolAfter({ connectionString: url.href, max: 6 });
  pool.made = made;
  // Dropping the database as the test ends cuts the connections still open, which is expected.
  pool.on("error", () => {});
  // Listening stops before the database goes, so no listener tries to connect to it again.
  const listening = new Set<() => Promise<void>>();
  const listenHere = listenAt(url.href);
  const listen: Listen = async (channel, onMessage, onGap) => {
    await made;
    const stop = await listenHere(channel, onMessage, onGap);
    listening.add(stop);
    return async () => {
      listening.delete(stop);
      await stop();
    };
  };
  listen.check = listenHere.check;
  closing.add(async () => {
    await Promise.all([...listening].map((stop) => stop()));
    await pool.end();
    await made.catch(() => {});
    await admin(`drop database if exists "${name}" with (force)`);
  });
  return { db: drizzlePostgres({ client: pool }) as unknown as Db, listen };
}

// Each test's databases close as it ends, after whatever else its end waits for.
afterEach(async () => {
  const ends = [...closing];
  closing.clear();
  await Promise.all(ends.map((end) => end()));
});

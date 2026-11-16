// Databases for the tests: each a Postgres of its own inside the test's process, started from a
// copy, made once for the whole run, of an empty database with every migration applied. With
// TEST_DATABASE_URL set, each is instead a database of its own on that server, made from a
// migrated template, so the tests also run where statements go over several connections at once.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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
// PGlite's code and files, read and compiled once for every database the process opens.
let engine: { pgliteWasmModule: WebAssembly.Module; fsBundle: Blob } | undefined;
function engineOf() {
  const dist = path.dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  return {
    pgliteWasmModule: new WebAssembly.Module(readFileSync(path.join(dist, "pglite.wasm"))),
    fsBundle: new Blob([readFileSync(path.join(dist, "pglite.data"))]),
  };
}
const closing = new Set<() => Promise<void>>();

export interface TestDatabase {
  // The database itself, outside any transaction.
  db: Db;
  listen: Listen;
  // The database this one is more connections to, when it is.
  of?: TestDatabase;
  // On a real server, its connections as one process holds them.
  connections?: Connections;
}

// A test database's connections on a real server, named so Postgres can tell them apart, which a
// test can hold, end and refuse as a process that stops or dies would leave them.
export interface Connections {
  // What each connection tells Postgres it is, as `application_name`; the listening one adds
  // ":listen".
  name: string;
  // More connections to the same database, named, listening through the local port given, when
  // one is.
  another(name: string, listenPort?: number): TestDatabase;
  // The server's address, for a proxy put before a listener.
  readonly server: { host: string; port: number };
  // Holds every statement until the promise settles; null lets them through again.
  hold(until: Promise<void> | null): void;
  // Ends every connection at the server, and refuses every statement from then on.
  end(): Promise<void>;
  // Ends the listening connection at the server.
  endListener(): Promise<void>;
  // The statements refused once ended.
  readonly refused: number;
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
  engine ??= engineOf();
  const client = new PGlite({ loadDataDir: snapshot, ...engine });
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

// Why a statement of an instance that was killed is refused.
const KILLED = "This instance was killed";

// A pool whose connections wait until its database has been made, whose statements wait while
// they are held, and which refuses them all once ended.
class PoolAfter extends pg.Pool {
  made: Promise<void> = Promise.resolve();
  heldUntil: Promise<void> | null = null;
  killed = false;
  refused = 0;
  private readonly patched = new WeakSet<pg.PoolClient>();

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: Connected): void;
  override connect(callback?: Connected) {
    if (this.killed) {
      this.refused += 1;
      const error = new Error(KILLED);
      if (!callback) return Promise.reject(error);
      return callback(error, undefined, () => {});
    }
    const ready = this.made.then(async () => this.heldUntil ?? undefined);
    if (!callback) return ready.then(async () => this.patch(await super.connect()));
    ready.then(
      () =>
        super.connect((error, client, done) => callback(error, client && this.patch(client), done)),
      (error: Error) => callback(error, undefined, () => {}),
    );
  }

  // Each statement on the client waits while statements are held, and is refused once ended.
  private patch(client: pg.PoolClient) {
    if (this.patched.has(client)) return client;
    this.patched.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const last = args.at(-1);
      const callback = typeof last === "function" ? (last as (error: Error) => void) : null;
      const refuse = () => {
        this.refused += 1;
        const error = new Error(KILLED);
        if (callback) return callback(error);
        return Promise.reject(error);
      };
      if (this.killed) return refuse();
      if (!this.heldUntil) return query(...args);
      const after = this.heldUntil.then(() => (this.killed ? refuse() : query(...args)));
      return callback ? undefined : after;
    };
    return client;
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
  const address = new URL(server);
  const urlOf = (applicationName: string, port?: number) => {
    const url = new URL(server);
    url.pathname = `/${name}`;
    if (port) {
      url.hostname = "127.0.0.1";
      url.port = String(port);
    }
    url.searchParams.set("application_name", applicationName);
    return url.href;
  };
  // Ends the named connections at the server, once Postgres no longer lists them.
  const terminate = async (applicationName: string) => {
    const client = new pg.Client({ connectionString: urlOf("admin") });
    await client.connect();
    try {
      for (let tries = 0; tries < 200; tries += 1) {
        const { rows } = await client.query<{ pid: number }>(
          "select pid from pg_stat_activity where datname = $1 and application_name = $2",
          [name, applicationName],
        );
        if (rows.length === 0) return;
        await client.query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [
          rows.map((row) => row.pid),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`The connections of ${applicationName} did not end`);
    } finally {
      await client.end();
    }
  };
  // Every set of connections closes before the database goes, so no listener tries to connect to
  // it again.
  const sets = new Set<() => Promise<void>>();
  closing.add(async () => {
    await Promise.all([...sets].map(async (close) => close()));
    await made.catch(() => {});
    await admin(`drop database if exists "${name}" with (force)`);
  });

  function connected(connectionName: string, listenPort?: number): TestDatabase {
    const pool = new PoolAfter({ connectionString: urlOf(connectionName), max: 6 });
    pool.made = made;
    // Dropping the database as the test ends cuts the connections still open, which is expected.
    pool.on("error", () => {});
    const listening = new Set<() => Promise<void>>();
    const listenHere = listenAt(urlOf(`${connectionName}:listen`, listenPort));
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
    const stopListening = async () => {
      await Promise.all([...listening].map(async (stop) => stop()));
    };
    let poolEnded: Promise<void> | undefined;
    const endPool = async () => (poolEnded ??= pool.end().catch(() => {}));
    sets.add(async () => {
      await stopListening();
      await endPool();
    });
    return {
      db: drizzlePostgres({ client: pool }) as unknown as Db,
      listen,
      ...(first && { of: first }),
      connections: {
        name: connectionName,
        another: (other, port) => connected(other, port),
        server: { host: address.hostname, port: Number(address.port || 5432) },
        hold(until) {
          pool.heldUntil = until;
        },
        async end() {
          pool.killed = true;
          await stopListening();
          await Promise.all([terminate(connectionName), terminate(`${connectionName}:listen`)]);
          void endPool();
        },
        endListener: async () => terminate(`${connectionName}:listen`),
        get refused() {
          return pool.refused;
        },
      },
    };
  }
  let first: TestDatabase | undefined;
  first = connected("mage");
  return first;
}

// Each test's databases close as it ends, after whatever else its end waits for.
afterEach(async () => {
  const ends = [...closing];
  closing.clear();
  await Promise.all(ends.map((end) => end()));
});

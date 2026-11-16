// What the server instances on one database agree through: transactions and what waits for their
// commit, the signals passed between requests, workers and instances, periodic work and the leases
// it keeps, rows taken as they come due, work one instance does at a time, and the instance's name
// among the others.

import { sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";
import type { Logger } from "@/server/kernel/logger.ts";

import { createClaims } from "./claim.ts";
import { createKeeper, type Keeper, type KeeperOptions } from "./keeper.ts";
import { CHANNEL, createSignals, type Listen } from "./signals.ts";
import { createTicker, type Ticker } from "./ticker.ts";
import { createTransactor, type SyncStats } from "./transact.ts";

export type { Keeper, KeeperOptions } from "./keeper.ts";
export type { Listen } from "./signals.ts";
export type { Ticker } from "./ticker.ts";
export type { AfterCommit, SyncStats, Transact } from "./transact.ts";

export type Sync = ReturnType<typeof createSync>;

export function createSync(deps: {
  // The database itself, outside any transaction.
  db: Db;
  // Hears what other instances notify; without it, signals reach this process alone.
  listen?: Listen;
  logger: Logger;
  // Names the instance; made up when not given.
  instanceId?: string;
}) {
  const instanceId = deps.instanceId ?? ulid();
  const stats: SyncStats = { retries: 0, outOfOrder: 0, insideCalls: 0, failedJoins: 0 };
  const transactor = createTransactor(deps.db, {
    logger: deps.logger,
    stats,
    // The transaction's signals, notified in one statement just before it commits, so Postgres
    // delivers them as it does and never when it rolls back.
    beforeCommit: async (queued, tx) => {
      await tx.execute(
        sql`select pg_notify(${CHANNEL}, message) from json_array_elements_text(${JSON.stringify(queued)}::json) as message`,
      );
    },
  });
  const { db, transact, join, afterCommit, inTransaction, ordered, holds, outside } = transactor;
  const signals = createSignals({
    instanceId,
    logger: deps.logger,
    listen: deps.listen,
    queue: (message) => {
      const unit = transactor.current();
      unit?.queued.push(message);
      return unit !== undefined;
    },
    afterCommit,
    notify: async (message) => deps.db.execute(sql`select pg_notify(${CHANNEL}, ${message})`),
  });

  // Everything periodic made here, stopped with it.
  const running = new Set<{ stop(): Promise<void> }>();
  const { listen } = deps;

  function ticker(
    name: string,
    pass: () => Promise<unknown>,
    everyMs: number,
    opts: { singleton?: boolean } = {},
  ): Ticker {
    // A pass asked for inside a transaction runs outside it all the same.
    const run = opts.singleton ? async () => claims.singleton(name, pass) : pass;
    const made = createTicker(name, async () => transactor.detached(run), everyMs, deps.logger);
    running.add(made);
    return made;
  }

  function keeper<L>(opts: KeeperOptions<L>): Keeper {
    const made = createKeeper(
      {
        ...opts,
        renew: async (lease) => transactor.detached(async () => opts.renew(lease)),
        ...(opts.sweep && { sweep: async () => transactor.detached(async () => opts.sweep!()) }),
      },
      deps.logger,
    );
    running.add(made);
    return { ...made, stop: async () => made.stop().finally(() => running.delete(made)) };
  }

  const claims = createClaims({ db, inTransaction, instanceId, keeper, logger: deps.logger });

  // The listening connection is checked now and then, so one lost without a word is made again.
  const checking = listen?.check && ticker("listener", async () => listen.check?.(), 30_000);

  return {
    instanceId,
    db,
    transact,
    join,
    afterCommit,
    inTransaction,
    ordered,
    holds,
    outside,
    signals,
    stats,

    ticker,
    keeper,
    singleton: claims.singleton,
    claimDue: claims.claimDue,

    // Hears what the other instances send.
    async start() {
      await signals.start();
      await checking?.start();
    },

    // Stops every ticker and keeper made here, then listening.
    async stop() {
      await Promise.all([...running].map(async (made) => made.stop()));
      await signals.settled();
      await signals.stop();
    },
  };
}

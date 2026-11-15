// Runs store work in transactions. Stores hold one database; inside a transaction's work, whatever
// they run joins it, however deep the calls go, and a transaction begun inside another is a
// savepoint of it. What must wait for the work to be kept, as telling others of it, runs once the
// outermost transaction commits. The outermost transaction is run again when Postgres gives it up
// to a deadlock or a serialisation failure, so its work must change nothing outside the database
// but through `afterCommit`. Row locks a transaction takes through `ordered` go in id order, and a
// lock asked for out of that order is counted.

import { AsyncLocalStorage } from "node:async_hooks";

import type { Db } from "@/server/db/db.ts";
import type { Logger } from "@/server/kernel/logger.ts";

export type Transact = <T>(work: () => Promise<T>) => Promise<T>;

// Runs the function once the transaction under way commits, or at once outside any; never when
// it rolls back.
export type AfterCommit = (run: () => void) => void;

// Counts of what a test wants to see none of, or few: transactions run again, locks taken out of
// order, and calls that must not run in a transaction made inside one.
export interface SyncStats {
  retries: number;
  outOfOrder: number;
  insideCalls: number;
}

// A transaction under way, or a savepoint of one.
export interface Unit {
  tx: Db;
  // Set as its work ends, so that work it started and did not wait for goes to the database
  // itself from then on.
  done: boolean;
  // A savepoint of this unit is under way.
  busy: boolean;
  after: (() => void)[];
  // Kept for the outermost transaction's commit; a rolled-back savepoint's are dropped with it.
  queued: unknown[];
  // Row locks taken in this unit, by scope. A savepoint's go to its parent when it is released
  // and are dropped when it rolls back, as Postgres drops the locks themselves.
  held: Map<string, string[]>;
  // The unit this one is a savepoint of.
  parent?: Unit;
}

// The row locks of the scope the unit holds, its own and those of the units it is a savepoint of.
function heldBy(unit: Unit | undefined, scope: string): string[] {
  const held: string[] = [];
  for (let at = unit; at; at = at.parent) held.push(...(at.held.get(scope) ?? []));
  return held;
}

// Deadlock and serialisation failure: the transaction lost to another and may simply run again.
const RETRIABLE = new Set(["40P01", "40001"]);
const ATTEMPTS = 3;

function codeOf(err: unknown): string | undefined {
  for (let at = err; at && typeof at === "object"; at = (at as { cause?: unknown }).cause) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function retriable(err: unknown) {
  const code = codeOf(err);
  return code !== undefined && RETRIABLE.has(code);
}

export interface TransactorOptions {
  logger: Logger;
  stats: SyncStats;
  // Runs last in the outermost transaction, with what its work queued.
  beforeCommit?: (queued: unknown[], tx: Db) => Promise<void>;
  // How long to wait before running a transaction again; jittered and growing by attempt.
  backoff?: (attempt: number) => number;
}

export function createTransactor(root: Db, options: TransactorOptions) {
  const { logger, stats } = options;
  const backoff = options.backoff ?? ((attempt) => (10 + Math.random() * 40) * attempt);
  const units = new AsyncLocalStorage<Unit>();
  const current = () => {
    const unit = units.getStore();
    return unit && !unit.done ? unit : undefined;
  };

  function runAfter(run: () => void) {
    try {
      run();
    } catch (err) {
      logger.error({ err }, "after-commit step failed");
    }
  }

  async function once<T>(parent: Db, work: () => Promise<T>, outer?: Unit): Promise<T> {
    const unit: Unit = {
      tx: parent,
      done: false,
      busy: false,
      after: [],
      queued: [],
      held: new Map(),
      ...(outer && { parent: outer }),
    };
    if (outer) {
      // Two savepoints of one transaction at once are work it did not wait for, which would
      // interleave with its own statements.
      if (outer.busy) throw new Error("A transaction was begun by work its own did not wait for.");
      outer.busy = true;
    }
    try {
      const result = await parent.transaction(async (tx) => {
        unit.tx = tx as unknown as Db;
        try {
          const result = await units.run(unit, work);
          if (!outer && options.beforeCommit && unit.queued.length > 0) {
            await options.beforeCommit(unit.queued, unit.tx);
          }
          return result;
        } finally {
          unit.done = true;
        }
      });
      if (outer) {
        outer.after.push(...unit.after);
        outer.queued.push(...unit.queued);
        for (const [scope, ids] of unit.held) {
          outer.held.set(scope, [...(outer.held.get(scope) ?? []), ...ids]);
        }
      } else {
        // What was waiting runs outside the transaction it waited for.
        units.exit(() => unit.after.forEach((run) => runAfter(run)));
      }
      return result;
    } finally {
      if (outer) outer.busy = false;
    }
  }

  const transact: Transact = async (work) => {
    const unit = current();
    if (unit) return once(unit.tx, work, unit);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(root, work);
      } catch (err) {
        if (!retriable(err) || attempt >= ATTEMPTS) throw err;
        stats.retries += 1;
        logger.debug({ err, attempt }, "transaction run again");
        await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
      }
    }
  };

  const afterCommit: AfterCommit = (run) => {
    const unit = current();
    if (unit) unit.after.push(run);
    else runAfter(run);
  };

  // The database as stores hold it: each statement goes to the transaction its caller is in, or
  // to the database itself outside any.
  const db = new Proxy(root, {
    get(_target, key) {
      if (key === "transaction")
        return (work: (tx: Db) => Promise<unknown>) => transact(() => work(db));
      const target = current()?.tx ?? root;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  return {
    db,
    transact,
    afterCommit,
    current,
    // Whether the caller is inside a transaction, which may read what others cannot see yet.
    inTransaction: () => current() !== undefined,
    // Runs the work outside whatever transaction its caller is in, as work that outlives it must.
    detached: <T>(work: () => T): T => units.exit(work),

    // Whether the transaction under way holds the lock of the scope's row.
    holds: (scope: string, id: string) => heldBy(current(), scope).includes(id),

    // Takes the locks of the scope's rows by `lock`, in id order, leaving out those the
    // transaction holds already. One asked for below a row it holds is out of order: two
    // transactions doing so in turn can deadlock, which running again only papers over.
    ordered: async (scope: string, ids: string[], lock: (ids: string[]) => Promise<void>) => {
      const unit = current();
      const held = heldBy(unit, scope);
      const wanted = [...new Set(ids)].filter((id) => !held.includes(id)).sort();
      if (wanted.length === 0) return;
      const highest = held.reduce((max, id) => (id > max ? id : max), "");
      if (wanted[0]! < highest) {
        stats.outOfOrder += 1;
        logger.warn({ scope, held, wanted }, "lock taken out of order");
      }
      await lock(wanted);
      unit?.held.set(scope, [...(unit.held.get(scope) ?? []), ...wanted]);
    },

    // The function, counting and warning of each call made inside a transaction, where a call
    // across the network would hold its locks for as long as it takes.
    outside: <F extends (...args: never[]) => unknown>(what: string, fn: F): F =>
      ((...args: Parameters<F>) => {
        if (current()) {
          stats.insideCalls += 1;
          logger.warn({ what }, "called inside a transaction");
        }
        return fn(...args);
      }) as F,
  };
}

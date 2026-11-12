import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import type { Db } from "@/server/db/db.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";

import { user } from "@/server/orgs/schema.ts";

import { threadTrigger } from "./schema.ts";
import type { TriggerRecord, TriggerStore } from "./triggers.ts";

// A column holds the value, null included.
function holds<T>(column: SQLiteColumn, value: T | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

// What a sealed signing secret is bound to: its webhook.
const secretContext = (id: string) => `thread_trigger.secret:${id}`;

export function createTriggerStore(db: Db, cipher: Cipher): TriggerStore {
  return {
    create(row) {
      return db.insert(threadTrigger).values(row).returning().get();
    },

    find(id) {
      return db.select().from(threadTrigger).where(eq(threadTrigger.id, id)).get() ?? null;
    },

    userName(userId) {
      return (
        db.select({ name: user.name }).from(user).where(eq(user.id, userId)).get()?.name ?? null
      );
    },

    findByToken(token) {
      return (
        db.select().from(threadTrigger).where(eq(threadTrigger.hookToken, token)).get() ?? null
      );
    },

    setSecret(id, secret) {
      const sealed = secret ? cipher.seal(Buffer.from(secret), secretContext(id)) : null;
      db.update(threadTrigger)
        .set({
          secretKeyVersion: sealed?.keyVersion ?? null,
          secret: sealed?.data ?? null,
        })
        .where(eq(threadTrigger.id, id))
        .run();
    },

    openSecret(record) {
      if (!record.secret || record.secretKeyVersion === null) return null;
      return cipher
        .open(
          { keyVersion: record.secretKeyVersion, data: record.secret },
          secretContext(record.id),
        )
        .toString();
    },

    delivered(id, at) {
      db.update(threadTrigger)
        .set({ lastFiredAt: at })
        .where(and(eq(threadTrigger.id, id), eq(threadTrigger.status, "active")))
        .run();
    },

    inThread(threadId): TriggerRecord[] {
      return db
        .select()
        .from(threadTrigger)
        .where(
          and(
            eq(threadTrigger.threadId, threadId),
            notInArray(threadTrigger.status, ["deleted", "done"]),
          ),
        )
        .orderBy(asc(threadTrigger.createdAt), asc(threadTrigger.id))
        .all();
    },

    everInThread(threadId): TriggerRecord[] {
      return db
        .select()
        .from(threadTrigger)
        .where(eq(threadTrigger.threadId, threadId))
        .orderBy(asc(threadTrigger.createdAt), asc(threadTrigger.id))
        .all();
    },

    update(id, fields) {
      return db
        .update(threadTrigger)
        .set(fields)
        .where(and(eq(threadTrigger.id, id), notInArray(threadTrigger.status, ["deleted"])))
        .returning()
        .get();
    },

    due(now, limit) {
      return db
        .select()
        .from(threadTrigger)
        .where(
          and(
            eq(threadTrigger.status, "active"),
            or(
              and(isNull(threadTrigger.pendingFireAt), lte(threadTrigger.nextRunAt, now)),
              and(isNotNull(threadTrigger.pendingFireAt), lt(threadTrigger.claimedUntil, now)),
            ),
          ),
        )
        .orderBy(asc(threadTrigger.nextRunAt))
        .limit(limit)
        .all();
    },

    // One conditional update: it applies only to the row as it was read, so of several instances
    // taking the same due row, one wins.
    claim(seen, fields) {
      return (
        db
          .update(threadTrigger)
          .set(fields)
          .where(
            and(
              eq(threadTrigger.id, seen.id),
              eq(threadTrigger.status, "active"),
              holds(threadTrigger.nextRunAt, seen.nextRunAt),
              holds(threadTrigger.pendingFireAt, seen.pendingFireAt),
              holds(threadTrigger.claimedUntil, seen.claimedUntil),
            ),
          )
          .returning()
          .get() ?? null
      );
    },

    // Ends the claim, if it is still the instance's.
    release(id, by, fields) {
      db.update(threadTrigger)
        .set({
          ...fields,
          pendingFireAt: null,
          claimedBy: null,
          claimedUntil: null,
        })
        .where(and(eq(threadTrigger.id, id), eq(threadTrigger.claimedBy, by)))
        .run();
    },

    finishOnce(id) {
      db.update(threadTrigger)
        .set({ status: "done" })
        .where(and(eq(threadTrigger.id, id), inArray(threadTrigger.status, ["active"])))
        .run();
    },
  };
}

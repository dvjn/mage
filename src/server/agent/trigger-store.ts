import { and, asc, eq, inArray, isNull, lte, notInArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { Db } from "@/server/db/db.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";

import { user } from "@/server/orgs/schema.ts";

import { threadTrigger } from "./schema.ts";
import type { TriggerRecord, TriggerStore } from "./triggers.ts";

// A column holds the value, null included.
function holds<T>(column: PgColumn, value: T | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

// What a sealed signing secret is bound to: its webhook.
const secretContext = (id: string) => `thread_trigger.secret:${id}`;

export function createTriggerStore(db: Db, cipher: Cipher): TriggerStore {
  return {
    async create(row) {
      return (await db.insert(threadTrigger).values(row).returning())[0]!;
    },

    async find(id) {
      return (
        (await db.select().from(threadTrigger).where(eq(threadTrigger.id, id)).limit(1))[0] ?? null
      );
    },

    async userName(userId) {
      return (
        (await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0]
          ?.name ?? null
      );
    },

    async findByToken(token) {
      return (
        (
          await db.select().from(threadTrigger).where(eq(threadTrigger.hookToken, token)).limit(1)
        )[0] ?? null
      );
    },

    async setSecret(id, secret) {
      const sealed = secret ? cipher.seal(Buffer.from(secret), secretContext(id)) : null;
      await db
        .update(threadTrigger)
        .set({
          secretKeyVersion: sealed?.keyVersion ?? null,
          secret: sealed?.data ?? null,
        })
        .where(eq(threadTrigger.id, id));
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

    async delivered(id, at) {
      await db
        .update(threadTrigger)
        .set({ lastFiredAt: at })
        .where(and(eq(threadTrigger.id, id), eq(threadTrigger.status, "active")));
    },

    async inThread(threadId): Promise<TriggerRecord[]> {
      return await db
        .select()
        .from(threadTrigger)
        .where(
          and(
            eq(threadTrigger.threadId, threadId),
            notInArray(threadTrigger.status, ["deleted", "done"]),
          ),
        )
        .orderBy(asc(threadTrigger.createdAt), asc(threadTrigger.id));
    },

    async update(id, fields) {
      return (
        await db
          .update(threadTrigger)
          .set(fields)
          .where(and(eq(threadTrigger.id, id), notInArray(threadTrigger.status, ["deleted"])))
          .returning()
      )[0];
    },

    async due(now, limit) {
      return await db
        .select()
        .from(threadTrigger)
        .where(and(eq(threadTrigger.status, "active"), lte(threadTrigger.nextRunAt, now)))
        .orderBy(asc(threadTrigger.nextRunAt))
        .limit(limit);
    },

    // One conditional update: it applies only to the row as it was read, so of several instances
    // moving the same due row on, one wins.
    async advance(seen, fields) {
      return (
        (
          await db
            .update(threadTrigger)
            .set(fields)
            .where(
              and(
                eq(threadTrigger.id, seen.id),
                eq(threadTrigger.status, "active"),
                holds(threadTrigger.nextRunAt, seen.nextRunAt),
              ),
            )
            .returning()
        )[0] ?? null
      );
    },

    async finishOnce(id) {
      await db
        .update(threadTrigger)
        .set({ status: "done" })
        .where(and(eq(threadTrigger.id, id), inArray(threadTrigger.status, ["active"])));
    },
  };
}

// How far each person has seen each thread, and when they last saw each kind of its activity.

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import { threadActivitySeen, threadRead } from "./schema.ts";

export interface ThreadReadStore {
  // The seq each of the threads named was seen up to by the user, for those they have seen.
  seen(userId: string, threadIds: string[]): Promise<Map<string, number>>;
  // Records the user saw the thread up to `seq`, never moving back; returns how far they have now.
  // Seen now by the database's clock, which the list feed asks what was read since by.
  mark(userId: string, threadId: string, seq: number): Promise<number>;
  // When the user last saw each kind of the thread's background work, in milliseconds, by kind.
  activitySeen(userId: string, threadId: string): Promise<Map<string, number>>;
  // Records the user saw the kind of background work now.
  markActivity(userId: string, threadId: string, kind: string, at: Date): Promise<void>;
}

export function createThreadReadStore(db: Db): ThreadReadStore {
  return {
    async seen(userId, threadIds) {
      if (threadIds.length === 0) return new Map();
      const rows = await db
        .select({ threadId: threadRead.threadId, seq: threadRead.lastSeenSeq })
        .from(threadRead)
        .where(and(eq(threadRead.userId, userId), inArray(threadRead.threadId, threadIds)));
      return new Map(rows.map((row) => [row.threadId, row.seq]));
    },

    async activitySeen(userId, threadId) {
      const rows = await db
        .select({ kind: threadActivitySeen.kind, at: threadActivitySeen.seenAt })
        .from(threadActivitySeen)
        .where(
          and(eq(threadActivitySeen.userId, userId), eq(threadActivitySeen.threadId, threadId)),
        );
      return new Map(rows.map((row) => [row.kind, row.at.getTime()]));
    },

    async markActivity(userId, threadId, kind, at) {
      await db
        .insert(threadActivitySeen)
        .values({ userId, threadId, kind, seenAt: at })
        .onConflictDoUpdate({
          target: [threadActivitySeen.userId, threadActivitySeen.threadId, threadActivitySeen.kind],
          set: { seenAt: at },
        });
    },

    async mark(userId, threadId, seq) {
      const row = (
        await db
          .insert(threadRead)
          .values({ userId, threadId, lastSeenSeq: seq, seenAt: sql`now()` })
          .onConflictDoUpdate({
            target: [threadRead.userId, threadRead.threadId],
            set: {
              lastSeenSeq: sql`greatest(${threadRead.lastSeenSeq}, excluded.last_seen_seq)`,
              seenAt: sql`excluded.seen_at`,
            },
          })
          .returning({ seq: threadRead.lastSeenSeq })
      )[0]!;
      return row.seq;
    },
  };
}

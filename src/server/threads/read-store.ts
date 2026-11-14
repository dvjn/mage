import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { ThreadReadStore } from "./service.ts";
import { threadBackgroundSeen, threadRead } from "./schema.ts";

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

    async backgroundSeen(userId, threadId) {
      const rows = await db
        .select({ kind: threadBackgroundSeen.kind, at: threadBackgroundSeen.seenAt })
        .from(threadBackgroundSeen)
        .where(
          and(eq(threadBackgroundSeen.userId, userId), eq(threadBackgroundSeen.threadId, threadId)),
        );
      return new Map(rows.map((row) => [row.kind, row.at.getTime()]));
    },

    async markBackground(userId, threadId, kind, at) {
      await db
        .insert(threadBackgroundSeen)
        .values({ userId, threadId, kind, seenAt: at })
        .onConflictDoUpdate({
          target: [
            threadBackgroundSeen.userId,
            threadBackgroundSeen.threadId,
            threadBackgroundSeen.kind,
          ],
          set: { seenAt: at },
        });
    },

    async mark(userId, threadId, seq, at) {
      const row = (
        await db
          .insert(threadRead)
          .values({ userId, threadId, lastSeenSeq: seq, seenAt: at })
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

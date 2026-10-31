import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { ThreadReadStore } from "./service.ts";
import { threadRead } from "./schema.ts";

export function createThreadReadStore(db: Db): ThreadReadStore {
  return {
    seen(userId, threadIds) {
      if (threadIds.length === 0) return new Map();
      const rows = db
        .select({ threadId: threadRead.threadId, seq: threadRead.lastSeenSeq })
        .from(threadRead)
        .where(and(eq(threadRead.userId, userId), inArray(threadRead.threadId, threadIds)))
        .all();
      return new Map(rows.map((row) => [row.threadId, row.seq]));
    },

    mark(userId, threadId, seq, at) {
      const row = db
        .insert(threadRead)
        .values({ userId, threadId, lastSeenSeq: seq, seenAt: at })
        .onConflictDoUpdate({
          target: [threadRead.userId, threadRead.threadId],
          set: {
            lastSeenSeq: sql`max(${threadRead.lastSeenSeq}, excluded.last_seen_seq)`,
            seenAt: sql`excluded.seen_at`,
          },
        })
        .returning({ seq: threadRead.lastSeenSeq })
        .get();
      return row.seq;
    },
  };
}

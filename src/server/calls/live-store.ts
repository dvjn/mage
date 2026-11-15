// Where running calls' output is kept while they run, for every instance on the database to read:
// one row per call with how much it printed and its progress, and the end of its output in pieces.

import { and, asc, eq, lt, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import type { LiveChunk, LiveProgress } from "@/shared/threads/events.ts";

import { callOutput, callOutputChunk } from "./schema.ts";

// What a call printed, as kept: its text from character `from` on, of `total` printed in all.
export interface LiveTail {
  from: number;
  text: string;
  total: number;
  progress?: LiveProgress;
}

export interface LiveStore {
  // Holds the call's thread for the transaction under way, as a write to its log does.
  lock(threadId: string): Promise<void>;
  // Records how much the call printed and its progress, with the piece printed since the last, and
  // drops the pieces wholly before `keepFrom`.
  write(
    threadId: string,
    callId: string,
    change: {
      total: number;
      progress?: LiveProgress;
      piece?: { offset: number; text: string };
      keepFrom: number;
    },
  ): Promise<void>;
  // What is kept of the call's output, its last `cap` characters at most.
  tail(callId: string, cap: number): Promise<LiveTail | null>;
  // What is kept of each of the thread's running calls, as one piece each.
  inThread(threadId: string, cap: number): Promise<LiveChunk[]>;
  remove(callId: string): Promise<void>;
}

export function createLiveStore(db: Db): LiveStore {
  async function tailOf(row: typeof callOutput.$inferSelect, cap: number): Promise<LiveTail> {
    const pieces = await db
      .select({ offset: callOutputChunk.offset, text: callOutputChunk.text })
      .from(callOutputChunk)
      .where(eq(callOutputChunk.callId, row.callId))
      .orderBy(asc(callOutputChunk.offset));
    const first = pieces[0]?.offset ?? row.total;
    const from = Math.max(first, row.total - cap);
    const text = pieces
      .map((piece) => piece.text)
      .join("")
      .slice(from - first);
    return { from, text, total: row.total, ...(row.progress && { progress: row.progress }) };
  }

  return {
    async lock(threadId) {
      await db.execute(sql`select 1 from thread where id = ${threadId} for no key update`);
    },

    async write(threadId, callId, { total, progress, piece, keepFrom }) {
      await db
        .insert(callOutput)
        .values({ callId, threadId, total, progress: progress ?? null })
        .onConflictDoUpdate({
          target: callOutput.callId,
          set: { total, ...(progress && { progress }) },
        });
      if (piece?.text) await db.insert(callOutputChunk).values({ callId, ...piece });
      // The piece the cut falls in stays, to be cut where it is read.
      await db.delete(callOutputChunk).where(
        and(
          eq(callOutputChunk.callId, callId),
          lt(
            callOutputChunk.offset,
            sql`(select max(${callOutputChunk.offset}) from ${callOutputChunk}
                   where ${callOutputChunk.callId} = ${callId} and ${callOutputChunk.offset} <= ${keepFrom})`,
          ),
        ),
      );
    },

    async tail(callId, cap) {
      const row = (
        await db.select().from(callOutput).where(eq(callOutput.callId, callId)).limit(1)
      )[0];
      return row ? await tailOf(row, cap) : null;
    },

    async inThread(threadId, cap) {
      const rows = await db.select().from(callOutput).where(eq(callOutput.threadId, threadId));
      return (
        await Promise.all(
          rows.map(async (row) => {
            const { from, text, progress } = await tailOf(row, cap);
            if (!text && !progress) return [];
            return [
              { callId: row.callId, offset: from, text, from, ...(progress && { progress }) },
            ];
          }),
        )
      ).flat();
    },

    async remove(callId) {
      await db.delete(callOutput).where(eq(callOutput.callId, callId));
    },
  };
}

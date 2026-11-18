// Rows of space memory. An entry is retired in one guarded statement, so of two writers that
// retire the same entry only one does.

import { and, desc, eq, getTableColumns, isNull, type SQL, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";
import { thread } from "@/server/threads/schema.ts";
import type { MemoryType } from "@/shared/memory.ts";

import { memoryEntry } from "./schema.ts";

export type MemoryRow = Omit<typeof memoryEntry.$inferSelect, "search">;
export type NewMemoryRow = Omit<MemoryRow, "retiredAt" | "retiredBy" | "createdAt">;

export type MemoryStore = ReturnType<typeof createMemoryStore>;

// Every column but the search one, which only queries read.
const { search: _search, ...columns } = getTableColumns(memoryEntry);

export function createMemoryStore(db: Db) {
  const live = (spaceId: string) =>
    and(eq(memoryEntry.spaceId, spaceId), isNull(memoryEntry.retiredAt));

  return {
    // Null when the call saved one already.
    async create(row: NewMemoryRow): Promise<MemoryRow | null> {
      const made = await db
        .insert(memoryEntry)
        .values(row)
        .onConflictDoNothing({
          target: [memoryEntry.threadId, memoryEntry.callId],
          where: sql`${memoryEntry.callId} is not null`,
        })
        .returning(columns);
      return made[0] ?? null;
    },

    async find(id: string): Promise<MemoryRow | null> {
      return (
        (await db.select(columns).from(memoryEntry).where(eq(memoryEntry.id, id)).limit(1))[0] ??
        null
      );
    },

    // What the call saved, if it saved anything.
    async ofCall(threadId: string, callId: string): Promise<MemoryRow | null> {
      return (
        (
          await db
            .select(columns)
            .from(memoryEntry)
            .where(and(eq(memoryEntry.threadId, threadId), eq(memoryEntry.callId, callId)))
            .limit(1)
        )[0] ?? null
      );
    },

    // The space's entries in use, newest first.
    async live(spaceId: string): Promise<MemoryRow[]> {
      return db
        .select(columns)
        .from(memoryEntry)
        .where(live(spaceId))
        .orderBy(desc(memoryEntry.createdAt), desc(memoryEntry.id));
    },

    // The space's entries in use that match: any word of the query but those marked with a "-",
    // best first, and the topic and type when given; newest first without words to match.
    async search(
      spaceId: string,
      find: { query?: string; topic?: string; type?: MemoryType },
      limit: number,
    ): Promise<MemoryRow[]> {
      const where: (SQL | undefined)[] = [live(spaceId)];
      if (find.topic) where.push(sql`lower(${memoryEntry.topic}) = lower(${find.topic})`);
      if (find.type) where.push(eq(memoryEntry.type, find.type));
      const words = (find.query ?? "").split(/\s+/).filter(Boolean);
      const anyOf = (list: string[]) =>
        sql`cast(replace(plainto_tsquery('english', ${list.join(" ")})::text, ' & ', ' | ') as tsquery)`;
      const wanted = anyOf(words.filter((word) => !word.startsWith("-")));
      const unwanted = anyOf(
        words.flatMap((word) => (word.startsWith("-") ? [word.slice(1)] : [])),
      );
      // A query of stopwords alone matches nothing to rank by, and falls back to newest first.
      where.push(sql`(numnode(${wanted}) = 0 or ${memoryEntry.search} @@ ${wanted})`);
      where.push(sql`not (numnode(${unwanted}) > 0 and ${memoryEntry.search} @@ ${unwanted})`);
      return db
        .select(columns)
        .from(memoryEntry)
        .where(and(...where))
        .orderBy(
          desc(
            sql`case when numnode(${wanted}) = 0 then 0 else ts_rank(${memoryEntry.search}, ${wanted}) end`,
          ),
          desc(memoryEntry.createdAt),
          desc(memoryEntry.id),
        )
        .limit(limit);
    },

    // Retires the space's entry still in use, answering whether it did.
    async retire(spaceId: string, id: string, by: string | null, at: Date) {
      const moved = await db
        .update(memoryEntry)
        .set({ retiredAt: at, retiredBy: by })
        .where(and(eq(memoryEntry.id, id), live(spaceId)))
        .returning({ id: memoryEntry.id });
      return moved.length > 0;
    },

    // The space's entries in use, newest first, in one read: each with its source thread while
    // that thread is still in the space, and the name of who approved it.
    async listed(spaceId: string) {
      return db
        .select({
          ...columns,
          threadTitle: thread.title,
          sourceId: thread.id,
          approverName: user.name,
        })
        .from(memoryEntry)
        .leftJoin(
          thread,
          and(eq(thread.id, memoryEntry.threadId), eq(thread.spaceId, memoryEntry.spaceId)),
        )
        .leftJoin(user, eq(user.id, memoryEntry.approvedBy))
        .where(live(spaceId))
        .orderBy(desc(memoryEntry.createdAt), desc(memoryEntry.id));
    },

    // The topic the space's entries in use already write the topic as, whatever its case.
    async topicAs(spaceId: string, topic: string): Promise<string | null> {
      const found = await db
        .select({ topic: memoryEntry.topic })
        .from(memoryEntry)
        .where(and(live(spaceId), sql`lower(${memoryEntry.topic}) = lower(${topic})`))
        .orderBy(desc(memoryEntry.createdAt))
        .limit(1);
      return found[0]?.topic ?? null;
    },
  };
}

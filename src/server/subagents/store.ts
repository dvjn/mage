import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { SubagentRecord, SubagentStore } from "./subagents.ts";
import { subagent } from "./schema.ts";

export function createSubagentStore(db: Db): SubagentStore {
  return {
    async create(input) {
      return (await db.insert(subagent).values(input).returning())[0]!;
    },

    async find(threadId) {
      return (
        (await db.select().from(subagent).where(eq(subagent.threadId, threadId)).limit(1))[0] ??
        null
      );
    },

    async ofParents(parentThreadIds): Promise<SubagentRecord[]> {
      if (parentThreadIds.length === 0) return [];
      return await db
        .select()
        .from(subagent)
        .where(inArray(subagent.parentThreadId, parentThreadIds))
        .orderBy(asc(subagent.createdAt), asc(subagent.threadId));
    },

    async archive(threadId, at) {
      return (
        (
          await db
            .update(subagent)
            .set({ archivedAt: at })
            .where(and(eq(subagent.threadId, threadId), isNull(subagent.archivedAt)))
            .returning()
        )[0] ?? null
      );
    },

    async unarchive(threadId) {
      return (
        (
          await db
            .update(subagent)
            .set({ archivedAt: null })
            .where(and(eq(subagent.threadId, threadId), isNotNull(subagent.archivedAt)))
            .returning()
        )[0] ?? null
      );
    },
  };
}

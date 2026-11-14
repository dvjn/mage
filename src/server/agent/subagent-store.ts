import { asc, eq, inArray } from "drizzle-orm";

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

    async setShareTasks(threadId) {
      await db.update(subagent).set({ shareTasks: true }).where(eq(subagent.threadId, threadId));
    },

    async setArchived(threadId, at) {
      await db.update(subagent).set({ archivedAt: at }).where(eq(subagent.threadId, threadId));
    },
  };
}

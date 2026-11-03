import { asc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { SubagentRecord, SubagentStore } from "./subagents.ts";
import { subagent } from "./schema.ts";

export function createSubagentStore(db: Db): SubagentStore {
  return {
    create(input) {
      return db.insert(subagent).values(input).returning().get();
    },

    find(threadId) {
      return db.select().from(subagent).where(eq(subagent.threadId, threadId)).get() ?? null;
    },

    ofParents(parentThreadIds): SubagentRecord[] {
      if (parentThreadIds.length === 0) return [];
      return db
        .select()
        .from(subagent)
        .where(inArray(subagent.parentThreadId, parentThreadIds))
        .orderBy(asc(subagent.createdAt), asc(subagent.threadId))
        .all();
    },

    setArchived(threadId, at) {
      db.update(subagent).set({ archivedAt: at }).where(eq(subagent.threadId, threadId)).run();
    },
  };
}

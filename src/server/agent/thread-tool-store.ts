// The tools each thread turned on by searching for them, in the order it did, each with the call
// that turned it on.

import { asc, eq, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import { threadTool } from "./schema.ts";

export interface ToolOn {
  id: string;
  callId: string;
}

export type ThreadToolStore = ReturnType<typeof createThreadToolStore>;

export function createThreadToolStore(db: Db) {
  return {
    async turnOn(threadId: string, callId: string, toolIds: readonly string[]) {
      const on = (
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(threadTool)
          .where(eq(threadTool.threadId, threadId))
      )[0];
      const values = [...new Set(toolIds)].map((toolId, index) => ({
        threadId,
        toolId,
        callId,
        position: (on?.count ?? 0) + index,
      }));
      if (values.length > 0) await db.insert(threadTool).values(values).onConflictDoNothing();
    },

    async on(threadId: string): Promise<ToolOn[]> {
      return await db
        .select({ id: threadTool.toolId, callId: threadTool.callId })
        .from(threadTool)
        .where(eq(threadTool.threadId, threadId))
        .orderBy(asc(threadTool.position));
    },
  };
}

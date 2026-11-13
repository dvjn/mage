// The thread whose agent started a subagent's thread, as SQL on a thread's id: the subagent row
// says it, and only it.

import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { subagent } from "@/server/agent/schema.ts";

export function parentOf(threadId: SQLiteColumn): SQL<string | null> {
  return sql<
    string | null
  >`(select ${subagent.parentThreadId} from ${subagent} where ${subagent.threadId} = ${threadId})`;
}

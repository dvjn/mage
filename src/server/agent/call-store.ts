import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import { backgroundCall } from "./schema.ts";
import type { CallRecord, CallStore } from "./calls.ts";

export function createCallStore(db: Db): CallStore {
  return {
    create(input) {
      return db.insert(backgroundCall).values(input).returning().get();
    },

    find(id) {
      return db.select().from(backgroundCall).where(eq(backgroundCall.id, id)).get() ?? null;
    },

    inThread(threadId): CallRecord[] {
      return db
        .select()
        .from(backgroundCall)
        .where(eq(backgroundCall.threadId, threadId))
        .orderBy(desc(backgroundCall.createdAt), desc(backgroundCall.id))
        .all();
    },

    open(threadId): CallRecord[] {
      return db
        .select()
        .from(backgroundCall)
        .where(
          and(
            eq(backgroundCall.threadId, threadId),
            inArray(backgroundCall.status, ["pending", "running"]),
          ),
        )
        .all();
    },

    running(): CallRecord[] {
      return db.select().from(backgroundCall).where(eq(backgroundCall.status, "running")).all();
    },

    update(id, fields) {
      db.update(backgroundCall).set(fields).where(eq(backgroundCall.id, id)).run();
    },
  };
}

import { and, asc, count, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";

import { threadTask, threadTaskWatch } from "./schema.ts";
import type { TaskAssignee } from "@/shared/tasks.ts";

import type { TaskRecord, TaskStore } from "./tasks.ts";

// A task is always for someone: rows from before that was so are for whoever made them.
function whole(row: typeof threadTask.$inferSelect): TaskRecord {
  const { createdBy } = row;
  const creator: TaskAssignee =
    createdBy.kind === "user"
      ? { kind: "person", userId: createdBy.userId, name: createdBy.name }
      : { kind: "agent" };
  return { ...row, assignee: row.assignee ?? creator };
}

export function createTaskStore(db: Db): TaskStore {
  return {
    inThread(threadId, archived = false): TaskRecord[] {
      return db
        .select()
        .from(threadTask)
        .where(
          and(
            eq(threadTask.threadId, threadId),
            archived ? isNotNull(threadTask.archivedAt) : isNull(threadTask.archivedAt),
          ),
        )
        .orderBy(asc(threadTask.position), asc(threadTask.id))
        .all()
        .map(whole);
    },

    find(id) {
      const row = db.select().from(threadTask).where(eq(threadTask.id, id)).get();
      return row ? whole(row) : null;
    },

    add(rows) {
      if (rows.length === 0) return [];
      // Each goes after the list's last.
      const threadId = rows[0]!.threadId;
      const last =
        db
          .select({ last: max(threadTask.position) })
          .from(threadTask)
          .where(eq(threadTask.threadId, threadId))
          .get()?.last ?? -1;
      return db
        .insert(threadTask)
        .values(rows.map((row, index) => ({ ...row, position: last + 1 + index })))
        .returning()
        .all()
        .map(whole);
    },

    update(id, fields) {
      const row = db.update(threadTask).set(fields).where(eq(threadTask.id, id)).returning().get();
      return row && whole(row);
    },

    remove(ids) {
      if (ids.length === 0) return;
      db.delete(threadTask).where(inArray(threadTask.id, ids)).run();
    },

    addWatch(watch) {
      db.insert(threadTaskWatch).values(watch).run();
    },

    watchesIn(ownerId) {
      return db.select().from(threadTaskWatch).where(eq(threadTaskWatch.ownerId, ownerId)).all();
    },

    watchCount(threadId) {
      return (
        db
          .select({ total: count() })
          .from(threadTaskWatch)
          .where(eq(threadTaskWatch.threadId, threadId))
          .get()?.total ?? 0
      );
    },

    endWatch(id) {
      db.delete(threadTaskWatch).where(eq(threadTaskWatch.id, id)).run();
    },

    userName(userId) {
      return (
        db.select({ name: user.name }).from(user).where(eq(user.id, userId)).get()?.name ?? null
      );
    },
  };
}

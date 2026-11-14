import { and, asc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";

import { taskShare, threadTask } from "./schema.ts";
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
    async sharedWith(threadId) {
      return (
        (
          await db
            .select({ owner: taskShare.ownerThreadId })
            .from(taskShare)
            .where(eq(taskShare.threadId, threadId))
            .limit(1)
        )[0]?.owner ?? null
      );
    },

    async share(threadId, ownerThreadId) {
      await db.insert(taskShare).values({ threadId, ownerThreadId }).onConflictDoNothing();
    },

    async inThread(threadId, archived = false): Promise<TaskRecord[]> {
      return (
        await db
          .select()
          .from(threadTask)
          .where(
            and(
              eq(threadTask.threadId, threadId),
              archived ? isNotNull(threadTask.archivedAt) : isNull(threadTask.archivedAt),
            ),
          )
          .orderBy(asc(threadTask.position), asc(threadTask.id))
      ).map(whole);
    },

    async find(id) {
      const row = (await db.select().from(threadTask).where(eq(threadTask.id, id)).limit(1))[0];
      return row ? whole(row) : null;
    },

    async add(rows) {
      if (rows.length === 0) return [];
      // Each goes after the list's last.
      const threadId = rows[0]!.threadId;
      const last =
        (
          await db
            .select({ last: max(threadTask.position) })
            .from(threadTask)
            .where(eq(threadTask.threadId, threadId))
            .limit(1)
        )[0]?.last ?? -1;
      return (
        await db
          .insert(threadTask)
          .values(rows.map((row, index) => ({ ...row, position: last + 1 + index })))
          .returning()
      ).map(whole);
    },

    async update(id, fields) {
      const row = (
        await db.update(threadTask).set(fields).where(eq(threadTask.id, id)).returning()
      )[0];
      return row && whole(row);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await db.delete(threadTask).where(inArray(threadTask.id, ids));
    },

    async userName(userId) {
      return (
        (await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0]
          ?.name ?? null
      );
    },
  };
}

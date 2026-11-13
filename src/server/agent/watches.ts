// Watches: an agent waiting to be told once about tasks or subagents. Both kinds are stored alike,
// with the subjects they wait on, share one limit, and end as they fire; each kind says when its
// own fire. Ending is one conditional delete, so a watch fires once whoever checks it.

import { and, count, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import { threadWatch, threadWatchSubject } from "./schema.ts";

export type WatchKind = "tasks" | "subagents";

export interface Watch {
  id: string;
  // The thread whose agent waits, and the thread whose tasks or subagents it waits on.
  threadId: string;
  ownerId: string;
  kind: WatchKind;
  until: "done" | "changed" | "all_idle" | "any_idle";
  // The call that set it.
  callId: string | null;
  subjects: string[];
}

// How many watches a thread has at once.
export const WATCH_LIMIT = 10;

export type WatchStore = ReturnType<typeof createWatchStore>;

export function createWatchStore(db: Db) {
  // The watches found, each with its subjects, oldest first.
  function withSubjects(rows: (typeof threadWatch.$inferSelect)[]): Watch[] {
    if (rows.length === 0) return [];
    const subjects = db
      .select()
      .from(threadWatchSubject)
      .where(
        inArray(
          threadWatchSubject.watchId,
          rows.map((row) => row.id),
        ),
      )
      .all();
    return rows.map(({ createdAt: _at, ...row }) => ({
      ...row,
      subjects: subjects.filter((one) => one.watchId === row.id).map((one) => one.subjectId),
    }));
  }

  return {
    add(watch: Watch) {
      db.transaction(() => {
        const { subjects, ...row } = watch;
        db.insert(threadWatch).values(row).run();
        db.insert(threadWatchSubject)
          .values(subjects.map((subjectId) => ({ watchId: watch.id, subjectId })))
          .run();
      });
    },

    // The watches on the owner's tasks or subagents.
    on(ownerId: string, kind: WatchKind): Watch[] {
      return withSubjects(
        db
          .select()
          .from(threadWatch)
          .where(and(eq(threadWatch.ownerId, ownerId), eq(threadWatch.kind, kind)))
          .orderBy(threadWatch.createdAt, threadWatch.id)
          .all(),
      );
    },

    // The watches the thread's agent set of the kind.
    setIn(threadId: string, kind: WatchKind): Watch[] {
      return withSubjects(
        db
          .select()
          .from(threadWatch)
          .where(and(eq(threadWatch.threadId, threadId), eq(threadWatch.kind, kind)))
          .orderBy(threadWatch.createdAt, threadWatch.id)
          .all(),
      );
    },

    // How many watches the thread's agent has, of either kind.
    count(threadId: string) {
      return (
        db
          .select({ total: count() })
          .from(threadWatch)
          .where(eq(threadWatch.threadId, threadId))
          .get()?.total ?? 0
      );
    },

    // Ends the watch; false when it had ended already.
    end(id: string) {
      return db.delete(threadWatch).where(eq(threadWatch.id, id)).run().changes > 0;
    },
  };
}

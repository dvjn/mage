// Watches: an agent waiting to be told once about tasks or subagents. Both kinds are stored alike,
// with the subjects they wait on, share one limit, and end as they fire; each kind says when its
// own fire. Ending is one conditional delete, so a watch fires once whoever checks it.

import { and, count, eq, inArray, sql } from "drizzle-orm";

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
  async function withSubjects(rows: (typeof threadWatch.$inferSelect)[]): Promise<Watch[]> {
    if (rows.length === 0) return [];
    const subjects = await db
      .select()
      .from(threadWatchSubject)
      .where(
        inArray(
          threadWatchSubject.watchId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map(({ createdAt: _at, ...row }) => ({
      ...row,
      subjects: subjects.filter((one) => one.watchId === row.id).map((one) => one.subjectId),
    }));
  }

  return {
    async add(watch: Watch) {
      await db.transaction(async () => {
        const { subjects, ...row } = watch;
        await db.insert(threadWatch).values(row);
        await db
          .insert(threadWatchSubject)
          .values(subjects.map((subjectId) => ({ watchId: watch.id, subjectId })));
      });
    },

    // The watches on the owner's tasks or subagents.
    async on(ownerId: string, kind: WatchKind): Promise<Watch[]> {
      return withSubjects(
        await db
          .select()
          .from(threadWatch)
          .where(and(eq(threadWatch.ownerId, ownerId), eq(threadWatch.kind, kind)))
          .orderBy(threadWatch.createdAt, threadWatch.id),
      );
    },

    // The open watches on subagents that their subjects' state can satisfy now, oldest first: one
    // with a subject that is idle, and for all_idle none that is not. A subject is idle once
    // archived, or with no run under way and nothing waiting to start one on its current branch;
    // one that is no subagent counts as neither.
    async due(kind: "subagents"): Promise<Watch[]> {
      const busy = (subject: ReturnType<typeof sql>) => sql`(
        a.archived_at is null and (
          exists (select 1 from run r join thread t on t.id = r.thread_id
                   where r.thread_id = ${subject} and r.branch_id = t.current_branch_id
                     and r.status in ('queued', 'running', 'waiting'))
          or exists (select 1 from thread_input i join thread t on t.id = i.thread_id
                      where i.thread_id = ${subject} and i.branch_id = t.current_branch_id
                        and i.status = 'waiting' and (i.kind = 'message' or i.wake))))`;
      const subjects = (idle: boolean) => sql`exists (
        select 1 from thread_watch_subject s join subagent a on a.thread_id = s.subject_id
         where s.watch_id = ${threadWatch.id} and ${idle ? sql`not` : sql``} ${busy(sql`s.subject_id`)})`;
      return withSubjects(
        await db
          .select()
          .from(threadWatch)
          .where(
            and(
              eq(threadWatch.kind, kind),
              subjects(true),
              sql`(${threadWatch.until} <> 'all_idle' or not ${subjects(false)})`,
            ),
          )
          .orderBy(threadWatch.createdAt, threadWatch.id),
      );
    },

    // Every open watch of the kind, oldest first.
    async open(kind: WatchKind): Promise<Watch[]> {
      return withSubjects(
        await db
          .select()
          .from(threadWatch)
          .where(eq(threadWatch.kind, kind))
          .orderBy(threadWatch.createdAt, threadWatch.id),
      );
    },

    // The watches the thread's agent set of the kind.
    async setIn(threadId: string, kind: WatchKind): Promise<Watch[]> {
      return withSubjects(
        await db
          .select()
          .from(threadWatch)
          .where(and(eq(threadWatch.threadId, threadId), eq(threadWatch.kind, kind)))
          .orderBy(threadWatch.createdAt, threadWatch.id),
      );
    },

    // How many watches the thread's agent has, of either kind.
    async count(threadId: string) {
      return (
        (
          await db
            .select({ total: count() })
            .from(threadWatch)
            .where(eq(threadWatch.threadId, threadId))
            .limit(1)
        )[0]?.total ?? 0
      );
    },

    // Ends the watch; false when it had ended already.
    async end(id: string) {
      const ended = await db
        .delete(threadWatch)
        .where(eq(threadWatch.id, id))
        .returning({ id: threadWatch.id });
      return ended.length > 0;
    },
  };
}

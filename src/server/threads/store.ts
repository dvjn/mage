import { and, asc, desc, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import { type Db, writeLock } from "@/server/db/db.ts";
import { orgFormerMember, user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { spokenText } from "@/shared/plain-text.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import { kept, listedThread, newestFirst, statused, type StatusedRow, windowOf } from "./lists.ts";
import { thread, threadBranch, threadBranchSource, threadEvent } from "./schema.ts";
import type {
  Branch,
  StoredEvent,
  Thread,
  ThreadFacts,
  ThreadStore,
  ThreadWriters,
} from "./service.ts";

// The events a reader is told about: a person's message, a finished reply and a failed run.
const NOTABLE = ["message", "message.completed", "run.failed"];

// Whether the event `threadEvent` is one of the branch's.
function ofBranch(branchId: SQL | string) {
  return sql`exists (select 1 from ${threadBranchSource} s
                      where s.branch_id = ${branchId}
                        and s.source_branch_id = ${threadEvent.branchId}
                        and (s.until_seq is null or ${threadEvent.seq} <= s.until_seq))`;
}

// Whether the event `threadEvent` is one of its thread's current branch.
const ofCurrent = ofBranch(
  sql`(select t.current_branch_id from ${thread} t where t.id = ${threadEvent.threadId})`,
);

const branchColumns = {
  id: threadBranch.id,
  threadId: threadBranch.threadId,
  parentBranchId: threadBranch.parentBranchId,
  forkSeq: threadBranch.forkSeq,
  kind: threadBranch.kind,
  rowId: threadBranch.rowId,
  groupRowId: threadBranch.groupRowId,
  createdBy: threadBranch.createdBy,
  createdByName: user.name,
  createdAt: threadBranch.createdAt,
};

const columns = {
  id: thread.id,
  spaceId: thread.spaceId,
  title: thread.title,
  titleSource: thread.titleSource,
  model: thread.model,
  effort: thread.effort,
  createdBy: thread.createdBy,
  parentThreadId: thread.parentThreadId,
  rootThreadId: thread.rootThreadId,
  currentBranchId: sql<string>`coalesce(${thread.currentBranchId}, ${thread.id})`,
  lastEventSeq: thread.lastEventSeq,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
};

export function createThreadStore(db: Db): ThreadStore {
  function branchOf(id: string) {
    return (
      (db
        .select(branchColumns)
        .from(threadBranch)
        .leftJoin(user, eq(user.id, threadBranch.createdBy))
        .where(eq(threadBranch.id, id))
        .get() as Branch | undefined) ?? null
    );
  }

  function eventsWhere(
    where: SQL | undefined,
    order: "asc" | "desc" = "asc",
    limit?: number,
  ): StoredEvent[] {
    return db
      .select({
        id: threadEvent.id,
        threadId: threadEvent.threadId,
        branchId: sql<string>`coalesce(${threadEvent.branchId}, ${threadEvent.threadId})`,
        seq: threadEvent.seq,
        type: threadEvent.type,
        actorKind: threadEvent.actorKind,
        actorUserId: threadEvent.actorUserId,
        actorName: user.name,
        actorRemovedAt: orgFormerMember.removedAt,
        data: threadEvent.data,
        createdAt: threadEvent.createdAt,
      })
      .from(threadEvent)
      .leftJoin(user, eq(user.id, threadEvent.actorUserId))
      .innerJoin(thread, eq(thread.id, threadEvent.threadId))
      .innerJoin(space, eq(space.id, thread.spaceId))
      .leftJoin(
        orgFormerMember,
        and(
          eq(orgFormerMember.organizationId, space.organizationId),
          eq(orgFormerMember.userId, threadEvent.actorUserId),
        ),
      )
      .where(where)
      .orderBy(order === "asc" ? asc(threadEvent.seq) : desc(threadEvent.seq))
      .limit(limit ?? -1)
      .all()
      .map(
        ({ actorKind, actorUserId, actorName, actorRemovedAt, type, data, ...rest }) =>
          ({
            ...rest,
            type,
            data,
            actor:
              actorKind === "user" && actorUserId
                ? { kind: "user", userId: actorUserId }
                : { kind: "agent" },
            actorName: actorName ?? null,
            actorFormer: actorRemovedAt !== null,
          }) as StoredEvent,
      );
  }

  return {
    // Its root branch takes its id.
    create(input) {
      const id = ulid();
      return db.transaction(() => {
        const created = db
          .insert(thread)
          .values({ id, ...input, currentBranchId: id })
          .returning(columns)
          .get();
        db.insert(threadBranch)
          .values({ id, threadId: id, kind: "root", createdBy: input.createdBy })
          .run();
        db.insert(threadBranchSource).values({ branchId: id, sourceBranchId: id }).run();
        return created;
      }, writeLock);
    },

    branches(threadId) {
      return db
        .select(branchColumns)
        .from(threadBranch)
        .leftJoin(user, eq(user.id, threadBranch.createdBy))
        .where(eq(threadBranch.threadId, threadId))
        .orderBy(asc(threadBranch.createdAt), asc(threadBranch.id))
        .all() as Branch[];
    },

    branch: branchOf,

    eventAt(threadId, seq) {
      const [event] = eventsWhere(
        and(eq(threadEvent.threadId, threadId), eq(threadEvent.seq, seq)),
      );
      return event ?? null;
    },

    sources(branchId) {
      return db
        .select({
          branchId: threadBranchSource.sourceBranchId,
          untilSeq: threadBranchSource.untilSeq,
        })
        .from(threadBranchSource)
        .where(eq(threadBranchSource.branchId, branchId))
        .all();
    },

    // Takes its parent's sources, each up to the fork at most, then its own events.
    addBranch(input) {
      const id = ulid();
      db.transaction(() => {
        db.insert(threadBranch)
          .values({ id, ...input })
          .run();
        const inherited = db
          .select()
          .from(threadBranchSource)
          .where(eq(threadBranchSource.branchId, input.parentBranchId))
          .all();
        db.insert(threadBranchSource)
          .values([
            ...inherited.map((source) => ({
              branchId: id,
              sourceBranchId: source.sourceBranchId,
              untilSeq:
                source.untilSeq === null ? input.forkSeq : Math.min(source.untilSeq, input.forkSeq),
            })),
            { branchId: id, sourceBranchId: id },
          ])
          .run();
      }, writeLock);
      return branchOf(id)!;
    },

    // What lists say of its newest message follows the branch.
    setCurrent(threadId, branchId) {
      const [last] = eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          inArray(threadEvent.type, ["message", "message.completed"]),
          ofBranch(branchId),
        ),
        "desc",
        1,
      );
      const parts = (last?.data as { parts?: Parameters<typeof spokenText>[0] } | undefined)?.parts;
      return db
        .update(thread)
        .set({
          currentBranchId: branchId,
          lastMessageText: parts ? spokenText(parts) : null,
          updatedAt: new Date(),
        })
        .where(eq(thread.id, threadId))
        .returning(columns)
        .get() as Thread;
    },

    find(id): Thread | null {
      return db.select(columns).from(thread).where(eq(thread.id, id)).get() ?? null;
    },

    listInSpace(spaceId) {
      return db
        .select(columns)
        .from(thread)
        .where(and(eq(thread.spaceId, spaceId), isNull(thread.parentThreadId)))
        .orderBy(desc(thread.updatedAt), desc(thread.id))
        .all();
    },

    facts(threadIds) {
      const facts = new Map<string, ThreadFacts>();
      if (threadIds.length === 0) return facts;
      const kinds = sql.join(
        NOTABLE.map((kind) => sql`${kind}`),
        sql`, `,
      );
      const latest = db
        .select({
          threadId: threadEvent.threadId,
          notable: sql<
            number | null
          >`max(case when ${threadEvent.type} in (${kinds}) then ${threadEvent.seq} end)`.as(
            "notable",
          ),
          failed: sql<
            number | null
          >`max(case when ${threadEvent.type} = 'run.failed' then ${threadEvent.seq} end)`.as(
            "failed",
          ),
          created: sql<
            number | null
          >`max(case when ${threadEvent.type} = 'run.created' then ${threadEvent.seq} end)`.as(
            "created",
          ),
        })
        .from(threadEvent)
        .where(and(inArray(threadEvent.threadId, threadIds), ofCurrent))
        .groupBy(threadEvent.threadId)
        .as("latest");
      const notableEvent = alias(threadEvent, "notable_event");
      const failedEvent = alias(threadEvent, "failed_event");
      const rows = db
        .select({
          threadId: latest.threadId,
          notable: latest.notable,
          notableBy: notableEvent.actorUserId,
          failed: latest.failed,
          created: latest.created,
          failure: failedEvent.data,
        })
        .from(latest)
        .leftJoin(
          notableEvent,
          and(eq(notableEvent.threadId, latest.threadId), eq(notableEvent.seq, latest.notable)),
        )
        .leftJoin(
          failedEvent,
          and(eq(failedEvent.threadId, latest.threadId), eq(failedEvent.seq, latest.failed)),
        )
        .all();
      for (const row of rows) {
        const failedLast = row.failed !== null && row.failed > (row.created ?? 0);
        facts.set(row.threadId, {
          notable: row.notable === null ? null : { seq: row.notable, by: row.notableBy },
          failed: failedLast
            ? { seq: row.failed!, error: (row.failure as { error?: string } | null)?.error ?? "" }
            : null,
        });
      }
      return facts;
    },

    writers(threadIds) {
      const writers = new Map<string, ThreadWriters>();
      if (threadIds.length === 0) return writers;
      const last = sql<number>`max(${threadEvent.seq})`;
      const rows = db
        .select({
          threadId: threadEvent.threadId,
          userId: threadEvent.actorUserId,
          name: user.name,
          removedAt: orgFormerMember.removedAt,
          last,
          // Taken from the row with the latest seq, as SQLite does for a bare column beside max().
          guest: sql<number | null>`json_extract(${threadEvent.data}, '$.guest')`,
        })
        .from(threadEvent)
        .leftJoin(user, eq(user.id, threadEvent.actorUserId))
        .innerJoin(thread, eq(thread.id, threadEvent.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .leftJoin(
          orgFormerMember,
          and(
            eq(orgFormerMember.organizationId, space.organizationId),
            eq(orgFormerMember.userId, threadEvent.actorUserId),
          ),
        )
        .where(
          and(
            inArray(threadEvent.threadId, threadIds),
            eq(threadEvent.type, "message"),
            eq(threadEvent.actorKind, "user"),
            ofCurrent,
          ),
        )
        .groupBy(threadEvent.threadId, threadEvent.actorUserId)
        .orderBy(desc(last))
        .all();
      for (const { threadId, userId, name, removedAt, guest } of rows) {
        if (!userId) continue;
        writers.set(threadId, [
          ...(writers.get(threadId) ?? []),
          { userId, name, former: removedAt !== null, guest: !!guest },
        ]);
      }
      return writers;
    },

    listed(reader, spaceId, filter, window) {
      const where = sql`t.space_id = ${spaceId} and t.parent_thread_id is null`;
      const listed = statused(reader, { from: sql`from thread t`, where });
      const keep = kept(filter, sql`coalesce(title, ${UNTITLED})`, sql`last_message_text`);
      const rows = db.all<StatusedRow>(
        sql`${listed} select * from statused where ${keep} ${newestFirst} ${windowOf(window)}`,
      );
      const total = window
        ? (db.get<{ n: number }>(sql`${listed} select count(*) as n from statused where ${keep}`)
            ?.n ?? 0)
        : rows.length;
      return { rows: rows.map(listedThread), total };
    },

    sidebar(reader, spaceId, limit) {
      const listed = statused(reader, {
        from: sql`from thread t`,
        where: sql`t.space_id = ${spaceId} and t.parent_thread_id is null`,
      });
      const rows = db.all<StatusedRow>(sql`${listed},
        placed as (
          select *,
                 row_number() over (${newestFirst}) as in_space,
                 row_number() over (partition by status ${newestFirst}) as in_status
            from statused
        )
        select * from placed
         where in_space <= ${limit}
            or (status <> 'read' and in_status = 1)
            or run_status = 'waiting'
            or subagent_waiting
            or (status = 'failed' and in_status <= ${limit})
         ${newestFirst}`);
      const total = db.get<{ n: number }>(
        sql`select count(*) as n from thread where space_id = ${spaceId} and parent_thread_id is null`,
      );
      const failed = db.get<{ n: number }>(
        sql`${listed} select count(*) as n from statused where status = 'failed'`,
      );
      return {
        rows: rows.map(listedThread),
        total: total?.n ?? 0,
        failed: failed?.n ?? 0,
      };
    },

    anyInSpace(spaceId) {
      return !!db.select({ id: thread.id }).from(thread).where(eq(thread.spaceId, spaceId)).get();
    },

    search(spaceIds, text, limit, untitled) {
      if (spaceIds.length === 0) return [];
      // The text's own % and _ match only themselves.
      const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      return db
        .select(columns)
        .from(thread)
        .where(
          and(
            inArray(thread.spaceId, spaceIds),
            isNull(thread.parentThreadId),
            sql`lower(coalesce(${thread.title}, ${untitled})) like lower(${pattern}) escape '\\'`,
          ),
        )
        .orderBy(desc(thread.updatedAt), desc(thread.id))
        .limit(limit)
        .all();
    },

    update(id, changes) {
      return db
        .update(thread)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(thread.id, id))
        .returning(columns)
        .get() as Thread;
    },

    delete(id) {
      db.delete(thread)
        .where(or(eq(thread.id, id), eq(thread.rootThreadId, id)))
        .run();
    },

    children(id) {
      return db
        .select(columns)
        .from(thread)
        .where(eq(thread.rootThreadId, id))
        .orderBy(asc(thread.createdAt), asc(thread.id))
        .all();
    },

    // Into the branch, the current one when none is named; what lists say of the thread's newest
    // message follows its current branch alone.
    append(threadId, event, title, branchId) {
      const id = ulid();
      db.transaction((tx) => {
        const current = sql`coalesce(${thread.currentBranchId}, ${thread.id})`;
        const branch = branchId ?? current;
        const next = tx
          .update(thread)
          .set({
            lastEventSeq: sql`${thread.lastEventSeq} + 1`,
            updatedAt: new Date(),
            ...(title !== undefined && {
              title: sql`coalesce(${thread.title}, ${title})`,
              titleSource: sql`coalesce(${thread.titleSource}, 'message')`,
            }),
            ...((event.type === "message" || event.type === "message.completed") && {
              lastMessageText: sql`case when ${branch} = ${current}
                                        then ${spokenText(event.data.parts)}
                                        else ${thread.lastMessageText} end`,
            }),
          })
          .where(eq(thread.id, threadId))
          .returning({ seq: thread.lastEventSeq, branchId: sql<string>`${branch}` })
          .get();
        if (!next) throw new Error(`thread ${threadId} not found`);
        tx.insert(threadEvent)
          .values({
            id,
            threadId,
            branchId: next.branchId,
            seq: next.seq,
            type: event.type,
            actorKind: event.actor.kind,
            actorUserId: event.actor.kind === "user" ? event.actor.userId : null,
            data: event.data,
            ...(event.createdAt && { createdAt: event.createdAt }),
          })
          .run();
      }, writeLock);
      const [stored] = eventsWhere(eq(threadEvent.id, id));
      if (!stored) throw new Error(`event ${id} not found after append`);
      return stored;
    },

    // The branch's, the current one's when none is named.
    eventsAfter(threadId, after, branchId) {
      return eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          gt(threadEvent.seq, after),
          branchId ? ofBranch(branchId) : ofCurrent,
        ),
      );
    },
  };
}

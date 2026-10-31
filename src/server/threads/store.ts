import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import { type Db, writeLock } from "@/server/db/db.ts";
import { orgFormerMember, user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { spokenText } from "@/shared/plain-text.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import { kept, listedThread, newestFirst, statused, type StatusedRow, windowOf } from "./lists.ts";
import { thread, threadEvent } from "./schema.ts";
import type { StoredEvent, Thread, ThreadFacts, ThreadStore, ThreadWriters } from "./service.ts";

// The events a reader is told about: a person's message, a finished reply and a failed run.
const NOTABLE = ["message", "message.completed", "run.failed"];

const columns = {
  id: thread.id,
  spaceId: thread.spaceId,
  folderId: thread.folderId,
  title: thread.title,
  titleSource: thread.titleSource,
  model: thread.model,
  effort: thread.effort,
  createdBy: thread.createdBy,
  parentThreadId: thread.parentThreadId,
  rootThreadId: thread.rootThreadId,
  lastEventSeq: thread.lastEventSeq,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
};

export function createThreadStore(db: Db): ThreadStore {
  function eventsWhere(where: SQL | undefined): StoredEvent[] {
    return db
      .select({
        id: threadEvent.id,
        threadId: threadEvent.threadId,
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
      .orderBy(asc(threadEvent.seq))
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
    create(input) {
      return db
        .insert(thread)
        .values({ id: ulid(), ...input })
        .returning(columns)
        .get();
    },

    find(id): Thread | null {
      return db.select(columns).from(thread).where(eq(thread.id, id)).get() ?? null;
    },

    listInSpace(spaceId) {
      return db
        .select(columns)
        .from(thread)
        .where(eq(thread.spaceId, spaceId))
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
        .where(inArray(threadEvent.threadId, threadIds))
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
          last,
          // Taken from the row with the latest seq, as SQLite does for a bare column beside max().
          guest: sql<number | null>`json_extract(${threadEvent.data}, '$.guest')`,
        })
        .from(threadEvent)
        .leftJoin(user, eq(user.id, threadEvent.actorUserId))
        .where(
          and(
            inArray(threadEvent.threadId, threadIds),
            eq(threadEvent.type, "message"),
            eq(threadEvent.actorKind, "user"),
          ),
        )
        .groupBy(threadEvent.threadId, threadEvent.actorUserId)
        .orderBy(desc(last))
        .all();
      for (const { threadId, userId, name, guest } of rows) {
        if (!userId) continue;
        writers.set(threadId, [...(writers.get(threadId) ?? []), { userId, name, guest: !!guest }]);
      }
      return writers;
    },

    listed(reader, spaceId, filter, window) {
      const where = sql`t.space_id = ${spaceId}
        ${filter.folderId ? sql`and t.folder_id = ${filter.folderId}` : sql``}`;
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
        where: sql`t.space_id = ${spaceId}`,
      });
      const rows = db.all<StatusedRow>(sql`${listed},
        placed as (
          select *,
                 row_number() over (partition by folder_id ${newestFirst}) as in_folder,
                 row_number() over (partition by folder_id, status ${newestFirst}) as in_status,
                 row_number() over (partition by status ${newestFirst}) as in_space
            from statused
        )
        select * from placed
         where in_folder <= ${limit}
            or (status <> 'read' and in_status = 1)
            or run_status = 'waiting'
            or (status = 'failed' and in_space <= ${limit})
         ${newestFirst}`);
      const counts = db.all<{ folderId: string | null; n: number }>(sql`
        select folder_id as folderId, count(*) as n from thread
         where space_id = ${spaceId} group by folder_id`);
      const failed = db.get<{ n: number }>(
        sql`${listed} select count(*) as n from statused where status = 'failed'`,
      );
      return {
        rows: rows.map(listedThread),
        counts: new Map(counts.map((row) => [row.folderId, row.n])),
        failed: failed?.n ?? 0,
      };
    },

    anyInSpace(spaceId) {
      return !!db.select({ id: thread.id }).from(thread).where(eq(thread.spaceId, spaceId)).get();
    },

    search(spaceIds, text, limit, untitled, folderId) {
      if (spaceIds.length === 0) return [];
      // The text's own % and _ match only themselves.
      const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      return db
        .select(columns)
        .from(thread)
        .where(
          and(
            inArray(thread.spaceId, spaceIds),
            folderId ? eq(thread.folderId, folderId) : undefined,
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
      db.delete(thread).where(eq(thread.id, id)).run();
    },

    append(threadId, event, title) {
      const id = ulid();
      db.transaction((tx) => {
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
              lastMessageText: spokenText(event.data.parts),
            }),
          })
          .where(eq(thread.id, threadId))
          .returning({ seq: thread.lastEventSeq })
          .get();
        if (!next) throw new Error(`thread ${threadId} not found`);
        tx.insert(threadEvent)
          .values({
            id,
            threadId,
            seq: next.seq,
            type: event.type,
            actorKind: event.actor.kind,
            actorUserId: event.actor.kind === "user" ? event.actor.userId : null,
            data: event.data,
          })
          .run();
      }, writeLock);
      const [stored] = eventsWhere(eq(threadEvent.id, id));
      if (!stored) throw new Error(`event ${id} not found after append`);
      return stored;
    },

    eventsAfter(threadId, after) {
      return eventsWhere(and(eq(threadEvent.threadId, threadId), gt(threadEvent.seq, after)));
    },
  };
}

// Threads and their events kept in the thread and thread_event tables, with ULID ids, and what each
// thread's log says its readers have not seen yet.

import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import type {
  StoredEvent,
  Thread,
  ThreadFacts,
  ThreadStore,
  ThreadWriters,
} from "@/ports/threads.ts";

import { type Db, writeLock } from "./db.ts";
import { orgFormerMember, space, thread, threadEvent, user } from "./schema.ts";

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

  // The newest message or reply in each thread matching `where` that has one.
  function lastMessages(where: SQL) {
    const kinds = ["message", "message.completed"];
    const latest = db
      .select({
        threadId: threadEvent.threadId,
        lastSeq: sql<number>`max(${threadEvent.seq})`.as("last_seq"),
      })
      .from(threadEvent)
      .innerJoin(thread, eq(thread.id, threadEvent.threadId))
      .where(and(where, inArray(threadEvent.type, kinds)))
      .groupBy(threadEvent.threadId)
      .as("latest");
    const ids = db
      .select({ id: threadEvent.id })
      .from(threadEvent)
      .innerJoin(
        latest,
        and(eq(latest.threadId, threadEvent.threadId), eq(latest.lastSeq, threadEvent.seq)),
      )
      .all()
      .map((row) => row.id);
    return ids.length === 0 ? [] : eventsWhere(inArray(threadEvent.id, ids));
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

    lastMessagesInSpace(spaceId) {
      return lastMessages(eq(thread.spaceId, spaceId));
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
      for (const { threadId, userId, name } of rows) {
        if (!userId) continue;
        writers.set(threadId, [...(writers.get(threadId) ?? []), { userId, name }]);
      }
      return writers;
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

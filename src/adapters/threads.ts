// Threads and their events kept in the thread and thread_event tables, with ULID ids.

import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { StoredEvent, Thread, ThreadStore } from "@/ports/threads.ts";

import { type Db, writeLock } from "./db.ts";
import { orgFormerMember, space, thread, threadEvent, user } from "./schema.ts";

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

    lastMessagesInSpace(spaceId) {
      const kinds = ["message", "message.completed"];
      const latest = db
        .select({
          threadId: threadEvent.threadId,
          lastSeq: sql<number>`max(${threadEvent.seq})`.as("last_seq"),
        })
        .from(threadEvent)
        .innerJoin(thread, eq(thread.id, threadEvent.threadId))
        .where(and(eq(thread.spaceId, spaceId), inArray(threadEvent.type, kinds)))
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

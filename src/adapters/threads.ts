// Threads and their events kept in the thread and thread_event tables, with ULID ids.

import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { StoredEvent, Thread, ThreadStore } from "@/ports/threads.ts";

import type { Db } from "./db.ts";
import { thread, threadEvent, user } from "./schema.ts";

const columns = {
  id: thread.id,
  spaceId: thread.spaceId,
  folderId: thread.folderId,
  title: thread.title,
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
        data: threadEvent.data,
        createdAt: threadEvent.createdAt,
      })
      .from(threadEvent)
      .leftJoin(user, eq(user.id, threadEvent.actorUserId))
      .where(where)
      .orderBy(asc(threadEvent.seq))
      .all()
      .map(
        ({ actorKind, actorUserId, actorName, type, data, ...rest }) =>
          ({
            ...rest,
            type,
            data,
            actor:
              actorKind === "user" && actorUserId
                ? { kind: "user", userId: actorUserId }
                : { kind: "agent" },
            actorName: actorName ?? null,
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

    anyInSpace(spaceId) {
      return !!db.select({ id: thread.id }).from(thread).where(eq(thread.spaceId, spaceId)).get();
    },

    search(spaceIds, text, limit) {
      if (spaceIds.length === 0) return [];
      // The text's own % and _ match only themselves.
      const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      return db
        .select(columns)
        .from(thread)
        .where(
          and(
            inArray(thread.spaceId, spaceIds),
            sql`lower(${thread.title}) like lower(${pattern}) escape '\\'`,
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
            ...(title !== undefined && { title: sql`coalesce(${thread.title}, ${title})` }),
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
      });
      const [stored] = eventsWhere(eq(threadEvent.id, id));
      if (!stored) throw new Error(`event ${id} not found after append`);
      return stored;
    },

    eventsAfter(threadId, after) {
      return eventsWhere(and(eq(threadEvent.threadId, threadId), gt(threadEvent.seq, after)));
    },
  };
}

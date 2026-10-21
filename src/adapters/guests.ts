// Thread guests and their invite links kept in the thread_guest and thread_invite tables, with ULID
// ids for links.

import { alias } from "drizzle-orm/sqlite-core";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { GuestStore, ThreadGuest, ThreadInvite } from "@/ports/guests.ts";

import type { Db } from "./db.ts";
import { organization, space, thread, threadGuest, threadInvite, user } from "./schema.ts";

const guestColumns = {
  threadId: threadGuest.threadId,
  userId: threadGuest.userId,
  invitedBy: threadGuest.invitedBy,
  createdAt: threadGuest.createdAt,
  accessUntil: threadGuest.accessUntil,
  revokedAt: threadGuest.revokedAt,
  revokedBy: threadGuest.revokedBy,
};

const inviteColumns = {
  id: threadInvite.id,
  threadId: threadInvite.threadId,
  createdBy: threadInvite.createdBy,
  createdAt: threadInvite.createdAt,
  linkExpiresAt: threadInvite.linkExpiresAt,
  accessFor: threadInvite.accessFor,
  acceptedBy: threadInvite.acceptedBy,
  acceptedAt: threadInvite.acceptedAt,
  revokedAt: threadInvite.revokedAt,
};

const threadColumns = {
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

// A guest row whose access has not ended at `now`.
function active(now: Date) {
  return and(
    isNull(threadGuest.revokedAt),
    or(isNull(threadGuest.accessUntil), gt(threadGuest.accessUntil, now)),
  );
}

export function createGuestStore(db: Db): GuestStore {
  return {
    find(threadId, userId): ThreadGuest | null {
      return (
        db
          .select(guestColumns)
          .from(threadGuest)
          .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)))
          .get() ?? null
      );
    },

    grant({ threadId, userId, invitedBy, accessUntil }) {
      const renewed = { invitedBy, accessUntil, revokedAt: null, revokedBy: null };
      return db
        .insert(threadGuest)
        .values({ threadId, userId, ...renewed })
        .onConflictDoUpdate({ target: [threadGuest.threadId, threadGuest.userId], set: renewed })
        .returning(guestColumns)
        .get();
    },

    revoke(threadId, userId, by, at) {
      db.update(threadGuest)
        .set({ revokedAt: at, revokedBy: by })
        .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)))
        .run();
    },

    activeIn(threadId, now) {
      const inviter = alias(user, "inviter");
      return (
        db
          .select({ ...guestColumns, name: user.name, invitedByName: inviter.name })
          .from(threadGuest)
          .innerJoin(user, eq(user.id, threadGuest.userId))
          .leftJoin(inviter, eq(inviter.id, threadGuest.invitedBy))
          .where(and(eq(threadGuest.threadId, threadId), active(now)))
          // Rows made in the same millisecond stay in the order they were made.
          .orderBy(asc(threadGuest.createdAt), sql`${threadGuest}.rowid`)
          .all()
      );
    },

    threadsOf(userId, now) {
      return db
        .select({
          thread: threadColumns,
          spaceName: space.name,
          orgName: organization.name,
          accessUntil: threadGuest.accessUntil,
        })
        .from(threadGuest)
        .innerJoin(thread, eq(thread.id, threadGuest.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .innerJoin(organization, eq(organization.id, space.organizationId))
        .where(and(eq(threadGuest.userId, userId), active(now)))
        .orderBy(desc(thread.updatedAt), desc(thread.id))
        .all();
    },

    createInvite(input) {
      return db
        .insert(threadInvite)
        .values({ id: ulid(), ...input })
        .returning(inviteColumns)
        .get();
    },

    findInvite(id): ThreadInvite | null {
      return (
        db.select(inviteColumns).from(threadInvite).where(eq(threadInvite.id, id)).get() ?? null
      );
    },

    findInviteByHash(tokenHash): ThreadInvite | null {
      return (
        db
          .select(inviteColumns)
          .from(threadInvite)
          .where(eq(threadInvite.tokenHash, tokenHash))
          .get() ?? null
      );
    },

    pendingInvites(threadId, now) {
      return (
        db
          .select(inviteColumns)
          .from(threadInvite)
          .where(
            and(
              eq(threadInvite.threadId, threadId),
              isNull(threadInvite.acceptedAt),
              isNull(threadInvite.revokedAt),
              gt(threadInvite.linkExpiresAt, now),
            ),
          )
          // Links made in the same millisecond stay in the order they were made.
          .orderBy(asc(threadInvite.createdAt), sql`${threadInvite}.rowid`)
          .all()
      );
    },

    markAccepted(id, userId, at) {
      const stamped = db
        .update(threadInvite)
        .set({ acceptedBy: userId, acceptedAt: at })
        .where(
          and(
            eq(threadInvite.id, id),
            isNull(threadInvite.acceptedAt),
            isNull(threadInvite.revokedAt),
          ),
        )
        .run();
      return stamped.changes === 1;
    },

    revokeInvite(id, at) {
      db.update(threadInvite).set({ revokedAt: at }).where(eq(threadInvite.id, id)).run();
    },
  };
}

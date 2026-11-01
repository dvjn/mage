import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";
import { organization, user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import {
  kept,
  listedThread,
  newestFirst,
  statused,
  type StatusedRow,
  windowOf,
} from "@/server/threads/lists.ts";
import { thread } from "@/server/threads/schema.ts";
import { FIRST_SPACE_NAME, spaceNameFor } from "@/shared/spaces.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import { threadGuest, threadInvite } from "./schema.ts";
import type { GuestStore, ThreadGuest, ThreadInvite } from "./service.ts";

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

// Whoever made a thread's space.
const creator = alias(user, "creator");

// What follows a person's name in the name of their own space.
const SPACE_SUFFIX = spaceNameFor({ name: FIRST_SPACE_NAME, kind: "personal", primary: true }, "");

// A shared thread's row of `statused`, with its space, org and access.
interface SharedRow extends StatusedRow {
  space_name: string;
  space_kind: "personal" | "shared";
  space_primary: number;
  owner_name: string | null;
  org_name: string;
  access_until: number | null;
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
          space: { name: space.name, kind: space.kind, primary: space.primary },
          ownerName: creator.name,
          orgName: organization.name,
          accessUntil: threadGuest.accessUntil,
        })
        .from(threadGuest)
        .innerJoin(thread, eq(thread.id, threadGuest.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .innerJoin(organization, eq(organization.id, space.organizationId))
        .leftJoin(creator, eq(creator.id, space.createdBy))
        .where(and(eq(threadGuest.userId, userId), active(now), isNull(space.trashedAt)))
        .orderBy(desc(thread.updatedAt), desc(thread.id))
        .all()
        .map(({ space: host, ownerName, ...row }) => {
          const spaceName = spaceNameFor(host, ownerName ?? row.orgName);
          return { ...row, spaceName, spaceNamedForOrg: spaceName !== host.name };
        });
    },

    sharedListed(userId, now, filter, window) {
      const listed = statused(userId, {
        from: sql`from thread_guest g
          join thread t on t.id = g.thread_id
          join space s on s.id = t.space_id
          join organization o on o.id = s.organization_id
          left join user c on c.id = s.created_by`,
        where: sql`g.user_id = ${userId} and g.revoked_at is null and s.trashed_at is null
          and (g.access_until is null or g.access_until > ${now.getTime()})`,
        // Where the thread is as its list says: a person's own space alone, any other with its org.
        columns: sql`, s.name as space_name, s.kind as space_kind, s.is_primary as space_primary,
          c.name as owner_name, o.name as org_name, g.access_until as access_until,
          case when s.kind = 'personal' and s.is_primary = 1
               then coalesce(c.name, o.name) || ${SPACE_SUFFIX}
               else s.name || ' · ' || o.name end as place`,
      });
      const keep = kept(filter, sql`coalesce(title, ${UNTITLED})`, sql`place`);
      const rows = db.all<SharedRow>(
        sql`${listed} select * from statused where ${keep} ${newestFirst} ${windowOf(window)}`,
      );
      const total = window
        ? (db.get<{ n: number }>(sql`${listed} select count(*) as n from statused where ${keep}`)
            ?.n ?? 0)
        : rows.length;
      return {
        rows: rows.map((row) => {
          const host = { name: row.space_name, kind: row.space_kind, primary: !!row.space_primary };
          const spaceName = spaceNameFor(host, row.owner_name ?? row.org_name);
          return {
            ...listedThread(row),
            spaceName,
            orgName: row.org_name,
            spaceNamedForOrg: spaceName !== host.name,
            accessUntil: row.access_until === null ? null : new Date(row.access_until),
          };
        }),
        total,
      };
    },

    hostSpaceName(threadId) {
      const row = db
        .select({
          name: space.name,
          kind: space.kind,
          primary: space.primary,
          ownerName: creator.name,
          orgName: organization.name,
        })
        .from(thread)
        .innerJoin(space, eq(space.id, thread.spaceId))
        .innerJoin(organization, eq(organization.id, space.organizationId))
        .leftJoin(creator, eq(creator.id, space.createdBy))
        .where(eq(thread.id, threadId))
        .get();
      return row ? spaceNameFor(row, row.ownerName ?? row.orgName) : null;
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

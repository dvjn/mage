import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";
import { organization, scimGroup, user } from "@/server/orgs/schema.ts";
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
import type { ThreadRole } from "@/shared/guests.ts";
import { FIRST_SPACE_NAME, spaceNameFor } from "@/shared/spaces.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import { threadGroupGuest, threadGuest, threadInvite } from "./schema.ts";
import type { GuestStore, ThreadGroupGuest, ThreadGuest, ThreadInvite } from "./service.ts";

const guestColumns = {
  threadId: threadGuest.threadId,
  userId: threadGuest.userId,
  invitedBy: threadGuest.invitedBy,
  role: threadGuest.role,
  createdAt: threadGuest.createdAt,
  accessUntil: threadGuest.accessUntil,
  revokedAt: threadGuest.revokedAt,
  revokedBy: threadGuest.revokedBy,
};

const groupColumns = {
  threadId: threadGroupGuest.threadId,
  groupId: threadGroupGuest.groupId,
  invitedBy: threadGroupGuest.invitedBy,
  role: threadGroupGuest.role,
  createdAt: threadGroupGuest.createdAt,
  accessUntil: threadGroupGuest.accessUntil,
  revokedAt: threadGroupGuest.revokedAt,
  revokedBy: threadGroupGuest.revokedBy,
};

const inviteColumns = {
  id: threadInvite.id,
  threadId: threadInvite.threadId,
  createdBy: threadInvite.createdBy,
  createdAt: threadInvite.createdAt,
  linkExpiresAt: threadInvite.linkExpiresAt,
  accessFor: threadInvite.accessFor,
  role: threadInvite.role,
  acceptedBy: threadInvite.acceptedBy,
  acceptedAt: threadInvite.acceptedAt,
  revokedAt: threadInvite.revokedAt,
};

const threadColumns = {
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

// A guest row whose access has not ended at `now`.
function active(now: Date) {
  return and(
    isNull(threadGuest.revokedAt),
    or(isNull(threadGuest.accessUntil), gt(threadGuest.accessUntil, now)),
  );
}

// A group's grant row `tg` that has not ended at `now`.
function grantActive(now: Date) {
  return sql`tg.revoked_at is null and (tg.access_until is null or tg.access_until > ${now.getTime()})`;
}

// Whether the user has no role in space `s`: none given to them, to their directory groups or to
// everyone in the org.
function lacksSpaceRole(userId: SQL) {
  return sql`not (s.kind = 'shared' and s.everyone_role is not null)
    and not exists (select 1 from space_member sm
                     where sm.space_id = s.id
                       and ((sm.subject_kind = 'user' and sm.subject_id = ${userId})
                         or (sm.subject_kind = 'group' and sm.subject_id in
                               (select gm.group_id from scim_group_member gm
                                  join scim_user su on su.id = gm.scim_user_id
                                 where su.user_id = ${userId} and su.active = 1))))`;
}

// The thread grants `tg` for the user through a group of theirs the thread's org still links, in
// threads `t` of spaces `s` where they have no role.
function groupGranted(userId: string, now: Date) {
  return sql`from thread_group_guest tg
    join thread t on t.id = tg.thread_id
    join space s on s.id = t.space_id
    join org_group og on og.organization_id = s.organization_id and og.group_id = tg.group_id
    where ${grantActive(now)}
      and tg.group_id in (select gm.group_id from scim_group_member gm
                            join scim_user su on su.id = gm.scim_user_id
                           where su.user_id = ${userId} and su.active = 1)
      and ${lacksSpaceRole(sql`${userId}`)}`;
}

// The threads the user is a guest of, one way or another, and until when (null for never): their
// own grants and their groups', the longer where both reach the thread.
function guestOf(userId: string, now: Date) {
  return sql`select thread_id, case when sum(access_until is null) > 0 then null
                                    else max(access_until) end as access_until
    from (select g.thread_id as thread_id, g.access_until as access_until
            from thread_guest g
           where g.user_id = ${userId} and g.revoked_at is null
             and (g.access_until is null or g.access_until > ${now.getTime()})
          union all
          select tg.thread_id, tg.access_until ${groupGranted(userId, now)})
    group by thread_id`;
}

// Threads `t` in spaces `s` that the user reaches only through their org: shared with it, in a
// space they have no role in, and not ones they are an active guest of, which come as guests. A
// role in the space is any given to them, to their directory groups or to everyone in the org,
// as the space store works it out.
function orgReached(userId: string, now: Date) {
  return sql`t.org_access <> 'none' and t.root_thread_id is null and s.trashed_at is null
    and exists (select 1 from member m
                 where m.organization_id = s.organization_id and m.user_id = ${userId})
    and ${lacksSpaceRole(sql`${userId}`)}
    and not exists (select 1 from thread_guest g2
                     where g2.thread_id = t.id and g2.user_id = ${userId}
                       and g2.revoked_at is null
                       and (g2.access_until is null or g2.access_until > ${now.getTime()}))
    and t.id not in (select tg.thread_id ${groupGranted(userId, now)})`;
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

    grant({ threadId, userId, invitedBy, accessUntil, role = "message" }) {
      const renewed = { invitedBy, accessUntil, role, revokedAt: null, revokedBy: null };
      return db
        .insert(threadGuest)
        .values({ threadId, userId, ...renewed })
        .onConflictDoUpdate({ target: [threadGuest.threadId, threadGuest.userId], set: renewed })
        .returning(guestColumns)
        .get();
    },

    setRole(threadId, userId, role) {
      db.update(threadGuest)
        .set({ role })
        .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)))
        .run();
    },

    findGroup(threadId, groupId): ThreadGroupGuest | null {
      return (
        db
          .select(groupColumns)
          .from(threadGroupGuest)
          .where(
            and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)),
          )
          .get() ?? null
      );
    },

    grantGroup({ threadId, groupId, invitedBy, accessUntil, role }) {
      const renewed = { invitedBy, accessUntil, role, revokedAt: null, revokedBy: null };
      return db
        .insert(threadGroupGuest)
        .values({ threadId, groupId, ...renewed })
        .onConflictDoUpdate({
          target: [threadGroupGuest.threadId, threadGroupGuest.groupId],
          set: renewed,
        })
        .returning(groupColumns)
        .get();
    },

    setGroupRole(threadId, groupId, role) {
      db.update(threadGroupGuest)
        .set({ role })
        .where(and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)))
        .run();
    },

    revokeGroup(threadId, groupId, by, at) {
      db.update(threadGroupGuest)
        .set({ revokedAt: at, revokedBy: by })
        .where(and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)))
        .run();
    },

    activeGroupsIn(threadId, now) {
      const inviter = alias(user, "inviter");
      return db
        .select({
          ...groupColumns,
          name: scimGroup.displayName,
          invitedByName: inviter.name,
          memberCount: sql<number>`(select count(distinct su.user_id) from scim_group_member gm
              join scim_user su on su.id = gm.scim_user_id
             where gm.group_id = ${threadGroupGuest.groupId} and su.active = 1)`,
        })
        .from(threadGroupGuest)
        .innerJoin(scimGroup, eq(scimGroup.id, threadGroupGuest.groupId))
        .leftJoin(inviter, eq(inviter.id, threadGroupGuest.invitedBy))
        .where(
          and(
            eq(threadGroupGuest.threadId, threadId),
            isNull(threadGroupGuest.revokedAt),
            or(isNull(threadGroupGuest.accessUntil), gt(threadGroupGuest.accessUntil, now)),
          ),
        )
        .orderBy(asc(threadGroupGuest.createdAt), sql`${threadGroupGuest}.rowid`)
        .all();
    },

    groupRole(threadId, userId, now): ThreadRole | null {
      const row = db.get<{ message: number | null }>(
        sql`select max(tg.role = 'message') as message ${groupGranted(userId, now)}
              and tg.thread_id = ${threadId}`,
      );
      return row?.message === null || row === undefined
        ? null
        : row.message === 1
          ? "message"
          : "view";
    },

    reachedIn(threadId, now) {
      const rows = db.all<{ userId: string; name: string; role: ThreadRole }>(
        sql`select u.id as userId, u.name as name, g.role as role
              from thread_guest g join user u on u.id = g.user_id
             where g.thread_id = ${threadId} and g.revoked_at is null
               and (g.access_until is null or g.access_until > ${now.getTime()})
            union all
            select u.id, u.name, tg.role
              from thread_group_guest tg
              join thread t on t.id = tg.thread_id
              join space s on s.id = t.space_id
              join org_group og on og.organization_id = s.organization_id
                               and og.group_id = tg.group_id
              join scim_group_member gm on gm.group_id = tg.group_id
              join scim_user su on su.id = gm.scim_user_id and su.active = 1
              join user u on u.id = su.user_id
             where tg.thread_id = ${threadId} and ${grantActive(now)}
               and ${lacksSpaceRole(sql`u.id`)}`,
      );
      const found = new Map<string, { userId: string; name: string; role: ThreadRole }>();
      for (const row of rows) {
        const had = found.get(row.userId);
        if (!had || row.role === "message") found.set(row.userId, row);
      }
      return [...found.values()];
    },

    orgAccess(threadId) {
      return (
        db.select({ orgAccess: thread.orgAccess }).from(thread).where(eq(thread.id, threadId)).get()
          ?.orgAccess ?? "none"
      );
    },

    setOrgAccess(threadId, orgAccess) {
      db.update(thread).set({ orgAccess }).where(eq(thread.id, threadId)).run();
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
      const viaOrg = db
        .all<{ id: string }>(
          sql`select t.id as id from thread t join space s on s.id = t.space_id
               where ${orgReached(userId, now)}`,
        )
        .map(({ id }) => id);
      const own = new Map(
        db
          .all<{ id: string; until: number | null }>(
            sql`select thread_id as id, access_until as until from (${guestOf(userId, now)})`,
          )
          .map(({ id, until }) => [id, until === null ? null : new Date(until)]),
      );
      const rows = (ids: string[], until: (id: string) => Date | null) =>
        ids.length === 0
          ? []
          : db
              .select({
                thread: threadColumns,
                space: { name: space.name, kind: space.kind, primary: space.primary },
                ownerName: creator.name,
                orgName: organization.name,
              })
              .from(thread)
              .innerJoin(space, eq(space.id, thread.spaceId))
              .innerJoin(organization, eq(organization.id, space.organizationId))
              .leftJoin(creator, eq(creator.id, space.createdBy))
              .where(and(inArray(thread.id, ids), isNull(space.trashedAt)))
              .all()
              .map((row) => ({ ...row, accessUntil: until(row.thread.id) }));
      return rows([...own.keys()], (id) => own.get(id) ?? null)
        .concat(rows(viaOrg, () => null))
        .toSorted(
          (a, b) =>
            b.thread.updatedAt.getTime() - a.thread.updatedAt.getTime() ||
            b.thread.id.localeCompare(a.thread.id),
        )
        .map(({ space: host, ownerName, ...row }) => {
          const spaceName = spaceNameFor(host, ownerName ?? row.orgName);
          return { ...row, spaceName, spaceNamedForOrg: spaceName !== host.name };
        });
    },

    sharedListed(userId, now, filter, window) {
      const listed = statused(userId, {
        from: sql`from (${guestOf(userId, now)}
                        union all
                        select t.id, null
                          from thread t join space s on s.id = t.space_id
                         where ${orgReached(userId, now)}) g
          join thread t on t.id = g.thread_id
          join space s on s.id = t.space_id
          join organization o on o.id = s.organization_id
          left join user c on c.id = s.created_by`,
        where: sql`s.trashed_at is null`,
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

    setInviteRole(id, role) {
      db.update(threadInvite).set({ role }).where(eq(threadInvite.id, id)).run();
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

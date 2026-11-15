import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import { parentOf } from "@/server/threads/parent.ts";

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
  parentThreadId: parentOf(thread.id),
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
  return sql`tg.revoked_at is null and (tg.access_until is null or tg.access_until > ${now})`;
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
                                 where su.user_id = ${userId} and su.active = true))))`;
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
                           where su.user_id = ${userId} and su.active = true)
      and ${lacksSpaceRole(sql`${userId}`)}`;
}

// The threads the user is a guest of, one way or another, and until when (null for never): their
// own grants and their groups', the longer where both reach the thread.
function guestOf(userId: string, now: Date) {
  return sql`select thread_id, case when bool_or(access_until is null) then null
                                    else max(access_until) end as access_until
    from (select g.thread_id as thread_id, g.access_until as access_until
            from thread_guest g
           where g.user_id = ${userId} and g.revoked_at is null
             and (g.access_until is null or g.access_until > ${now})
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
                       and (g2.access_until is null or g2.access_until > ${now}))
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
  // The thread stamped as changed by the database's clock in the same statement that shares it,
  // so the list feed, which asks by that stamp, finds it for whoever it now reaches.
  const touched = (threadId: string) =>
    db.$with("touched").as(
      db
        .update(thread)
        .set({ updatedAt: sql`now()` })
        .where(eq(thread.id, threadId))
        .returning({ id: thread.id }),
    );
  return {
    async find(threadId, userId): Promise<ThreadGuest | null> {
      return (
        (
          await db
            .select(guestColumns)
            .from(threadGuest)
            .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)))
            .limit(1)
        )[0] ?? null
      );
    },

    async grant({ threadId, userId, invitedBy, accessUntil, role = "message" }) {
      const renewed = { invitedBy, accessUntil, role, revokedAt: null, revokedBy: null };
      return (
        await db
          .with(touched(threadId))
          .insert(threadGuest)
          .values({ threadId, userId, ...renewed })
          .onConflictDoUpdate({ target: [threadGuest.threadId, threadGuest.userId], set: renewed })
          .returning(guestColumns)
      )[0]!;
    },

    async setRole(threadId, userId, role) {
      await db
        .update(threadGuest)
        .set({ role })
        .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)));
    },

    async findGroup(threadId, groupId): Promise<ThreadGroupGuest | null> {
      return (
        (
          await db
            .select(groupColumns)
            .from(threadGroupGuest)
            .where(
              and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)),
            )
            .limit(1)
        )[0] ?? null
      );
    },

    async grantGroup({ threadId, groupId, invitedBy, accessUntil, role }) {
      const renewed = { invitedBy, accessUntil, role, revokedAt: null, revokedBy: null };
      return (
        await db
          .with(touched(threadId))
          .insert(threadGroupGuest)
          .values({ threadId, groupId, ...renewed })
          .onConflictDoUpdate({
            target: [threadGroupGuest.threadId, threadGroupGuest.groupId],
            set: renewed,
          })
          .returning(groupColumns)
      )[0]!;
    },

    async setGroupRole(threadId, groupId, role) {
      await db
        .update(threadGroupGuest)
        .set({ role })
        .where(and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)));
    },

    async revokeGroup(threadId, groupId, by, at) {
      await db
        .update(threadGroupGuest)
        .set({ revokedAt: at, revokedBy: by })
        .where(and(eq(threadGroupGuest.threadId, threadId), eq(threadGroupGuest.groupId, groupId)));
    },

    async activeGroupsIn(threadId, now) {
      const inviter = alias(user, "inviter");
      return await db
        .select({
          ...groupColumns,
          name: scimGroup.displayName,
          invitedByName: inviter.name,
          memberCount: sql<number>`(select count(distinct su.user_id)::int from scim_group_member gm
              join scim_user su on su.id = gm.scim_user_id
             where gm.group_id = ${threadGroupGuest.groupId} and su.active = true)`,
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
        .orderBy(asc(threadGroupGuest.createdAt), asc(threadGroupGuest.groupId));
    },

    async groupRole(threadId, userId, now): Promise<ThreadRole | null> {
      const row = (
        await db.execute<{ message: boolean | null }>(
          sql`select bool_or(tg.role = 'message') as message ${groupGranted(userId, now)}
              and tg.thread_id = ${threadId}`,
        )
      ).rows[0];
      return row?.message === null || row === undefined ? null : row.message ? "message" : "view";
    },

    async reachedIn(threadId, now) {
      const rows = (
        await db.execute<{ userId: string; name: string; role: ThreadRole }>(
          sql`select u.id as "userId", u.name as name, g.role as role
              from thread_guest g join "user" u on u.id = g.user_id
             where g.thread_id = ${threadId} and g.revoked_at is null
               and (g.access_until is null or g.access_until > ${now})
            union all
            select u.id, u.name, tg.role
              from thread_group_guest tg
              join thread t on t.id = tg.thread_id
              join space s on s.id = t.space_id
              join org_group og on og.organization_id = s.organization_id
                               and og.group_id = tg.group_id
              join scim_group_member gm on gm.group_id = tg.group_id
              join scim_user su on su.id = gm.scim_user_id and su.active = true
              join "user" u on u.id = su.user_id
             where tg.thread_id = ${threadId} and ${grantActive(now)}
               and ${lacksSpaceRole(sql`u.id`)}`,
        )
      ).rows;
      const found = new Map<string, { userId: string; name: string; role: ThreadRole }>();
      for (const row of rows) {
        const had = found.get(row.userId);
        if (!had || row.role === "message") found.set(row.userId, row);
      }
      return [...found.values()];
    },

    async orgAccess(threadId) {
      return (
        (
          await db
            .select({ orgAccess: thread.orgAccess })
            .from(thread)
            .where(eq(thread.id, threadId))
            .limit(1)
        )[0]?.orgAccess ?? "none"
      );
    },

    async setOrgAccess(threadId, orgAccess) {
      await db
        .update(thread)
        .set({ orgAccess, updatedAt: sql`now()` })
        .where(eq(thread.id, threadId));
    },

    async revoke(threadId, userId, by, at) {
      await db
        .update(threadGuest)
        .set({ revokedAt: at, revokedBy: by })
        .where(and(eq(threadGuest.threadId, threadId), eq(threadGuest.userId, userId)));
    },

    async activeIn(threadId, now) {
      const inviter = alias(user, "inviter");
      return await db
        .select({ ...guestColumns, name: user.name, invitedByName: inviter.name })
        .from(threadGuest)
        .innerJoin(user, eq(user.id, threadGuest.userId))
        .leftJoin(inviter, eq(inviter.id, threadGuest.invitedBy))
        .where(and(eq(threadGuest.threadId, threadId), active(now)))
        .orderBy(asc(threadGuest.createdAt), asc(threadGuest.userId));
    },

    async threadsOf(userId, now) {
      const viaOrg = (
        await db.execute<{ id: string }>(
          sql`select t.id as id from thread t join space s on s.id = t.space_id
               where ${orgReached(userId, now)}`,
        )
      ).rows.map(({ id }) => id);
      const own = new Map(
        (
          await db.execute<{ id: string; until: number | null }>(
            sql`select thread_id as id, access_until as until from (${guestOf(userId, now)})`,
          )
        ).rows.map(({ id, until }) => [id, until === null ? null : new Date(until)]),
      );
      const rows = async (ids: string[], until: (id: string) => Date | null) =>
        ids.length === 0
          ? []
          : (
              await db
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
            ).map((row) => ({ ...row, accessUntil: until(row.thread.id) }));
      return (await rows([...own.keys()], (id) => own.get(id) ?? null))
        .concat(await rows(viaOrg, () => null))
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

    async sharedListed(userId, now, filter, window) {
      const listed = statused(userId, {
        from: sql`from (${guestOf(userId, now)}
                        union all
                        select t.id, null
                          from thread t join space s on s.id = t.space_id
                         where ${orgReached(userId, now)}) g
          join thread t on t.id = g.thread_id
          join space s on s.id = t.space_id
          join organization o on o.id = s.organization_id
          left join "user" c on c.id = s.created_by`,
        where: sql`s.trashed_at is null`,
        // Where the thread is as its list says: a person's own space alone, any other with its org.
        columns: sql`, s.name as space_name, s.kind as space_kind, s.is_primary as space_primary,
          c.name as owner_name, o.name as org_name, g.access_until as access_until,
          case when s.kind = 'personal' and s.is_primary = true
               then coalesce(c.name, o.name) || ${SPACE_SUFFIX}
               else s.name || ' · ' || o.name end as place`,
      });
      const keep = kept(filter, sql`coalesce(title, ${UNTITLED})`, sql`place`);
      const rows = (
        await db.execute<SharedRow & Record<string, unknown>>(
          sql`${listed} select * from statused where ${keep} ${newestFirst} ${windowOf(window)}`,
        )
      ).rows;
      const total = window
        ? ((
            await db.execute<{ n: number }>(
              sql`${listed} select count(*)::int as n from statused where ${keep}`,
            )
          ).rows[0]?.n ?? 0)
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

    async hostSpaceName(threadId) {
      const row = (
        await db
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
          .limit(1)
      )[0];
      return row ? spaceNameFor(row, row.ownerName ?? row.orgName) : null;
    },

    async setInviteRole(id, role) {
      await db.update(threadInvite).set({ role }).where(eq(threadInvite.id, id));
    },

    async createInvite(input) {
      return (
        await db
          .insert(threadInvite)
          .values({ id: ulid(), ...input })
          .returning(inviteColumns)
      )[0]!;
    },

    async findInvite(id): Promise<ThreadInvite | null> {
      return (
        (
          await db.select(inviteColumns).from(threadInvite).where(eq(threadInvite.id, id)).limit(1)
        )[0] ?? null
      );
    },

    async findInviteByHash(tokenHash): Promise<ThreadInvite | null> {
      return (
        (
          await db
            .select(inviteColumns)
            .from(threadInvite)
            .where(eq(threadInvite.tokenHash, tokenHash))
            .limit(1)
        )[0] ?? null
      );
    },

    async pendingInvites(threadId, now) {
      return await db
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
        .orderBy(asc(threadInvite.createdAt), asc(threadInvite.id));
    },

    async markAccepted(id, userId, at) {
      const stamped = await db
        .update(threadInvite)
        .set({ acceptedBy: userId, acceptedAt: at })
        .where(
          and(
            eq(threadInvite.id, id),
            isNull(threadInvite.acceptedAt),
            isNull(threadInvite.revokedAt),
          ),
        )
        .returning({ id: threadInvite.id });
      return stamped.length === 1;
    },

    async revokeInvite(id, at) {
      await db.update(threadInvite).set({ revokedAt: at }).where(eq(threadInvite.id, id));
    },
  };
}

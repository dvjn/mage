import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

import { FIRST_SPACE_NAME, spaceNameFor } from "@/shared/spaces.ts";
import { type Db, writeLock } from "@/server/db/db.ts";
import { after, containing, pageLimit, pageOf } from "@/server/db/paging.ts";
import { organization, scimGroup, user } from "@/server/orgs/schema.ts";

import { space, spaceMember } from "./schema.ts";
import type { Grant, Space, SpaceRole, SpaceStore, Subject, TrashedSpace } from "./service.ts";

// What follows a person's name in their first space's name, as the one naming function gives it.
const SPACE_SUFFIX = spaceNameFor({ name: FIRST_SPACE_NAME, kind: "personal", primary: true }, "");

const columns = {
  id: space.id,
  orgId: space.organizationId,
  kind: space.kind,
  name: space.name,
  primary: space.primary,
  defaultModel: space.defaultModel,
  defaultEffort: space.defaultEffort,
  agentName: space.agentName,
  everyoneRole: space.everyoneRole,
  createdBy: space.createdBy,
  archivedAt: space.archivedAt,
  trashedAt: space.trashedAt,
  trashedBy: space.trashedBy,
  createdAt: space.createdAt,
  updatedAt: space.updatedAt,
};

const RANK: Record<SpaceRole, number> = { viewer: 1, messager: 2, owner: 3 };

// The higher of two roles, where null is none.
export function higherRole(a: SpaceRole | null, b: SpaceRole | null): SpaceRole | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

function subjectIs(subject: Subject) {
  return and(eq(spaceMember.subjectKind, subject.kind), eq(spaceMember.subjectId, subject.id));
}

export function createSpaceStore(db: Db): SpaceStore {
  // Every role the user has in the org's spaces, or in the one space: given to them, to their
  // groups, and to everyone in the org while they are a member of it.
  function roleRows(userId: string, where: { orgId: string } | { spaceId: string }) {
    const scope =
      "orgId" in where
        ? sql`s.organization_id = ${where.orgId} and s.trashed_at is null`
        : sql`s.id = ${where.spaceId} and s.trashed_at is null`;
    return db.all<{ spaceId: string; role: SpaceRole }>(sql`
      select sm.space_id as spaceId, sm.role as role
        from space_member sm join space s on s.id = sm.space_id
       where ${scope}
         and ((sm.subject_kind = 'user' and sm.subject_id = ${userId})
           or (sm.subject_kind = 'group' and sm.subject_id in
                 (select gm.group_id from scim_group_member gm
                    join scim_user su on su.id = gm.scim_user_id
                   where su.user_id = ${userId} and su.active = 1)))
      union all
      select s.id as spaceId, s.everyone_role as role
        from space s
       where ${scope} and s.kind = 'shared' and s.everyone_role is not null
         and exists (select 1 from member m
                      where m.organization_id = s.organization_id and m.user_id = ${userId})
    `);
  }

  return {
    create({ orgId, createdBy, ...rest }) {
      return db.transaction((tx) => {
        const created = tx
          .insert(space)
          .values({ id: ulid(), organizationId: orgId, createdBy, ...rest })
          .returning(columns)
          .get();
        tx.insert(spaceMember)
          .values({
            spaceId: created.id,
            subjectKind: "user",
            subjectId: createdBy,
            role: "owner",
            source: "direct",
          })
          .run();
        return created;
      }, writeLock);
    },

    find(id): Space | null {
      return db.select(columns).from(space).where(eq(space.id, id)).get() ?? null;
    },

    listInOrg(orgId) {
      return db
        .select(columns)
        .from(space)
        .where(and(eq(space.organizationId, orgId), isNull(space.trashedAt)))
        .orderBy(desc(space.primary), asc(space.createdAt), asc(space.id))
        .all();
    },

    rolesIn(orgId, userId) {
      const roles = new Map<string, SpaceRole>();
      for (const row of roleRows(userId, { orgId })) {
        roles.set(row.spaceId, higherRole(roles.get(row.spaceId) ?? null, row.role)!);
      }
      return roles;
    },

    roleOf(spaceId, userId) {
      return roleRows(userId, { spaceId }).reduce<SpaceRole | null>(
        (best, row) => higherRole(best, row.role),
        null,
      );
    },

    grants(spaceId) {
      const people: Grant[] = db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          role: spaceMember.role,
          createdAt: spaceMember.createdAt,
        })
        .from(spaceMember)
        .innerJoin(user, eq(user.id, spaceMember.subjectId))
        .where(and(eq(spaceMember.spaceId, spaceId), eq(spaceMember.subjectKind, "user")))
        .orderBy(asc(user.name))
        .all()
        .map(({ id, ...row }) => ({ subject: { kind: "user", id }, ...row }));
      const groups: Grant[] = db
        .select({
          id: scimGroup.id,
          name: scimGroup.displayName,
          role: spaceMember.role,
          createdAt: spaceMember.createdAt,
        })
        .from(spaceMember)
        .innerJoin(scimGroup, eq(scimGroup.id, spaceMember.subjectId))
        .where(and(eq(spaceMember.spaceId, spaceId), eq(spaceMember.subjectKind, "group")))
        .orderBy(asc(scimGroup.displayName))
        .all()
        .map(({ id, ...row }) => ({ subject: { kind: "group", id }, email: null, ...row }));
      return [...people, ...groups];
    },

    grantPage(spaceId, params) {
      const where = sql`space_id = ${spaceId}
        ${params.role ? sql`and role = ${params.role}` : sql``}
        and ${containing(params.q, sql`name`, sql`email`)}`;
      // People first, then groups, each by name.
      const grants = sql`
        select sm.space_id, 'user' as kind, u.id, u.name, u.email, sm.role, sm.created_at,
               '0' || lower(u.name) as sortKey
          from space_member sm join user u on u.id = sm.subject_id
         where sm.subject_kind = 'user'
        union all
        select sm.space_id, 'group', g.id, g.display_name, null, sm.role, sm.created_at,
               '1' || lower(g.display_name)
          from space_member sm join scim_group g on g.id = sm.subject_id
         where sm.subject_kind = 'group'`;
      const rows = db.all<{
        kind: "user" | "group";
        id: string;
        name: string;
        email: string | null;
        role: SpaceRole;
        createdAt: number;
        sortKey: string;
      }>(sql`
        select kind, id, name, email, role, created_at as createdAt, sortKey from (${grants})
         where ${where} and ${after(params.cursor, sql`sortKey`, sql`id`)}
         order by sortKey, id
         ${pageLimit(params)}`);
      const total = db.get<{ n: number }>(
        sql`select count(*) as n from (${grants}) where ${where}`,
      );
      const page = pageOf(rows, params, total?.n ?? 0, (row) => [row.sortKey, row.id]);
      return {
        ...page,
        items: page.items.map(({ kind, id, name, email, role, createdAt }) => ({
          subject: { kind, id },
          name,
          email,
          role,
          createdAt: new Date(createdAt),
        })),
      };
    },

    catalogPage(orgId, params) {
      // The name everyone sees: a person's own space is named for them.
      const named = sql`
        select s.*, u.name as ownerName,
               case when s.kind = 'personal' and s.is_primary = 1
                    then coalesce(u.name, 'A former member') || ${SPACE_SUFFIX} else s.name end
                 as displayName
          from space s left join user u on u.id = s.created_by
         where s.organization_id = ${orgId} and s.trashed_at is null`;
      const where = sql`${containing(params.q, sql`displayName`)}
        ${params.kind ? sql`and kind = ${params.kind}` : sql``}
        ${
          params.everyone === "none"
            ? sql`and kind = 'shared' and everyone_role is null`
            : params.everyone
              ? sql`and everyone_role = ${params.everyone}`
              : sql``
        }`;
      const rows = db.all<{ id: string; displayName: string; ownerName: string | null }>(sql`
        select id, displayName, ownerName from (${named})
         where ${where} and ${after(params.cursor, sql`lower(displayName)`, sql`id`)}
         order by lower(displayName), id
         ${pageLimit(params)}`);
      const total = db.get<{ n: number }>(sql`select count(*) as n from (${named}) where ${where}`);
      const page = pageOf(rows, params, total?.n ?? 0, (row) => [
        row.displayName.toLowerCase(),
        row.id,
      ]);
      return {
        ...page,
        items: page.items.map((row) => {
          const found = db.select(columns).from(space).where(eq(space.id, row.id)).get()!;
          const counts = db.get<{ members: number; threads: number }>(sql`
            select (select count(*) from space_member where space_id = ${row.id}) as members,
                   (select count(*) from thread where space_id = ${row.id}) as threads`);
          return {
            ...found,
            displayName: row.displayName,
            ownerName: row.ownerName,
            memberCount: counts?.members ?? 0,
            threadCount: counts?.threads ?? 0,
          };
        }),
      };
    },

    grant(spaceId, subject, role) {
      db.insert(spaceMember)
        .values({
          spaceId,
          subjectKind: subject.kind,
          subjectId: subject.id,
          role,
          source: "direct",
        })
        .onConflictDoUpdate({
          target: [spaceMember.spaceId, spaceMember.subjectKind, spaceMember.subjectId],
          set: { role },
        })
        .run();
    },

    revoke(spaceId, subject) {
      db.delete(spaceMember)
        .where(and(eq(spaceMember.spaceId, spaceId), subjectIs(subject)))
        .run();
    },

    setEveryoneRole(id, role) {
      return db
        .update(space)
        .set({ everyoneRole: role, updatedAt: new Date() })
        .where(eq(space.id, id))
        .returning(columns)
        .get() as Space;
    },

    memberSpaceOf(orgId, userId) {
      return (
        db
          .select(columns)
          .from(space)
          .where(
            and(
              eq(space.organizationId, orgId),
              eq(space.kind, "personal"),
              eq(space.primary, true),
              eq(space.createdBy, userId),
              isNull(space.trashedAt),
            ),
          )
          .get() ?? null
      );
    },

    withDefaultModel(orgId, refs) {
      if (refs.length === 0) return [];
      return db
        .select(columns)
        .from(space)
        .where(
          and(
            eq(space.organizationId, orgId),
            inArray(space.defaultModel, refs),
            isNull(space.trashedAt),
          ),
        )
        .orderBy(asc(space.name))
        .all();
    },

    rename(id, name) {
      return db
        .update(space)
        .set({ name, updatedAt: new Date() })
        .where(eq(space.id, id))
        .returning(columns)
        .get() as Space;
    },

    setDefaults(id, { model, effort, agentName }) {
      return db
        .update(space)
        .set({
          ...(model !== undefined && { defaultModel: model }),
          ...(effort !== undefined && { defaultEffort: effort }),
          ...(agentName !== undefined && { agentName }),
          updatedAt: new Date(),
        })
        .where(eq(space.id, id))
        .returning(columns)
        .get() as Space;
    },

    delete(id) {
      db.delete(space).where(eq(space.id, id)).run();
    },

    setArchivedAt(id, at) {
      db.update(space).set({ archivedAt: at }).where(eq(space.id, id)).run();
    },

    trash(id, by, at) {
      db.update(space).set({ trashedAt: at, trashedBy: by }).where(eq(space.id, id)).run();
    },

    untrash(id) {
      db.update(space).set({ trashedAt: null, trashedBy: null }).where(eq(space.id, id)).run();
    },

    trashedIn(orgId) {
      const trasher = alias(user, "trasher");
      return db
        .select({
          ...columns,
          ownerName: user.name,
          trashedByName: trasher.name,
          threadCount: sql<number>`(select count(*) from thread where space_id = ${space.id})`,
        })
        .from(space)
        .leftJoin(user, eq(user.id, space.createdBy))
        .leftJoin(trasher, eq(trasher.id, space.trashedBy))
        .where(and(eq(space.organizationId, orgId), isNotNull(space.trashedAt)))
        .orderBy(desc(space.trashedAt), desc(space.id))
        .all() as TrashedSpace[];
    },

    trashedBefore(at) {
      return db.select(columns).from(space).where(lte(space.trashedAt, at)).all();
    },

    memberSpaces() {
      return db
        .select(columns)
        .from(space)
        .innerJoin(organization, eq(organization.id, space.organizationId))
        .where(
          and(eq(organization.kind, "team"), eq(space.kind, "personal"), isNull(space.trashedAt)),
        )
        .all();
    },
  };
}

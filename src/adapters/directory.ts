// The local directory: password accounts, the org members the auth library keeps, and the groups
// and former members Mage keeps beside them. Orgs are made and members added through the library;
// roles change, members leave, and orgs are renamed and deleted in its tables directly, with the
// rows that hang off them.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { Directory, Group, OrgRole } from "@/ports/directory.ts";

import type { Auth } from "./auth.ts";
import { after, containing, pageOf } from "./paging.ts";
import type { Db } from "./db.ts";
import {
  group,
  groupMember,
  member,
  organization,
  orgFormerMember,
  session,
  space,
  spaceMember,
  user,
} from "./schema.ts";

const orgColumns = {
  id: organization.id,
  name: organization.name,
  kind: organization.kind,
  createdAt: organization.createdAt,
};

const groupColumns = {
  id: group.id,
  orgId: group.organizationId,
  name: group.name,
  source: group.source,
  externalId: group.externalId,
  createdAt: group.createdAt,
};

const userColumns = { id: user.id, name: user.name, email: user.email };

export function createDirectory(db: Db, auth: Auth): Directory {
  return {
    memberPage(orgId, params) {
      const where = sql`m.organization_id = ${orgId}
        ${params.role ? sql`and m.role = ${params.role}` : sql``}
        ${params.userId ? sql`and m.user_id = ${params.userId}` : sql``}
        and ${containing(params.q, sql`u.name`, sql`u.email`)}`;
      const rows = db.all<{
        id: string;
        name: string;
        email: string;
        role: OrgRole;
        joinedAt: number;
        groupCount: number;
      }>(sql`
        select u.id, u.name, u.email, m.role, m.created_at as joinedAt,
               (select count(*) from group_member gm join "group" g on g.id = gm.group_id
                 where gm.user_id = u.id and g.organization_id = m.organization_id) as groupCount
          from member m join user u on u.id = m.user_id
         where ${where} and ${after(params.cursor, sql`lower(u.name)`, sql`u.id`)}
         order by lower(u.name), u.id
         limit ${params.limit + 1}`);
      const total = db.get<{ n: number }>(sql`
        select count(*) as n from member m join user u on u.id = m.user_id where ${where}`);
      return pageOf(
        rows.map((row) => ({ ...row, joinedAt: new Date(row.joinedAt), source: "local" as const })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    peoplePage(orgId, params) {
      const members = sql`
        select 'member' as kind, u.id, u.name, u.email, m.role, m.created_at as at,
               null as createdByName, '1' || lower(u.name) as sortKey,
               (select count(*) from group_member gm join "group" g on g.id = gm.group_id
                 where gm.user_id = u.id and g.organization_id = m.organization_id) as groupCount
          from member m join user u on u.id = m.user_id
         where m.organization_id = ${orgId}`;
      const invites = params.invitesAt
        ? sql`
        select 'invite', i.id, null, i.email, i.role, i.expires_at, c.name, '0' || lower(i.email), 0
          from org_invite i left join user c on c.id = i.created_by
         where i.organization_id = ${orgId} and i.accepted_at is null and i.revoked_at is null
           and i.expires_at > ${params.invitesAt.getTime()}`
        : null;
      const people = invites ? sql`${members} union all ${invites}` : members;
      const where = sql`${containing(params.q, sql`name`, sql`email`)}
        ${params.role ? sql`and role = ${params.role}` : sql``}
        ${
          params.status === "member"
            ? sql`and kind = 'member'`
            : params.status === "invited"
              ? sql`and kind = 'invite'`
              : sql``
        }`;
      const rows = db.all<{
        kind: "member" | "invite";
        id: string;
        name: string | null;
        email: string;
        role: OrgRole;
        at: number;
        createdByName: string | null;
        sortKey: string;
        groupCount: number;
      }>(sql`
        select * from (${people})
         where ${where} and ${after(params.cursor, sql`sortKey`, sql`id`)}
         order by sortKey, id
         limit ${params.limit + 1}`);
      const total = db.get<{ n: number }>(
        sql`select count(*) as n from (${people}) where ${where}`,
      );
      const page = pageOf(rows, params, total?.n ?? 0, (row) => [row.sortKey, row.id]);
      return {
        ...page,
        items: page.items.map((row) =>
          row.kind === "member"
            ? {
                kind: "member" as const,
                id: row.id,
                name: row.name ?? "",
                email: row.email,
                role: row.role,
                joinedAt: new Date(row.at),
                groupCount: row.groupCount,
                source: "local" as const,
              }
            : {
                kind: "invite" as const,
                id: row.id,
                email: row.email,
                role: row.role,
                createdByName: row.createdByName,
                expiresAt: new Date(row.at),
              },
        ),
      };
    },

    member(orgId, userId) {
      const row = db
        .select({ ...userColumns, role: member.role, joinedAt: member.createdAt })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
        .get();
      return row ? { ...row, role: row.role as OrgRole, source: "local" } : null;
    },

    groupPage(orgId, params) {
      const where = sql`g.organization_id = ${orgId}
        ${
          params.userId
            ? sql`and g.id in (select group_id from group_member where user_id = ${params.userId})`
            : sql``
        }
        and ${containing(params.q, sql`g.name`)}`;
      const rows = db.all<{
        id: string;
        orgId: string;
        name: string;
        source: "local" | "scim";
        externalId: string | null;
        createdAt: number;
        memberCount: number;
      }>(sql`
        select g.id, g.organization_id as orgId, g.name, g.source, g.external_id as externalId,
               g.created_at as createdAt,
               (select count(*) from group_member gm where gm.group_id = g.id) as memberCount
          from "group" g
         where ${where} and ${after(params.cursor, sql`lower(g.name)`, sql`g.id`)}
         order by lower(g.name), g.id
         limit ${params.limit + 1}`);
      const total = db.get<{ n: number }>(sql`select count(*) as n from "group" g where ${where}`);
      return pageOf(
        rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    groupMemberPage(groupId, params) {
      const where = sql`gm.group_id = ${groupId} and ${containing(params.q, sql`u.name`, sql`u.email`)}`;
      const rows = db.all<{ id: string; name: string; email: string }>(sql`
        select u.id, u.name, u.email from group_member gm join user u on u.id = gm.user_id
         where ${where} and ${after(params.cursor, sql`lower(u.name)`, sql`u.id`)}
         order by lower(u.name), u.id
         limit ${params.limit + 1}`);
      const total = db.get<{ n: number }>(sql`
        select count(*) as n from group_member gm join user u on u.id = gm.user_id where ${where}`);
      return pageOf(
        rows.map((row) => ({ ...row, source: "local" as const })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    groupIdsOf(orgId, userId) {
      return db
        .select({ id: groupMember.groupId })
        .from(groupMember)
        .innerJoin(group, eq(group.id, groupMember.groupId))
        .where(and(eq(group.organizationId, orgId), eq(groupMember.userId, userId)))
        .all()
        .map((row) => row.id);
    },

    memberCount(groupId) {
      return (
        db.get<{ n: number }>(
          sql`select count(*) as n from group_member where group_id = ${groupId}`,
        )?.n ?? 0
      );
    },

    org(orgId) {
      return (
        db.select(orgColumns).from(organization).where(eq(organization.id, orgId)).get() ?? null
      );
    },

    orgsOf(userId) {
      const owners = db
        .select({ orgId: member.organizationId, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.role, "owner"))
        .orderBy(asc(member.createdAt))
        .all();
      const ownerName = new Map<string, string>();
      for (const owner of owners)
        if (!ownerName.has(owner.orgId)) ownerName.set(owner.orgId, owner.name);
      return db
        .select({ ...orgColumns, role: member.role })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, userId))
        .orderBy(desc(sql`${organization.kind} = 'personal'`), asc(organization.name))
        .all()
        .map((row) => ({
          ...row,
          role: row.role as OrgRole,
          ownerName: ownerName.get(row.id) ?? null,
        }));
    },

    async createTeamOrg(name, ownerId) {
      const created = await auth.api.createOrganization({
        body: { name, slug: ulid().toLowerCase(), userId: ownerId, kind: "team" },
      });
      if (!created) throw new Error("the org was not created");
      return { id: created.id, name: created.name, kind: "team", createdAt: created.createdAt };
    },

    renameOrg(orgId, name) {
      db.update(organization).set({ name }).where(eq(organization.id, orgId)).run();
    },

    // Everything else in the org goes with its row through the tables' cascades.
    deleteOrg(orgId) {
      db.transaction((tx) => {
        tx.update(session)
          .set({ activeOrganizationId: null })
          .where(eq(session.activeOrganizationId, orgId))
          .run();
        tx.delete(organization).where(eq(organization.id, orgId)).run();
      });
    },

    user(id) {
      const row = db.select(userColumns).from(user).where(eq(user.id, id)).get();
      return row ? { ...row, source: "local" } : null;
    },

    userByEmail(email) {
      const row = db
        .select(userColumns)
        .from(user)
        .where(eq(sql`lower(${user.email})`, email.toLowerCase()))
        .get();
      return row ? { ...row, source: "local" } : null;
    },

    roleIn(orgId, userId) {
      const row = db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
        .get();
      return row ? (row.role as OrgRole) : null;
    },

    members(orgId) {
      return db
        .select({ ...userColumns, role: member.role, joinedAt: member.createdAt })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, orgId))
        .orderBy(asc(member.createdAt))
        .all()
        .map((row) => ({ ...row, role: row.role as OrgRole, source: "local" as const }));
    },

    async addMember(orgId, userId, role) {
      await auth.api.addMember({ body: { userId, role, organizationId: orgId } });
      db.delete(orgFormerMember)
        .where(and(eq(orgFormerMember.organizationId, orgId), eq(orgFormerMember.userId, userId)))
        .run();
    },

    setRole(orgId, userId, role) {
      db.update(member)
        .set({ role })
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
        .run();
    },

    removeMember(orgId, userId, at) {
      db.transaction((tx) => {
        tx.delete(member)
          .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
          .run();
        const groups = tx
          .select({ id: group.id })
          .from(group)
          .where(eq(group.organizationId, orgId));
        tx.delete(groupMember)
          .where(and(eq(groupMember.userId, userId), inArray(groupMember.groupId, groups)))
          .run();
        const spaces = tx
          .select({ id: space.id })
          .from(space)
          .where(eq(space.organizationId, orgId));
        tx.delete(spaceMember)
          .where(
            and(
              eq(spaceMember.subjectKind, "user"),
              eq(spaceMember.subjectId, userId),
              inArray(spaceMember.spaceId, spaces),
            ),
          )
          .run();
        tx.insert(orgFormerMember)
          .values({ organizationId: orgId, userId, removedAt: at })
          .onConflictDoUpdate({
            target: [orgFormerMember.organizationId, orgFormerMember.userId],
            set: { removedAt: at },
          })
          .run();
      });
    },

    formerMembers(orgId, userIds) {
      if (userIds.length === 0) return [];
      return db
        .select({ userId: orgFormerMember.userId })
        .from(orgFormerMember)
        .where(
          and(eq(orgFormerMember.organizationId, orgId), inArray(orgFormerMember.userId, userIds)),
        )
        .all()
        .map((row) => row.userId);
    },

    groups(orgId) {
      return db
        .select(groupColumns)
        .from(group)
        .where(eq(group.organizationId, orgId))
        .orderBy(asc(sql`lower(${group.name})`))
        .all();
    },

    group(id): Group | null {
      return db.select(groupColumns).from(group).where(eq(group.id, id)).get() ?? null;
    },

    createGroup(orgId, name) {
      return db
        .insert(group)
        .values({ id: ulid(), organizationId: orgId, name })
        .returning(groupColumns)
        .get();
    },

    renameGroup(id, name) {
      return db
        .update(group)
        .set({ name })
        .where(eq(group.id, id))
        .returning(groupColumns)
        .get() as Group;
    },

    deleteGroup(id) {
      db.transaction((tx) => {
        tx.delete(spaceMember)
          .where(and(eq(spaceMember.subjectKind, "group"), eq(spaceMember.subjectId, id)))
          .run();
        tx.delete(group).where(eq(group.id, id)).run();
      });
    },

    groupMembers(orgId) {
      const rows = db
        .select({ groupId: groupMember.groupId, userId: groupMember.userId })
        .from(groupMember)
        .innerJoin(group, eq(group.id, groupMember.groupId))
        .where(eq(group.organizationId, orgId))
        .orderBy(asc(groupMember.createdAt))
        .all();
      const members = new Map<string, string[]>();
      for (const row of rows)
        members.set(row.groupId, [...(members.get(row.groupId) ?? []), row.userId]);
      return members;
    },

    addToGroup(groupId, userId) {
      db.insert(groupMember).values({ groupId, userId }).onConflictDoNothing().run();
    },

    removeFromGroup(groupId, userId) {
      db.delete(groupMember)
        .where(and(eq(groupMember.groupId, groupId), eq(groupMember.userId, userId)))
        .run();
    },
  };
}

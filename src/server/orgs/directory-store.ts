// The directory: password accounts and the people and groups a SCIM directory brings, the org
// members the auth library keeps, and the group links and former members Mage keeps beside them.
// Orgs are made and members added through the library; roles change, members leave, and orgs are
// renamed and deleted in its tables directly, with the rows that hang off them. A member row holds
// the role they have, worked out by settling: the highest of their own and their linked groups'.

import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { after, containing, pageLimit, pageOf } from "@/server/db/paging.ts";
import type { Db } from "@/server/db/db.ts";
import { space, spaceMember } from "@/server/spaces/schema.ts";

import type { Directory, OrgRole, RecordSource, Settled } from "./directory.ts";
import type { Auth } from "./auth.ts";
import { member, orgGroup, organization, orgFormerMember, session, user } from "./schema.ts";

const orgColumns = {
  id: organization.id,
  name: organization.name,
  kind: organization.kind,
  createdAt: organization.createdAt,
};

const RANK: Record<OrgRole, number> = { member: 1, owner: 2 };

// The ids of the directory groups the user is active in.
function activeGroupsOf(userId: SQL) {
  return sql`(select gm.group_id from scim_group_member gm
                join scim_user su on su.id = gm.scim_user_id
               where su.user_id = ${userId} and su.active = true)`;
}

// Where the user's record comes from.
function sourceOf(userId: SQL) {
  return sql`(case when exists (select 1 from scim_user su where su.user_id = ${userId})
                   then 'scim' else 'local' end)`;
}

// How many active people are in the group.
function memberCountOf(groupId: SQL) {
  return sql`(select count(distinct su.user_id)::int from scim_group_member gm
                join scim_user su on su.id = gm.scim_user_id
               where gm.group_id = ${groupId} and su.active = true)`;
}

// A member's columns beside their user's: how many of the org's linked groups they are in, the first
// of them by name, the highest role those groups give, and their own role.
const memberContext = sql`
  (select count(*)::int from org_group og
    where og.organization_id = m.organization_id and og.group_id in ${activeGroupsOf(sql`u.id`)})
    as "groupCount",
  (select g.display_name from org_group og join scim_group g on g.id = og.group_id
    where og.organization_id = m.organization_id and og.group_id in ${activeGroupsOf(sql`u.id`)}
    order by lower(g.display_name) limit 1) as "viaGroup",
  (select og.role from org_group og
    where og.organization_id = m.organization_id and og.group_id in ${activeGroupsOf(sql`u.id`)}
    order by og.role = 'owner' desc limit 1) as "groupRole",
  m.direct_role as "directRole",
  ${sourceOf(sql`u.id`)} as source`;

type MemberContext = {
  groupCount: number;
  viaGroup: string | null;
  groupRole: OrgRole | null;
  directRole: OrgRole | null;
  source: RecordSource;
};

export function createDirectory(db: Db, auth: Auth): Directory {
  async function userOf(id: string) {
    return (
      (
        await db.execute<{ id: string; name: string; email: string; source: RecordSource }>(sql`
        select u.id, u.name, u.email, ${sourceOf(sql`u.id`)} as source from "user" u
         where u.id = ${id}`)
      ).rows[0] ?? null
    );
  }

  async function roleIn(orgId: string, userId: string) {
    const row = (
      await db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
        .limit(1)
    )[0];
    return row ? (row.role as OrgRole) : null;
  }

  async function directOwnerCount(orgId: string) {
    return (
      (
        await db.execute<{ n: number }>(sql`
        select count(*)::int as n from member
         where organization_id = ${orgId} and direct_role = 'owner'`)
      ).rows[0]?.n ?? 0
    );
  }

  async function isTeam(orgId: string) {
    return (
      (
        await db
          .select({ kind: organization.kind })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1)
      )[0]?.kind === "team"
    );
  }

  return {
    async memberPage(orgId, params) {
      const where = sql`m.organization_id = ${orgId}
        ${params.role ? sql`and m.role = ${params.role}` : sql``}
        ${params.userId ? sql`and m.user_id = ${params.userId}` : sql``}
        and ${containing(params.q, sql`u.name`, sql`u.email`)}`;
      const rows = (
        await db.execute<
          {
            id: string;
            name: string;
            email: string;
            role: OrgRole;
            joinedAt: number;
          } & MemberContext
        >(sql`
        select u.id, u.name, u.email, m.role, m.created_at as "joinedAt", ${memberContext}
          from member m join "user" u on u.id = m.user_id
         where ${where} and ${after(params.cursor, sql`lower(u.name)`, sql`u.id`)}
         order by lower(u.name), u.id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(sql`
        select count(*)::int as n from member m join "user" u on u.id = m.user_id where ${where}`)
      ).rows[0];
      return pageOf(
        rows.map((row) => ({ ...row, joinedAt: new Date(row.joinedAt) })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    async peoplePage(orgId, params) {
      const invites = params.invitesAt
        ? sql`
        select 'invite', i.id, null, i.email, i.role, i.expires_at, c.name, '0' || lower(i.email),
               0, null, null, null, 'local'
          from org_invite i left join "user" c on c.id = i.created_by
         where i.organization_id = ${orgId} and i.accepted_at is null and i.revoked_at is null
           and i.expires_at > ${params.invitesAt}
        union all`
        : sql``;
      // The first select names the columns.
      const people = sql`
        select 'group' as kind, g.id, g.display_name as name, g.email as email, og.role,
               og.created_at as at, null as "createdByName", '1' || lower(g.display_name) as "sortKey",
               ${memberCountOf(sql`g.id`)} as "groupCount", null as "viaGroup", null as "groupRole",
               null as "directRole",
               'scim' as source
          from org_group og join scim_group g on g.id = og.group_id
         where og.organization_id = ${orgId}
        union all ${invites}
        select 'member', u.id, u.name, u.email, m.role, m.created_at, null,
               '2' || lower(u.name), ${memberContext}
          from member m join "user" u on u.id = m.user_id
         where m.organization_id = ${orgId} and m.direct_role is not null`;
      const where = sql`${containing(params.q, sql`name`, sql`email`)}
        ${params.role ? sql`and role = ${params.role}` : sql``}
        ${
          params.status === "member"
            ? sql`and kind = 'member'`
            : params.status === "invited"
              ? sql`and kind = 'invite'`
              : params.status === "group"
                ? sql`and kind = 'group'`
                : sql``
        }`;
      const rows = (
        await db.execute<
          {
            kind: "member" | "invite" | "group";
            id: string;
            name: string | null;
            email: string | null;
            role: OrgRole;
            at: number;
            createdByName: string | null;
            sortKey: string;
          } & MemberContext
        >(sql`
        select * from (${people})
         where ${where} and ${after(params.cursor, sql`"sortKey"`, sql`id`)}
         order by "sortKey", id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from (${people}) where ${where}`,
        )
      ).rows[0];
      const page = pageOf(rows, params, total?.n ?? 0, (row) => [row.sortKey, row.id]);
      return {
        ...page,
        items: page.items.map((row) =>
          row.kind === "member"
            ? {
                kind: "member" as const,
                id: row.id,
                name: row.name ?? "",
                email: row.email ?? "",
                role: row.role,
                joinedAt: new Date(row.at),
                groupCount: row.groupCount,
                viaGroup: row.viaGroup,
                groupRole: row.groupRole,
                directRole: row.directRole,
                source: row.source,
              }
            : row.kind === "group"
              ? {
                  kind: "group" as const,
                  id: row.id,
                  name: row.name ?? "",
                  role: row.role,
                  linkedAt: new Date(row.at),
                  memberCount: row.groupCount,
                  source: "scim" as const,
                  externalId: null,
                  email: row.email,
                  createdAt: new Date(row.at),
                }
              : {
                  kind: "invite" as const,
                  id: row.id,
                  email: row.email ?? "",
                  role: row.role,
                  createdByName: row.createdByName,
                  expiresAt: new Date(row.at),
                },
        ),
      };
    },

    async member(orgId, userId) {
      const row = (
        await db.execute<{
          id: string;
          name: string;
          email: string;
          role: OrgRole;
          joinedAt: number;
          source: RecordSource;
        }>(sql`
        select u.id, u.name, u.email, m.role, m.created_at as "joinedAt",
               ${sourceOf(sql`u.id`)} as source
          from member m join "user" u on u.id = m.user_id
         where m.organization_id = ${orgId} and m.user_id = ${userId}`)
      ).rows[0];
      return row ? { ...row, joinedAt: new Date(row.joinedAt) } : null;
    },

    async group(id) {
      const row = (
        await db.execute<{
          id: string;
          name: string;
          externalId: string | null;
          email: string | null;
          createdAt: number;
        }>(
          sql`select id, display_name as name, external_id as "externalId", email, created_at as "createdAt"
              from scim_group where id = ${id}`,
        )
      ).rows[0];
      return row ? { ...row, source: "scim", createdAt: new Date(row.createdAt) } : null;
    },

    async linkedRole(orgId, groupId) {
      return (
        (
          await db
            .select({ role: orgGroup.role })
            .from(orgGroup)
            .where(and(eq(orgGroup.organizationId, orgId), eq(orgGroup.groupId, groupId)))
            .limit(1)
        )[0]?.role ?? null
      );
    },

    async groupPage(orgId, params) {
      const where = sql`og.organization_id = ${orgId}
        ${params.userId ? sql`and g.id in ${activeGroupsOf(sql`${params.userId}`)}` : sql``}
        and ${containing(params.q, sql`g.display_name`, sql`g.email`)}`;
      const rows = (
        await db.execute<{
          id: string;
          name: string;
          externalId: string | null;
          email: string | null;
          createdAt: number;
          role: OrgRole;
          linkedAt: number;
          memberCount: number;
        }>(sql`
        select g.id, g.display_name as name, g.external_id as "externalId", g.email,
               g.created_at as "createdAt", og.role, og.created_at as "linkedAt",
               ${memberCountOf(sql`g.id`)} as "memberCount"
          from org_group og join scim_group g on g.id = og.group_id
         where ${where} and ${after(params.cursor, sql`lower(g.display_name)`, sql`g.id`)}
         order by lower(g.display_name), g.id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(sql`
        select count(*)::int as n from org_group og join scim_group g on g.id = og.group_id
         where ${where}`)
      ).rows[0];
      return pageOf(
        rows.map((row) => ({
          ...row,
          source: "scim" as const,
          createdAt: new Date(row.createdAt),
          linkedAt: new Date(row.linkedAt),
        })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    async groupMemberPage(groupId, params) {
      const where = sql`u.id in (select su.user_id from scim_group_member gm
                                    join scim_user su on su.id = gm.scim_user_id
                                   where gm.group_id = ${groupId} and su.active = true)
        and ${containing(params.q, sql`u.name`, sql`u.email`)}`;
      const rows = (
        await db.execute<{ id: string; name: string; email: string }>(sql`
        select u.id, u.name, u.email from "user" u
         where ${where} and ${after(params.cursor, sql`lower(u.name)`, sql`u.id`)}
         order by lower(u.name), u.id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(sql`select count(*)::int as n from "user" u where ${where}`)
      ).rows[0];
      return pageOf(
        rows.map((row) => ({ ...row, source: "scim" as const })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    async groupIdsOf(orgId, userId) {
      return (
        await db.execute<{ id: string }>(sql`
          select group_id as id from org_group
           where organization_id = ${orgId} and group_id in ${activeGroupsOf(sql`${userId}`)}`)
      ).rows.map((row) => row.id);
    },

    async memberCount(groupId) {
      return (
        (await db.execute<{ n: number }>(sql`select ${memberCountOf(sql`${groupId}`)} as n`))
          .rows[0]?.n ?? 0
      );
    },

    async directoryPeoplePage(orgId, params) {
      const where = sql`exists (select 1 from scim_user su where su.user_id = u.id and su.active = true)
        and ${containing(params.q, sql`u.name`, sql`u.email`)}`;
      const rows = (
        await db.execute<{
          id: string;
          name: string;
          email: string;
          role: OrgRole | null;
        }>(sql`
        select u.id, u.name, u.email,
               (select m.role from member m
                 where m.organization_id = ${orgId} and m.user_id = u.id) as role
          from "user" u
         where ${where} and ${after(params.cursor, sql`lower(u.name)`, sql`u.id`)}
         order by lower(u.name), u.id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(sql`select count(*)::int as n from "user" u where ${where}`)
      ).rows[0];
      return pageOf(
        rows.map((row) => ({ ...row, source: "scim" as const })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    async directoryGroupPage(orgId, params) {
      const where = containing(params.q, sql`g.display_name`, sql`g.email`);
      const rows = (
        await db.execute<{
          id: string;
          name: string;
          externalId: string | null;
          email: string | null;
          createdAt: number;
          memberCount: number;
          role: OrgRole | null;
        }>(sql`
        select g.id, g.display_name as name, g.external_id as "externalId", g.email,
               g.created_at as "createdAt", ${memberCountOf(sql`g.id`)} as "memberCount",
               (select og.role from org_group og
                 where og.organization_id = ${orgId} and og.group_id = g.id) as role
          from scim_group g
         where ${where} and ${after(params.cursor, sql`lower(g.display_name)`, sql`g.id`)}
         order by lower(g.display_name), g.id
         ${pageLimit(params)}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from scim_group g where ${where}`,
        )
      ).rows[0];
      return pageOf(
        rows.map((row) => ({
          ...row,
          source: "scim" as const,
          createdAt: new Date(row.createdAt),
        })),
        params,
        total?.n ?? 0,
        (row) => [row.name.toLowerCase(), row.id],
      );
    },

    async linkGroup(orgId, groupId, role) {
      await db
        .insert(orgGroup)
        .values({ organizationId: orgId, groupId, role })
        .onConflictDoUpdate({ target: [orgGroup.organizationId, orgGroup.groupId], set: { role } });
    },

    async unlinkGroup(orgId, groupId) {
      await db.transaction(async (tx) => {
        await tx
          .delete(orgGroup)
          .where(and(eq(orgGroup.organizationId, orgId), eq(orgGroup.groupId, groupId)));
        const spaces = tx
          .select({ id: space.id })
          .from(space)
          .where(eq(space.organizationId, orgId));
        await tx
          .delete(spaceMember)
          .where(
            and(
              eq(spaceMember.subjectKind, "group"),
              eq(spaceMember.subjectId, groupId),
              inArray(spaceMember.spaceId, spaces),
            ),
          );
      });
    },

    async org(orgId) {
      return (
        (
          await db.select(orgColumns).from(organization).where(eq(organization.id, orgId)).limit(1)
        )[0] ?? null
      );
    },

    async orgsOf(userId) {
      const owners = await db
        .select({ orgId: member.organizationId, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.role, "owner"))
        .orderBy(asc(member.createdAt));
      const ownerName = new Map<string, string>();
      for (const owner of owners)
        if (!ownerName.has(owner.orgId)) ownerName.set(owner.orgId, owner.name);
      return (
        await db
          .select({ ...orgColumns, role: member.role })
          .from(member)
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .where(eq(member.userId, userId))
          .orderBy(desc(sql`${organization.kind} = 'personal'`), asc(organization.name))
      ).map((row) => ({
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
      await db
        .update(member)
        .set({ directRole: "owner" })
        .where(and(eq(member.organizationId, created.id), eq(member.userId, ownerId)));
      return { id: created.id, name: created.name, kind: "team", createdAt: created.createdAt };
    },

    async renameOrg(orgId, name) {
      await db.update(organization).set({ name }).where(eq(organization.id, orgId));
    },

    // Everything else in the org goes with its row through the tables' cascades.
    async deleteOrg(orgId) {
      await db.transaction(async (tx) => {
        await tx
          .update(session)
          .set({ activeOrganizationId: null })
          .where(eq(session.activeOrganizationId, orgId));
        await tx.delete(organization).where(eq(organization.id, orgId));
      });
    },

    user: userOf,

    async userByEmail(email) {
      const row = (
        await db
          .select({ id: user.id })
          .from(user)
          .where(eq(sql`lower(${user.email})`, email.toLowerCase()))
          .limit(1)
      )[0];
      return row ? await userOf(row.id) : null;
    },

    roleIn,

    async members(orgId) {
      return (
        await db.execute<{
          id: string;
          name: string;
          email: string;
          role: OrgRole;
          joinedAt: number;
          source: RecordSource;
        }>(sql`
          select u.id, u.name, u.email, m.role, m.created_at as "joinedAt",
                 ${sourceOf(sql`u.id`)} as source
            from member m join "user" u on u.id = m.user_id
           where m.organization_id = ${orgId}
           order by m.created_at`)
      ).rows.map((row) => ({ ...row, joinedAt: new Date(row.joinedAt) }));
    },

    async addMember(orgId, userId, role) {
      await auth.api.addMember({ body: { userId, role, organizationId: orgId } });
      await db
        .update(member)
        .set({ directRole: role })
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
      await db
        .delete(orgFormerMember)
        .where(and(eq(orgFormerMember.organizationId, orgId), eq(orgFormerMember.userId, userId)));
    },

    async setDirectRole(orgId, userId, role) {
      await db
        .update(member)
        .set({ directRole: role })
        .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
      // Someone not a member yet joins with it.
      if (role && !(await roleIn(orgId, userId))) {
        await db.insert(member).values({
          id: ulid(),
          organizationId: orgId,
          userId,
          role,
          directRole: role,
          createdAt: new Date(),
        });
        await db
          .delete(orgFormerMember)
          .where(
            and(eq(orgFormerMember.organizationId, orgId), eq(orgFormerMember.userId, userId)),
          );
      }
    },

    directOwnerCount,

    async settle(orgId, at, userIds) {
      const none: Settled = { joined: [], left: [], changed: false };
      if (userIds?.length === 0 || !(await isTeam(orgId))) return none;
      const among = (column: SQL) =>
        userIds
          ? sql`and ${column} in (${sql.join(
              userIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;
      return db.transaction(async (tx) => {
        const wanted = (
          await tx.execute<{ userId: string; rank: number }>(sql`
          select user_id as "userId", max(rank) as rank from (
            select m.user_id, case m.direct_role when 'owner' then 2 else 1 end as rank
              from member m
             where m.organization_id = ${orgId} and m.direct_role is not null
            union all
            select su.user_id, case og.role when 'owner' then 2 else 1 end
              from org_group og
              join scim_group_member gm on gm.group_id = og.group_id
              join scim_user su on su.id = gm.scim_user_id and su.active = true
             where og.organization_id = ${orgId}
          ) where 1 = 1 ${among(sql`user_id`)}
          group by user_id`)
        ).rows;
        const current = new Map(
          (
            await tx.execute<{ userId: string; role: OrgRole }>(sql`
              select user_id as "userId", role from member
               where organization_id = ${orgId} ${among(sql`user_id`)}`)
          ).rows.map((row) => [row.userId, row.role]),
        );
        const settled: Settled = { joined: [], left: [], changed: false };
        for (const { userId, rank } of wanted) {
          const role: OrgRole = rank >= RANK.owner ? "owner" : "member";
          const now = current.get(userId);
          current.delete(userId);
          if (now === role) continue;
          settled.changed = true;
          if (now) {
            await tx
              .update(member)
              .set({ role })
              .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
            continue;
          }
          await tx
            .insert(member)
            .values({ id: ulid(), organizationId: orgId, userId, role, createdAt: at });
          await tx
            .delete(orgFormerMember)
            .where(
              and(eq(orgFormerMember.organizationId, orgId), eq(orgFormerMember.userId, userId)),
            );
          settled.joined.push(userId);
        }
        const spaces = tx
          .select({ id: space.id })
          .from(space)
          .where(eq(space.organizationId, orgId));
        for (const userId of current.keys()) {
          settled.changed = true;
          settled.left.push(userId);
          await tx
            .delete(member)
            .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
          await tx
            .delete(spaceMember)
            .where(
              and(
                eq(spaceMember.subjectKind, "user"),
                eq(spaceMember.subjectId, userId),
                inArray(spaceMember.spaceId, spaces),
              ),
            );
          await tx
            .insert(orgFormerMember)
            .values({ organizationId: orgId, userId, removedAt: at })
            .onConflictDoUpdate({
              target: [orgFormerMember.organizationId, orgFormerMember.userId],
              set: { removedAt: at },
            });
        }
        return settled;
      });
    },

    async orgsToSettle(userId) {
      return (
        await db.execute<{ id: string }>(sql`
          select m.organization_id as id from member m
            join organization o on o.id = m.organization_id
           where m.user_id = ${userId} and o.kind = 'team'
          union
          select og.organization_id from org_group og
            join scim_group_member gm on gm.group_id = og.group_id
            join scim_user su on su.id = gm.scim_user_id
           where su.user_id = ${userId}`)
      ).rows.map((row) => row.id);
    },

    async clearDirectRoles(userId) {
      const rows = await db
        .select({ orgId: member.organizationId, directRole: member.directRole })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(member.userId, userId),
            eq(organization.kind, "team"),
            isNotNull(member.directRole),
          ),
        );
      for (const row of rows) {
        if (row.directRole === "owner" && (await directOwnerCount(row.orgId)) <= 1) continue;
        await db
          .update(member)
          .set({ directRole: null })
          .where(and(eq(member.organizationId, row.orgId), eq(member.userId, userId)));
      }
    },

    async formerMembers(orgId, userIds) {
      if (userIds.length === 0) return [];
      return (
        await db
          .select({ userId: orgFormerMember.userId })
          .from(orgFormerMember)
          .where(
            and(
              eq(orgFormerMember.organizationId, orgId),
              inArray(orgFormerMember.userId, userIds),
            ),
          )
      ).map((row) => row.userId);
    },
  };
}

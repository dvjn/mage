// Artifacts, their versions and files, the threads that used them, and the settings on making them public, in the database.

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { type SettingScope, scopedOn } from "@/server/spaces/scope.ts";
import { space } from "@/server/spaces/schema.ts";

import {
  artifact,
  artifactAsset,
  artifactGroupShare,
  artifactPersonShare,
  artifactSetting,
  artifactThreadUse,
  artifactVersion,
} from "./schema.ts";
import type { ArtifactStore, VersionRecord } from "./service.ts";

const artifactColumns = {
  id: artifact.id,
  spaceId: artifact.spaceId,
  createdInThreadId: artifact.createdInThreadId,
  sharing: artifact.sharing,
  orgRole: artifact.orgRole,
  version: artifact.version,
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
};

// The ids of the directory groups the user is active in.
function activeGroupsOf(userId: string) {
  return sql`(select gm.group_id from scim_group_member gm
                join scim_user su on su.id = gm.scim_user_id
               where su.user_id = ${userId} and su.active = true)`;
}

const versionColumns = {
  version: artifactVersion.version,
  label: artifactVersion.label,
  title: artifactVersion.title,
  description: artifactVersion.description,
  icon: artifactVersion.icon,
  createdAt: artifactVersion.createdAt,
  threadId: artifactVersion.threadId,
};

const settings = scopedOn(artifactSetting);

export function createArtifactStore(db: Db): ArtifactStore {
  // Whether the scope lets artifacts be made public, where it set so.
  async function publicAllowed(scope: SettingScope) {
    return (
      await db
        .select({ allowed: artifactSetting.publicAllowed })
        .from(artifactSetting)
        .where(settings.at(scope))
        .limit(1)
    )[0]?.allowed;
  }

  async function setPublicAllowed(scope: SettingScope, allowed: boolean) {
    await db
      .insert(artifactSetting)
      .values({ ...settings.of(scope), publicAllowed: allowed })
      .onConflictDoUpdate({ ...settings.conflict(scope), set: { publicAllowed: allowed } });
  }

  async function putAssets(
    id: string,
    assets: { name: string; contentType: string; data: Buffer }[],
  ) {
    for (const asset of assets) {
      await db
        .insert(artifactAsset)
        .values({ artifactId: id, ...asset })
        .onConflictDoUpdate({
          target: [artifactAsset.artifactId, artifactAsset.name],
          set: { contentType: asset.contentType, data: asset.data, createdAt: new Date() },
        });
    }
  }

  async function removeAssets(id: string, names: readonly string[]) {
    if (names.length === 0) return;
    await db
      .delete(artifactAsset)
      .where(and(eq(artifactAsset.artifactId, id), inArray(artifactAsset.name, [...names])));
  }

  return {
    async create({ id, spaceId, threadId, version, assets }) {
      await db.transaction(async () => {
        await db.insert(artifact).values({ id, spaceId, createdInThreadId: threadId, version: 1 });
        await db
          .insert(artifactVersion)
          .values({ artifactId: id, version: 1, threadId, ...version });
        await db
          .insert(artifactThreadUse)
          .values({ artifactId: id, threadId, guestsSharedAt: new Date() })
          .onConflictDoNothing();
        await putAssets(id, assets);
      });
    },

    async find(id) {
      return (
        (await db.select(artifactColumns).from(artifact).where(eq(artifact.id, id)).limit(1))[0] ??
        null
      );
    },

    async inThread(threadId) {
      return await db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactThreadUse, eq(artifactThreadUse.artifactId, artifact.id))
        .where(eq(artifactThreadUse.threadId, threadId))
        .orderBy(asc(artifact.createdAt), asc(artifact.id));
    },

    async inSpace(spaceId) {
      return await db
        .select(artifactColumns)
        .from(artifact)
        .where(eq(artifact.spaceId, spaceId))
        .orderBy(desc(artifact.updatedAt), desc(artifact.id));
    },

    async inOrg(orgId) {
      return await db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(space, eq(space.id, artifact.spaceId))
        .where(eq(space.organizationId, orgId))
        .orderBy(desc(artifact.updatedAt), desc(artifact.id));
    },

    async use(id, threadId) {
      await db.insert(artifactThreadUse).values({ artifactId: id, threadId }).onConflictDoNothing();
    },

    async usedIn(id) {
      return (
        await db
          .select({ threadId: artifactThreadUse.threadId })
          .from(artifactThreadUse)
          .where(eq(artifactThreadUse.artifactId, id))
          .orderBy(asc(artifactThreadUse.createdAt), asc(artifactThreadUse.threadId))
      ).map((row) => row.threadId);
    },

    async guestShares(id) {
      return (
        await db
          .select({ threadId: artifactThreadUse.threadId })
          .from(artifactThreadUse)
          .where(
            and(eq(artifactThreadUse.artifactId, id), isNotNull(artifactThreadUse.guestsSharedAt)),
          )
      ).map((row) => row.threadId);
    },

    async setGuestShare(id, threadId, by) {
      await db
        .update(artifactThreadUse)
        .set(
          by === null
            ? { guestsSharedAt: null, guestsSharedBy: null }
            : { guestsSharedAt: new Date(), guestsSharedBy: by },
        )
        .where(and(eq(artifactThreadUse.artifactId, id), eq(artifactThreadUse.threadId, threadId)));
    },

    async people(id) {
      return await db
        .select({ userId: artifactPersonShare.userId, role: artifactPersonShare.role })
        .from(artifactPersonShare)
        .where(eq(artifactPersonShare.artifactId, id))
        .orderBy(asc(artifactPersonShare.createdAt), asc(artifactPersonShare.userId));
    },

    async personRole(id, userId) {
      return (
        (
          await db
            .select({ role: artifactPersonShare.role })
            .from(artifactPersonShare)
            .where(
              and(eq(artifactPersonShare.artifactId, id), eq(artifactPersonShare.userId, userId)),
            )
            .limit(1)
        )[0]?.role ?? null
      );
    },

    async sharedWith(userId) {
      const personal = await db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactPersonShare, eq(artifactPersonShare.artifactId, artifact.id))
        .where(eq(artifactPersonShare.userId, userId));
      const grouped = await db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactGroupShare, eq(artifactGroupShare.artifactId, artifact.id))
        .where(sql`${artifactGroupShare.groupId} in ${activeGroupsOf(userId)}`);
      const seen = new Set<string>();
      return [...personal, ...grouped]
        .filter((record) => !seen.has(record.id) && !!seen.add(record.id))
        .toSorted(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1),
        );
    },

    async groups(id) {
      return await db
        .select({ groupId: artifactGroupShare.groupId, role: artifactGroupShare.role })
        .from(artifactGroupShare)
        .where(eq(artifactGroupShare.artifactId, id))
        .orderBy(asc(artifactGroupShare.createdAt), asc(artifactGroupShare.groupId));
    },

    async groupRole(id, userId) {
      const row = (
        await db.execute<{ edit: boolean | null }>(sql`
        select bool_or(gs.role = 'edit') as edit
          from artifact_group_share gs
          join artifact a on a.id = gs.artifact_id
          join space s on s.id = a.space_id
          join org_group og on og.organization_id = s.organization_id and og.group_id = gs.group_id
         where gs.artifact_id = ${id} and gs.group_id in ${activeGroupsOf(userId)}`)
      ).rows[0];
      return row?.edit === null || row === undefined ? null : row.edit ? "edit" : "view";
    },

    async setGroupShare(id, groupId, by, role) {
      if (by === null) {
        await db
          .delete(artifactGroupShare)
          .where(
            and(eq(artifactGroupShare.artifactId, id), eq(artifactGroupShare.groupId, groupId)),
          );
        return;
      }
      await db
        .insert(artifactGroupShare)
        .values({ artifactId: id, groupId, sharedBy: by, role })
        .onConflictDoUpdate({
          target: [artifactGroupShare.artifactId, artifactGroupShare.groupId],
          set: { role },
        });
    },

    async setPersonShare(id, userId, by, role) {
      if (by === null) {
        await db
          .delete(artifactPersonShare)
          .where(
            and(eq(artifactPersonShare.artifactId, id), eq(artifactPersonShare.userId, userId)),
          );
        return;
      }
      await db
        .insert(artifactPersonShare)
        .values({ artifactId: id, userId, sharedBy: by, role })
        .onConflictDoUpdate({
          target: [artifactPersonShare.artifactId, artifactPersonShare.userId],
          set: { role },
        });
    },

    async version(id, number): Promise<(VersionRecord & { html: string }) | null> {
      return (
        (
          await db
            .select({ ...versionColumns, html: artifactVersion.html })
            .from(artifactVersion)
            .where(and(eq(artifactVersion.artifactId, id), eq(artifactVersion.version, number)))
            .limit(1)
        )[0] ?? null
      );
    },

    async versions(id) {
      return await db
        .select(versionColumns)
        .from(artifactVersion)
        .where(eq(artifactVersion.artifactId, id))
        .orderBy(desc(artifactVersion.version));
    },

    async addVersion(id, basedOn, { version, threadId, assets, removed }) {
      return db.transaction(async () => {
        const current = (
          await db
            .select({ version: artifact.version })
            .from(artifact)
            .where(eq(artifact.id, id))
            .limit(1)
        )[0];
        if (!current) return null;
        if (current.version !== basedOn) return { stale: current.version };
        const number = current.version + 1;
        await db
          .insert(artifactVersion)
          .values({ artifactId: id, version: number, threadId, ...version });
        await db
          .insert(artifactThreadUse)
          .values({ artifactId: id, threadId })
          .onConflictDoNothing();
        await db.update(artifact).set({ version: number }).where(eq(artifact.id, id));
        await removeAssets(id, removed);
        await putAssets(id, assets);
        return { version: number };
      });
    },

    async assets(id) {
      return await db
        .select({
          name: artifactAsset.name,
          contentType: artifactAsset.contentType,
          size: sql<number>`length(${artifactAsset.data})`,
        })
        .from(artifactAsset)
        .where(eq(artifactAsset.artifactId, id))
        .orderBy(asc(artifactAsset.name));
    },

    async asset(id, name) {
      return (
        (
          await db
            .select({ contentType: artifactAsset.contentType, data: artifactAsset.data })
            .from(artifactAsset)
            .where(and(eq(artifactAsset.artifactId, id), eq(artifactAsset.name, name)))
            .limit(1)
        )[0] ?? null
      );
    },

    async setSharing(id, sharing) {
      await db.update(artifact).set({ sharing }).where(eq(artifact.id, id));
    },

    async setOrgRole(id, orgRole) {
      await db.update(artifact).set({ orgRole }).where(eq(artifact.id, id));
    },

    async delete(id) {
      await db.delete(artifact).where(eq(artifact.id, id));
    },

    // An org without a setting does not allow it; a space without one does.
    orgPublicAllowed: async (orgId) => (await publicAllowed({ orgId })) ?? false,
    setOrgPublicAllowed: async (orgId, allowed) => setPublicAllowed({ orgId }, allowed),
    spacePublicAllowed: async (spaceId) => (await publicAllowed({ spaceId })) ?? true,
    setSpacePublicAllowed: async (spaceId, allowed) => setPublicAllowed({ spaceId }, allowed),
  };
}

// Artifacts, their versions and files, the threads that used them, and the settings on making them public, in the database.

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { space } from "@/server/spaces/schema.ts";

import {
  artifact,
  artifactAsset,
  artifactGroupShare,
  artifactOrgSetting,
  artifactPersonShare,
  artifactSpaceSetting,
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
               where su.user_id = ${userId} and su.active = 1)`;
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

export function createArtifactStore(db: Db): ArtifactStore {
  function putAssets(id: string, assets: { name: string; contentType: string; data: Buffer }[]) {
    for (const asset of assets) {
      db.insert(artifactAsset)
        .values({ artifactId: id, ...asset })
        .onConflictDoUpdate({
          target: [artifactAsset.artifactId, artifactAsset.name],
          set: { contentType: asset.contentType, data: asset.data, createdAt: new Date() },
        })
        .run();
    }
  }

  function removeAssets(id: string, names: readonly string[]) {
    if (names.length === 0) return;
    db.delete(artifactAsset)
      .where(and(eq(artifactAsset.artifactId, id), inArray(artifactAsset.name, [...names])))
      .run();
  }

  return {
    create({ id, spaceId, threadId, version, assets }) {
      db.transaction(() => {
        db.insert(artifact).values({ id, spaceId, createdInThreadId: threadId, version: 1 }).run();
        db.insert(artifactVersion)
          .values({ artifactId: id, version: 1, threadId, ...version })
          .run();
        db.insert(artifactThreadUse)
          .values({ artifactId: id, threadId, guestsSharedAt: new Date() })
          .onConflictDoNothing()
          .run();
        putAssets(id, assets);
      });
    },

    find(id) {
      return db.select(artifactColumns).from(artifact).where(eq(artifact.id, id)).get() ?? null;
    },

    inThread(threadId) {
      return db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactThreadUse, eq(artifactThreadUse.artifactId, artifact.id))
        .where(eq(artifactThreadUse.threadId, threadId))
        .orderBy(asc(artifact.createdAt), asc(artifact.id))
        .all();
    },

    inSpace(spaceId) {
      return db
        .select(artifactColumns)
        .from(artifact)
        .where(eq(artifact.spaceId, spaceId))
        .orderBy(desc(artifact.updatedAt), desc(artifact.id))
        .all();
    },

    inOrg(orgId) {
      return db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(space, eq(space.id, artifact.spaceId))
        .where(eq(space.organizationId, orgId))
        .orderBy(desc(artifact.updatedAt), desc(artifact.id))
        .all();
    },

    use(id, threadId) {
      db.insert(artifactThreadUse).values({ artifactId: id, threadId }).onConflictDoNothing().run();
    },

    usedIn(id) {
      return db
        .select({ threadId: artifactThreadUse.threadId })
        .from(artifactThreadUse)
        .where(eq(artifactThreadUse.artifactId, id))
        .orderBy(asc(artifactThreadUse.createdAt), asc(artifactThreadUse.threadId))
        .all()
        .map((row) => row.threadId);
    },

    guestShares(id) {
      return db
        .select({ threadId: artifactThreadUse.threadId })
        .from(artifactThreadUse)
        .where(
          and(eq(artifactThreadUse.artifactId, id), isNotNull(artifactThreadUse.guestsSharedAt)),
        )
        .all()
        .map((row) => row.threadId);
    },

    setGuestShare(id, threadId, by) {
      db.update(artifactThreadUse)
        .set(
          by === null
            ? { guestsSharedAt: null, guestsSharedBy: null }
            : { guestsSharedAt: new Date(), guestsSharedBy: by },
        )
        .where(and(eq(artifactThreadUse.artifactId, id), eq(artifactThreadUse.threadId, threadId)))
        .run();
    },

    people(id) {
      return db
        .select({ userId: artifactPersonShare.userId, role: artifactPersonShare.role })
        .from(artifactPersonShare)
        .where(eq(artifactPersonShare.artifactId, id))
        .orderBy(asc(artifactPersonShare.createdAt), asc(artifactPersonShare.userId))
        .all();
    },

    personRole(id, userId) {
      return (
        db
          .select({ role: artifactPersonShare.role })
          .from(artifactPersonShare)
          .where(
            and(eq(artifactPersonShare.artifactId, id), eq(artifactPersonShare.userId, userId)),
          )
          .get()?.role ?? null
      );
    },

    sharedWith(userId) {
      const personal = db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactPersonShare, eq(artifactPersonShare.artifactId, artifact.id))
        .where(eq(artifactPersonShare.userId, userId))
        .all();
      const grouped = db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(artifactGroupShare, eq(artifactGroupShare.artifactId, artifact.id))
        .where(sql`${artifactGroupShare.groupId} in ${activeGroupsOf(userId)}`)
        .all();
      const seen = new Set<string>();
      return [...personal, ...grouped]
        .filter((record) => !seen.has(record.id) && !!seen.add(record.id))
        .toSorted(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1),
        );
    },

    groups(id) {
      return db
        .select({ groupId: artifactGroupShare.groupId, role: artifactGroupShare.role })
        .from(artifactGroupShare)
        .where(eq(artifactGroupShare.artifactId, id))
        .orderBy(asc(artifactGroupShare.createdAt), asc(artifactGroupShare.groupId))
        .all();
    },

    groupRole(id, userId) {
      const row = db.get<{ edit: number | null }>(sql`
        select max(gs.role = 'edit') as edit
          from artifact_group_share gs
          join artifact a on a.id = gs.artifact_id
          join space s on s.id = a.space_id
          join org_group og on og.organization_id = s.organization_id and og.group_id = gs.group_id
         where gs.artifact_id = ${id} and gs.group_id in ${activeGroupsOf(userId)}`);
      return row?.edit === null || row === undefined ? null : row.edit === 1 ? "edit" : "view";
    },

    setGroupShare(id, groupId, by, role) {
      if (by === null) {
        db.delete(artifactGroupShare)
          .where(
            and(eq(artifactGroupShare.artifactId, id), eq(artifactGroupShare.groupId, groupId)),
          )
          .run();
        return;
      }
      db.insert(artifactGroupShare)
        .values({ artifactId: id, groupId, sharedBy: by, role })
        .onConflictDoUpdate({
          target: [artifactGroupShare.artifactId, artifactGroupShare.groupId],
          set: { role },
        })
        .run();
    },

    setPersonShare(id, userId, by, role) {
      if (by === null) {
        db.delete(artifactPersonShare)
          .where(
            and(eq(artifactPersonShare.artifactId, id), eq(artifactPersonShare.userId, userId)),
          )
          .run();
        return;
      }
      db.insert(artifactPersonShare)
        .values({ artifactId: id, userId, sharedBy: by, role })
        .onConflictDoUpdate({
          target: [artifactPersonShare.artifactId, artifactPersonShare.userId],
          set: { role },
        })
        .run();
    },

    version(id, number): (VersionRecord & { html: string }) | null {
      return (
        db
          .select({ ...versionColumns, html: artifactVersion.html })
          .from(artifactVersion)
          .where(and(eq(artifactVersion.artifactId, id), eq(artifactVersion.version, number)))
          .get() ?? null
      );
    },

    versions(id) {
      return db
        .select(versionColumns)
        .from(artifactVersion)
        .where(eq(artifactVersion.artifactId, id))
        .orderBy(desc(artifactVersion.version))
        .all();
    },

    addVersion(id, basedOn, { version, threadId, assets, removed }) {
      return db.transaction(() => {
        const current = db
          .select({ version: artifact.version })
          .from(artifact)
          .where(eq(artifact.id, id))
          .get();
        if (!current) return null;
        if (current.version !== basedOn) return { stale: current.version };
        const number = current.version + 1;
        db.insert(artifactVersion)
          .values({ artifactId: id, version: number, threadId, ...version })
          .run();
        db.insert(artifactThreadUse)
          .values({ artifactId: id, threadId })
          .onConflictDoNothing()
          .run();
        db.update(artifact).set({ version: number }).where(eq(artifact.id, id)).run();
        removeAssets(id, removed);
        putAssets(id, assets);
        return { version: number };
      });
    },

    assets(id) {
      return db
        .select({
          name: artifactAsset.name,
          contentType: artifactAsset.contentType,
          size: sql<number>`length(${artifactAsset.data})`,
        })
        .from(artifactAsset)
        .where(eq(artifactAsset.artifactId, id))
        .orderBy(asc(artifactAsset.name))
        .all();
    },

    asset(id, name) {
      return (
        db
          .select({ contentType: artifactAsset.contentType, data: artifactAsset.data })
          .from(artifactAsset)
          .where(and(eq(artifactAsset.artifactId, id), eq(artifactAsset.name, name)))
          .get() ?? null
      );
    },

    setSharing(id, sharing) {
      db.update(artifact).set({ sharing }).where(eq(artifact.id, id)).run();
    },

    setOrgRole(id, orgRole) {
      db.update(artifact).set({ orgRole }).where(eq(artifact.id, id)).run();
    },

    delete(id) {
      db.delete(artifact).where(eq(artifact.id, id)).run();
    },

    orgPublicAllowed(orgId) {
      const row = db
        .select({ allowed: artifactOrgSetting.publicAllowed })
        .from(artifactOrgSetting)
        .where(eq(artifactOrgSetting.organizationId, orgId))
        .get();
      return row?.allowed ?? false;
    },

    setOrgPublicAllowed(orgId, allowed) {
      db.insert(artifactOrgSetting)
        .values({ organizationId: orgId, publicAllowed: allowed })
        .onConflictDoUpdate({
          target: artifactOrgSetting.organizationId,
          set: { publicAllowed: allowed },
        })
        .run();
    },

    spacePublicAllowed(spaceId) {
      const row = db
        .select({ allowed: artifactSpaceSetting.publicAllowed })
        .from(artifactSpaceSetting)
        .where(eq(artifactSpaceSetting.spaceId, spaceId))
        .get();
      return row?.allowed ?? true;
    },

    setSpacePublicAllowed(spaceId, allowed) {
      db.insert(artifactSpaceSetting)
        .values({ spaceId, publicAllowed: allowed })
        .onConflictDoUpdate({
          target: artifactSpaceSetting.spaceId,
          set: { publicAllowed: allowed },
        })
        .run();
    },
  };
}

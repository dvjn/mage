// Artifacts, their versions and files, and the settings on making them public, in the database.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";

import {
  artifact,
  artifactAsset,
  artifactOrgSetting,
  artifactSpaceSetting,
  artifactVersion,
} from "./schema.ts";
import type { ArtifactStore, VersionRecord } from "./service.ts";

const artifactColumns = {
  id: artifact.id,
  threadId: artifact.threadId,
  sharing: artifact.sharing,
  version: artifact.version,
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
};

const versionColumns = {
  version: artifactVersion.version,
  label: artifactVersion.label,
  title: artifactVersion.title,
  description: artifactVersion.description,
  icon: artifactVersion.icon,
  createdAt: artifactVersion.createdAt,
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
    create({ id, threadId, version, assets }) {
      db.transaction(() => {
        db.insert(artifact).values({ id, threadId, version: 1 }).run();
        db.insert(artifactVersion)
          .values({ artifactId: id, version: 1, ...version })
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
        .where(eq(artifact.threadId, threadId))
        .orderBy(asc(artifact.createdAt), asc(artifact.id))
        .all();
    },

    inOrg(orgId) {
      return db
        .select(artifactColumns)
        .from(artifact)
        .innerJoin(thread, eq(thread.id, artifact.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .where(eq(space.organizationId, orgId))
        .orderBy(desc(artifact.updatedAt), desc(artifact.id))
        .all();
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

    addVersion(id, basedOn, { version, assets, removed }) {
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
          .values({ artifactId: id, version: number, ...version })
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

import { and, asc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";

import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";

import type { Scope, Skill, SkillSource, SkillStore } from "./service.ts";
import { skill, skillSource, spaceSkillSetting, spaceSkillSourceSetting } from "./schema.ts";

const sourceColumns = {
  id: skillSource.id,
  orgId: skillSource.organizationId,
  spaceId: skillSource.spaceId,
  label: skillSource.label,
  url: skillSource.url,
  ref: skillSource.ref,
  resolvedRef: skillSource.resolvedRef,
  subpath: skillSource.subpath,
  commit: skillSource.commit,
  fetchedAt: skillSource.fetchedAt,
  enabled: skillSource.enabled,
  tokenKeyVersion: skillSource.tokenKeyVersion,
  createdBy: skillSource.createdBy,
  createdAt: skillSource.createdAt,
};

function sourceOf({
  tokenKeyVersion,
  ...row
}: Omit<SkillSource, "hasToken"> & { tokenKeyVersion: number | null }): SkillSource {
  return { ...row, hasToken: tokenKeyVersion !== null };
}

const skillColumns = {
  id: skill.id,
  orgId: skill.organizationId,
  spaceId: skill.spaceId,
  sourceId: skill.sourceId,
  path: skill.path,
  name: skill.name,
  description: skill.description,
  body: skill.body,
  files: skill.files,
  enabled: skill.enabled,
  createdBy: skill.createdBy,
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt,
};

// The rows of the scope: a space's, or the org's own.
function scoped(table: typeof skill | typeof skillSource, scope: Scope) {
  return scope.spaceId
    ? eq(table.spaceId, scope.spaceId)
    : and(eq(table.organizationId, scope.orgId), isNull(table.spaceId));
}

// What a sealed token is bound to: its source.
function tokenContext(sourceId: string) {
  return `skill-source:${sourceId}`;
}

export function createSkillStore(db: Db, cipher: Cipher): SkillStore {
  return {
    createSource({ orgId, ...rest }) {
      return sourceOf(
        db
          .insert(skillSource)
          .values({ id: ulid(), organizationId: orgId, fetchedAt: new Date(), ...rest })
          .returning(sourceColumns)
          .get(),
      );
    },

    findSource(id) {
      const row = db.select(sourceColumns).from(skillSource).where(eq(skillSource.id, id)).get();
      return row ? sourceOf(row) : null;
    },

    sources(scope) {
      return db
        .select(sourceColumns)
        .from(skillSource)
        .where(scoped(skillSource, scope))
        .orderBy(asc(skillSource.id))
        .all()
        .map(sourceOf);
    },

    updateSource(id, changes) {
      db.update(skillSource).set(changes).where(eq(skillSource.id, id)).run();
    },

    deleteSource(id) {
      db.delete(skillSource).where(eq(skillSource.id, id)).run();
    },

    token(id) {
      const row = db
        .select({ keyVersion: skillSource.tokenKeyVersion, data: skillSource.token })
        .from(skillSource)
        .where(eq(skillSource.id, id))
        .get();
      if (!row || row.keyVersion === null || !row.data) return null;
      return cipher
        .open({ keyVersion: row.keyVersion, data: row.data }, tokenContext(id))
        .toString();
    },

    setToken(id, token) {
      const sealed = token ? cipher.seal(Buffer.from(token), tokenContext(id)) : null;
      db.update(skillSource)
        .set({ tokenKeyVersion: sealed?.keyVersion ?? null, token: sealed?.data ?? null })
        .where(eq(skillSource.id, id))
        .run();
    },

    create({ orgId, ...rest }) {
      return db
        .insert(skill)
        .values({ id: ulid(), organizationId: orgId, ...rest })
        .returning(skillColumns)
        .get() as Skill;
    },

    find(id) {
      return (db.select(skillColumns).from(skill).where(eq(skill.id, id)).get() as Skill) ?? null;
    },

    inScope(scope) {
      return db
        .select(skillColumns)
        .from(skill)
        .where(scoped(skill, scope))
        .orderBy(asc(skill.name), asc(skill.id))
        .all() as Skill[];
    },

    update(id, changes) {
      db.update(skill).set(changes).where(eq(skill.id, id)).run();
    },

    delete(id) {
      db.delete(skill).where(eq(skill.id, id)).run();
    },

    spaceSourceSettings(spaceId) {
      const rows = db
        .select({ id: spaceSkillSourceSetting.sourceId, enabled: spaceSkillSourceSetting.enabled })
        .from(spaceSkillSourceSetting)
        .where(eq(spaceSkillSourceSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.id, row.enabled]));
    },

    setSpaceSource(spaceId, sourceId, enabled) {
      db.insert(spaceSkillSourceSetting)
        .values({ spaceId, sourceId, enabled })
        .onConflictDoUpdate({
          target: [spaceSkillSourceSetting.spaceId, spaceSkillSourceSetting.sourceId],
          set: { enabled },
        })
        .run();
    },

    spaceSkillSettings(spaceId) {
      const rows = db
        .select({ id: spaceSkillSetting.skillId, enabled: spaceSkillSetting.enabled })
        .from(spaceSkillSetting)
        .where(eq(spaceSkillSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.id, row.enabled]));
    },

    setSpaceSkill(spaceId, skillId, enabled) {
      db.insert(spaceSkillSetting)
        .values({ spaceId, skillId, enabled })
        .onConflictDoUpdate({
          target: [spaceSkillSetting.spaceId, spaceSkillSetting.skillId],
          set: { enabled },
        })
        .run();
    },
  };
}

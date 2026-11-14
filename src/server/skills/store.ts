import { and, asc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";

import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";
import { type SettingScope, scopedOn } from "@/server/spaces/scope.ts";

import type { Scope, Skill, SkillSource, SkillStore } from "./service.ts";
import {
  builtinSkillSetting,
  skill,
  skillSource,
  spaceSkillSetting,
  spaceSkillSourceSetting,
} from "./schema.ts";

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

const builtins = scopedOn(builtinSkillSetting);

export function createSkillStore(db: Db, cipher: Cipher): SkillStore {
  async function builtinSwitches(scope: SettingScope) {
    const rows = await db.select().from(builtinSkillSetting).where(builtins.at(scope));
    return new Map(rows.map((row) => [row.key, row.enabled]));
  }

  async function setBuiltin(scope: SettingScope, key: string, enabled: boolean) {
    await db
      .insert(builtinSkillSetting)
      .values({ ...builtins.of(scope), key, enabled })
      .onConflictDoUpdate({
        ...builtins.conflict(scope, builtinSkillSetting.key),
        set: { enabled },
      });
  }

  return {
    async createSource({ orgId, ...rest }) {
      return sourceOf(
        (
          await db
            .insert(skillSource)
            .values({ id: ulid(), organizationId: orgId, fetchedAt: new Date(), ...rest })
            .returning(sourceColumns)
        )[0]!,
      );
    },

    async findSource(id) {
      const row = (
        await db.select(sourceColumns).from(skillSource).where(eq(skillSource.id, id)).limit(1)
      )[0];
      return row ? sourceOf(row) : null;
    },

    async sources(scope) {
      return (
        await db
          .select(sourceColumns)
          .from(skillSource)
          .where(scoped(skillSource, scope))
          .orderBy(asc(skillSource.id))
      ).map(sourceOf);
    },

    async updateSource(id, changes) {
      await db.update(skillSource).set(changes).where(eq(skillSource.id, id));
    },

    async deleteSource(id) {
      await db.delete(skillSource).where(eq(skillSource.id, id));
    },

    async token(id) {
      const row = (
        await db
          .select({ keyVersion: skillSource.tokenKeyVersion, data: skillSource.token })
          .from(skillSource)
          .where(eq(skillSource.id, id))
          .limit(1)
      )[0];
      if (!row || row.keyVersion === null || !row.data) return null;
      return cipher
        .open({ keyVersion: row.keyVersion, data: row.data }, tokenContext(id))
        .toString();
    },

    async setToken(id, token) {
      const sealed = token ? cipher.seal(Buffer.from(token), tokenContext(id)) : null;
      await db
        .update(skillSource)
        .set({ tokenKeyVersion: sealed?.keyVersion ?? null, token: sealed?.data ?? null })
        .where(eq(skillSource.id, id));
    },

    async create({ orgId, ...rest }) {
      return (
        await db
          .insert(skill)
          .values({ id: ulid(), organizationId: orgId, ...rest })
          .returning(skillColumns)
      )[0]! as Skill;
    },

    async find(id) {
      return (
        ((
          await db.select(skillColumns).from(skill).where(eq(skill.id, id)).limit(1)
        )[0] as Skill) ?? null
      );
    },

    async inScope(scope) {
      return (await db
        .select(skillColumns)
        .from(skill)
        .where(scoped(skill, scope))
        .orderBy(asc(skill.name), asc(skill.id))) as Skill[];
    },

    async update(id, changes) {
      await db.update(skill).set(changes).where(eq(skill.id, id));
    },

    async delete(id) {
      await db.delete(skill).where(eq(skill.id, id));
    },

    async spaceSourceSettings(spaceId) {
      const rows = await db
        .select({ id: spaceSkillSourceSetting.sourceId, enabled: spaceSkillSourceSetting.enabled })
        .from(spaceSkillSourceSetting)
        .where(eq(spaceSkillSourceSetting.spaceId, spaceId));
      return new Map(rows.map((row) => [row.id, row.enabled]));
    },

    async setSpaceSource(spaceId, sourceId, enabled) {
      await db
        .insert(spaceSkillSourceSetting)
        .values({ spaceId, sourceId, enabled })
        .onConflictDoUpdate({
          target: [spaceSkillSourceSetting.spaceId, spaceSkillSourceSetting.sourceId],
          set: { enabled },
        });
    },

    async spaceSkillSettings(spaceId) {
      const rows = await db
        .select({ id: spaceSkillSetting.skillId, enabled: spaceSkillSetting.enabled })
        .from(spaceSkillSetting)
        .where(eq(spaceSkillSetting.spaceId, spaceId));
      return new Map(rows.map((row) => [row.id, row.enabled]));
    },

    orgBuiltinSwitches: async (orgId) => builtinSwitches({ orgId }),
    setOrgBuiltin: async (orgId, key, enabled) => setBuiltin({ orgId }, key, enabled),
    spaceBuiltinSwitches: async (spaceId) => builtinSwitches({ spaceId }),
    setSpaceBuiltin: async (spaceId, key, enabled) => setBuiltin({ spaceId }, key, enabled),

    async setSpaceSkill(spaceId, skillId, enabled) {
      await db
        .insert(spaceSkillSetting)
        .values({ spaceId, skillId, enabled })
        .onConflictDoUpdate({
          target: [spaceSkillSetting.spaceId, spaceSkillSetting.skillId],
          set: { enabled },
        });
    },
  };
}

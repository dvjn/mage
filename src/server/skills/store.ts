import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { ulid } from "ulid";

import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";
import { type SettingScope, scopedOn } from "@/server/spaces/scope.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";

import type { Scope, Skill, SkillSource, SkillStore } from "./service.ts";
import {
  builtinSkillSetting,
  learnedSkill,
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

const rowColumns = {
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

const skillColumns = {
  ...rowColumns,
  // Where a learned one came from; nothing for the others.
  learned: sql<boolean>`false`.as("learned"),
  learnedThreadId: sql<string | null>`null::text`.as("learned_thread_id"),
  learnedThreadTitle: sql<string | null>`null::text`.as("learned_thread_title"),
  approverName: sql<string | null>`null::text`.as("approver_name"),
};

// A learned skill read as the others are: written here, with the thread that saved it
// while that thread is still in the space, and who approved it.
const learnedColumns = {
  id: learnedSkill.id,
  orgId: space.organizationId,
  spaceId: learnedSkill.spaceId,
  sourceId: sql<string | null>`null::text`.as("source_id"),
  path: sql<string | null>`null::text`.as("path"),
  name: learnedSkill.name,
  description: learnedSkill.description,
  body: learnedSkill.body,
  files: learnedSkill.files,
  enabled: learnedSkill.enabled,
  createdBy: sql<string | null>`null::text`.as("created_by"),
  createdAt: learnedSkill.createdAt,
  updatedAt: learnedSkill.createdAt,
  learned: sql<boolean>`true`.as("learned"),
  learnedThreadId: thread.id,
  learnedThreadTitle: thread.title,
  approverName: user.name,
};

type SkillRow = Omit<Skill, "learned"> & {
  learned: boolean;
  learnedThreadId: string | null;
  learnedThreadTitle: string | null;
  approverName: string | null;
};

function skillOf({ learned, learnedThreadId, learnedThreadTitle, approverName, ...row }: SkillRow) {
  return {
    ...row,
    learned: learned
      ? { threadId: learnedThreadId, threadTitle: learnedThreadTitle, approvedBy: approverName }
      : null,
  } as Skill;
}

const byName = (a: Skill, b: Skill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

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
  // The learned skills in use that match, in the shape of the others.
  function learnedWhere(where: SQL | undefined) {
    return db
      .select(learnedColumns)
      .from(learnedSkill)
      .innerJoin(space, eq(space.id, learnedSkill.spaceId))
      .leftJoin(
        thread,
        and(eq(thread.id, learnedSkill.threadId), eq(thread.spaceId, learnedSkill.spaceId)),
      )
      .leftJoin(user, eq(user.id, learnedSkill.approvedBy))
      .where(and(where, isNull(learnedSkill.retiredAt)));
  }

  // The skills and, for a space, the learned skills in use that match, in one read.
  async function skillsWhere(where: SQL | undefined, learned: SQL | undefined | false) {
    const own = db.select(skillColumns).from(skill).where(where);
    const rows = (
      learned === false ? await own : await unionAll(own, learnedWhere(learned))
    ) as SkillRow[];
    return rows.map(skillOf);
  }

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
          .returning(rowColumns)
      )[0]! as Skill;
    },

    async find(id) {
      return (await skillsWhere(eq(skill.id, id), eq(learnedSkill.id, id)))[0] ?? null;
    },

    async inScope(scope) {
      const learned = scope.spaceId ? eq(learnedSkill.spaceId, scope.spaceId) : false;
      return (await skillsWhere(scoped(skill, scope), learned)).sort(byName);
    },

    async learnedOfCall(threadId, callId) {
      const row = (
        await db
          .select({ name: learnedSkill.name, supersedesId: learnedSkill.supersedesId })
          .from(learnedSkill)
          .where(and(eq(learnedSkill.threadId, threadId), eq(learnedSkill.callId, callId)))
          .limit(1)
      )[0];
      return row ? { name: row.name, updated: row.supersedesId !== null } : null;
    },

    async createLearned(row) {
      const made = await db
        .insert(learnedSkill)
        .values({ id: ulid(), ...row })
        .onConflictDoNothing()
        .returning({ id: learnedSkill.id });
      return made[0]?.id ?? null;
    },

    async holdName(scope, name) {
      const key = `skill-name:${scope.orgId}:${scope.spaceId ?? ""}:${name}`;
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    },

    async retireLearned(spaceId, id, by, at) {
      const moved = await db
        .update(learnedSkill)
        .set({ retiredAt: at, retiredBy: by })
        .where(
          and(
            eq(learnedSkill.id, id),
            eq(learnedSkill.spaceId, spaceId),
            isNull(learnedSkill.retiredAt),
          ),
        )
        .returning({
          files: learnedSkill.files,
          threadId: learnedSkill.threadId,
          enabled: learnedSkill.enabled,
        });
      return moved[0] ?? null;
    },

    async update(id, changes) {
      await db.update(skill).set(changes).where(eq(skill.id, id));
    },

    async setLearnedEnabled(id, enabled) {
      await db
        .update(learnedSkill)
        .set({ enabled })
        .where(and(eq(learnedSkill.id, id), isNull(learnedSkill.retiredAt)));
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

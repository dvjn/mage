import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  index,
  primaryKey,
  boolean,
  json,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { at, bytes, NOW } from "@/server/db/columns.ts";

import { scopeColumns, scopeIndexes } from "@/server/spaces/scope.ts";
import { space } from "@/server/spaces/schema.ts";
import { user, organization } from "@/server/orgs/schema.ts";
import { thread } from "@/server/threads/schema.ts";
import type { Influencer } from "@/shared/threads/events.ts";

// A git repository an org or a space reads skills from, at the commit last read, with the token a
// private one is read with sealed by the cipher.
export const skillSource = pgTable(
  "skill_source",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The space it was added for; null for the whole org.
    spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    // The branch or tag asked for; null for the default branch.
    ref: text("ref"),
    // The branch or tag read, the folder skills are looked for in, and the commit.
    resolvedRef: text("resolved_ref"),
    subpath: text("subpath"),
    commit: text("commit").notNull(),
    fetchedAt: at("fetched_at").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    tokenKeyVersion: integer("token_key_version"),
    token: bytes("token"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("skill_source_org_idx").on(table.organizationId),
    index("skill_source_space_idx").on(table.spaceId),
  ],
);

// A skill: from a source's folder at its commit, or written in settings; its files as JSON.
export const skill = pgTable(
  "skill",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The space it is for; null for the whole org.
    spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
    // The source it came from and its folder there; null for one written in settings.
    sourceId: text("source_id").references(() => skillSource.id, { onDelete: "cascade" }),
    path: text("path"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    files: json("files").$type<{ path: string; text: string }[]>().notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("skill_org_idx").on(table.organizationId),
    index("skill_space_idx").on(table.spaceId),
    index("skill_source_idx").on(table.sourceId),
  ],
);

// Whether a space uses one of the org's skill sources, once it set so.
export const spaceSkillSourceSetting = pgTable(
  "space_skill_source_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => skillSource.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.sourceId] })],
);

// Whether a space uses one of the org's skills, once it set so; one the org turned off is off in
// every space whatever the space set.
export const spaceSkillSetting = pgTable(
  "space_skill_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.skillId] })],
);

// Whether an org uses a built-in skill, or the whole built-in source, once it set so; or a space,
// which can only turn off what its org has on. The key is the id the built-in source or skill is
// listed under; the skills themselves are never stored.
export const builtinSkillSetting = pgTable(
  "builtin_skill_setting",
  {
    ...scopeColumns(),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => scopeIndexes("builtin_skill_setting", table, table.key),
);

// A skill the agent saved for a space, with the call that saved it, whose words steered that call
// and who approved it. Saving a skill again under its name retires the old row and keeps it, and a
// manager deleting one retires it too; managers edit and switch the row in use. One skill of a
// name is in use in a space at a time.
export const learnedSkill = pgTable(
  "learned_skill",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    files: json("files").$type<{ path: string; text: string }[]>().notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // The thread and call that saved it.
    threadId: text("thread_id").references(() => thread.id, { onDelete: "set null" }),
    callId: text("call_id"),
    // Whose words the model had read when it asked to save it.
    influence: json("influence").$type<Influencer[]>().notNull(),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    // The row it replaced.
    supersedesId: text("supersedes_id"),
    retiredAt: at("retired_at"),
    // Who deleted it; none when a newer row replaced it.
    retiredBy: text("retired_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    index("learned_skill_space_idx").on(table.spaceId, table.retiredAt),
    uniqueIndex("learned_skill_call_idx")
      .on(table.threadId, table.callId)
      .where(sql`${table.callId} is not null`),
    uniqueIndex("learned_skill_name_idx")
      .on(table.spaceId, table.name)
      .where(sql`${table.retiredAt} is null`),
  ],
);

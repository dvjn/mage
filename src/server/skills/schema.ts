import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, blob, primaryKey } from "drizzle-orm/sqlite-core";

import { space } from "@/server/spaces/schema.ts";
import { user, organization } from "@/server/orgs/schema.ts";

// A git repository an org or a space reads skills from, at the commit last read, with the token a
// private one is read with sealed by the cipher.
export const skillSource = sqliteTable(
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
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    tokenKeyVersion: integer("token_key_version"),
    token: blob("token", { mode: "buffer" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("skill_source_org_idx").on(table.organizationId),
    index("skill_source_space_idx").on(table.spaceId),
  ],
);

// A skill: from a source's folder at its commit, or written in settings; its files as JSON.
export const skill = sqliteTable(
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
    files: text("files", { mode: "json" }).$type<{ path: string; text: string }[]>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
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
export const spaceSkillSourceSetting = sqliteTable(
  "space_skill_source_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => skillSource.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.sourceId] })],
);

// Whether a space uses one of the org's skills, once it set so; one the org turned off is off in
// every space whatever the space set.
export const spaceSkillSetting = sqliteTable(
  "space_skill_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.skillId] })],
);

// Whether the org uses a built-in skill, or the whole built-in source, once it set so. The key is
// the id the built-in source or skill is listed under; the skills themselves are never stored.
export const orgBuiltinSkillSetting = sqliteTable(
  "org_builtin_skill_setting",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.key] })],
);

// The same for a space, which can only turn off what the org has on.
export const spaceBuiltinSkillSetting = sqliteTable(
  "space_builtin_skill_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.key] })],
);

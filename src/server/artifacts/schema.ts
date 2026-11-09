// Tables of the pages the agent publishes from a thread, their versions and files, and whether orgs
// and spaces let them be made public.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core";

import { organization } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";

// A page the agent published in a thread, kept with the thread's root and gone with it; its space
// and org are the thread's. What it shows is its newest version.
export const artifact = sqliteTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // Who may view it beyond the thread's readers.
    sharing: text("sharing", { enum: ["thread", "org", "public"] })
      .default("thread")
      .notNull(),
    // The number of its newest version.
    version: integer("version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("artifact_thread_idx").on(table.threadId, table.createdAt)],
);

// One publish of an artifact: its page as written, and the name, description and icon it had then.
export const artifactVersion = sqliteTable(
  "artifact_version",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    label: text("label"),
    html: text("html").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    icon: text("icon").notNull(),
    // The run and call that published it.
    runId: text("run_id"),
    callId: text("call_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.version] })],
);

// A file an artifact's page loads by its name, the same for all of its versions.
export const artifactAsset = sqliteTable(
  "artifact_asset",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.name] })],
);

// Whether an org lets its spaces' artifacts be made public; an org without a row does not.
export const artifactOrgSetting = sqliteTable("artifact_org_setting", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  publicAllowed: integer("public_allowed", { mode: "boolean" }).notNull(),
});

// Whether a space lets its artifacts be made public while its org does; one without a row does.
export const artifactSpaceSetting = sqliteTable("artifact_space_setting", {
  spaceId: text("space_id")
    .primaryKey()
    .references(() => space.id, { onDelete: "cascade" }),
  publicAllowed: integer("public_allowed", { mode: "boolean" }).notNull(),
});

// Tables of the pages the agent publishes in a space, their versions and files, which threads used
// them, who they are shared with, and whether orgs and spaces let them be made public.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core";

import { organization, scimGroup, user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";

// A page the agent published in a space, shared by all the space's threads and gone with the space
// or when a person deletes it. What it shows is its newest version.
export const artifact = sqliteTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    // The thread it was first published in, while that thread exists.
    createdInThreadId: text("created_in_thread_id").references(() => thread.id, {
      onDelete: "set null",
    }),
    // Who may view it beyond the space's members.
    sharing: text("sharing", { enum: ["space", "org", "public"] })
      .default("space")
      .notNull(),
    // What the org's members may do while it is shared with the org.
    orgRole: text("org_role", { enum: ["view", "edit"] })
      .default("view")
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
  (table) => [index("artifact_space_idx").on(table.spaceId, table.updatedAt)],
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
    // The thread whose agent published it, while that thread exists.
    threadId: text("thread_id").references(() => thread.id, { onDelete: "set null" }),
    // The run and call that published it.
    runId: text("run_id"),
    callId: text("call_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.version] })],
);

// A thread whose agent published, updated or read an artifact, and whether someone who may change
// the artifact shared it with that thread's guests.
export const artifactThreadUse = sqliteTable(
  "artifact_thread_use",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // When and by whom it was shared with the thread's guests; null while it is not.
    guestsSharedAt: integer("guests_shared_at", { mode: "timestamp_ms" }),
    guestsSharedBy: text("guests_shared_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.threadId] }),
    index("artifact_thread_use_thread_idx").on(table.threadId),
  ],
);

// A person someone who may change the artifact let open it, to view or to edit, for as long as they
// stay in the org or remain a guest of a thread that used it; a guest only views.
export const artifactPersonShare = sqliteTable(
  "artifact_person_share",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["view", "edit"] })
      .default("view")
      .notNull(),
    sharedBy: text("shared_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.userId] }),
    index("artifact_person_share_user_idx").on(table.userId),
  ],
);

// A directory group someone who may change the artifact let open it, to view or to edit: whoever is
// in the group has it while they stay in it.
export const artifactGroupShare = sqliteTable(
  "artifact_group_share",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["view", "edit"] })
      .default("view")
      .notNull(),
    sharedBy: text("shared_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.groupId] }),
    index("artifact_group_share_group_idx").on(table.groupId),
  ],
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

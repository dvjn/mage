// Tables of the pages the agent publishes in a space, their versions and files, which threads used
// them, who they are shared with, and whether orgs and spaces let them be made public.

import { sql } from "drizzle-orm";
import { pgTable, text, integer, check, index, primaryKey, boolean } from "drizzle-orm/pg-core";

import { at, bytes, NOW } from "@/server/db/columns.ts";

import { backgroundCall, run } from "@/server/agent/schema.ts";
import { scimGroup, user } from "@/server/orgs/schema.ts";
import { scopeColumns, scopeIndexes } from "@/server/spaces/scope.ts";
import { space } from "@/server/spaces/schema.ts";
import { thread } from "@/server/threads/schema.ts";

// A page the agent published in a space, shared by all the space's threads and gone with the space
// or when a person deletes it. What it shows is its newest version.
export const artifact = pgTable(
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
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("artifact_space_idx").on(table.spaceId, table.updatedAt)],
);

// One publish of an artifact: its page as written, and the name, description and icon it had then.
export const artifactVersion = pgTable(
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
    // What published it, while that exists: a run, or a call started in the background, which
    // runs under no run; and the call's id in the thread's log.
    runId: text("run_id").references(() => run.id, { onDelete: "set null" }),
    backgroundCallId: text("background_call_id").references(() => backgroundCall.id, {
      onDelete: "set null",
    }),
    callId: text("call_id"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.version] }),
    check(
      "artifact_version_origin_check",
      sql`${table.runId} is null or ${table.backgroundCallId} is null`,
    ),
  ],
);

// A thread whose agent published, updated or read an artifact, and whether someone who may change
// the artifact shared it with that thread's guests.
export const artifactThreadUse = pgTable(
  "artifact_thread_use",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    createdAt: at("created_at").default(NOW).notNull(),
    // When and by whom it was shared with the thread's guests; null while it is not.
    guestsSharedAt: at("guests_shared_at"),
    guestsSharedBy: text("guests_shared_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.threadId] }),
    index("artifact_thread_use_thread_idx").on(table.threadId),
  ],
);

// A person someone who may change the artifact let open it, to view or to edit, for as long as they
// stay in the org or remain a guest of a thread that used it; a guest only views.
export const artifactPersonShare = pgTable(
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
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.userId] }),
    index("artifact_person_share_user_idx").on(table.userId),
  ],
);

// A directory group someone who may change the artifact let open it, to view or to edit: whoever is
// in the group has it while they stay in it.
export const artifactGroupShare = pgTable(
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
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.groupId] }),
    index("artifact_group_share_group_idx").on(table.groupId),
  ],
);

// A file an artifact's page loads by its name, the same for all of its versions.
export const artifactAsset = pgTable(
  "artifact_asset",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    data: bytes("data").notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.name] })],
);

// Whether artifacts may be made public: an org lets its spaces' be, and one without a row does
// not; a space lets its own be while its org does, and one without a row does.
export const artifactSetting = pgTable(
  "artifact_setting",
  {
    ...scopeColumns(),
    publicAllowed: boolean("public_allowed").notNull(),
  },
  (table) => scopeIndexes("artifact_setting", table),
);

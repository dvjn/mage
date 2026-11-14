import { pgTable, text, index, primaryKey, boolean } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";

import { user, organization } from "@/server/orgs/schema.ts";

// Where an org's threads live; people see a space's threads by being its members.
export const space = pgTable(
  "space",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["personal", "shared"] }).notNull(),
    name: text("name").notNull(),
    // The space every personal org starts with; it can be renamed but not deleted.
    primary: boolean("is_primary").default(false).notNull(),
    // The model ref and reasoning effort its new threads start with; null takes the org's.
    defaultModel: text("default_model"),
    defaultEffort: text("default_effort", { enum: ["low", "medium", "high"] }),
    // What the agent of its threads goes by where people see it; null takes the org's.
    agentName: text("agent_name"),
    // The role every member of the org has in a shared space, now and later; null for none.
    everyoneRole: text("everyone_role", { enum: ["messager", "viewer"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // Since when a member's own space has been archived, which starts its countdown to deletion;
    // null while it is not. Whether it is archived is still worked out when asked.
    archivedAt: at("archived_at"),
    // When it went to trash, and by whom; trash is emptied after a while.
    trashedAt: at("trashed_at"),
    trashedBy: text("trashed_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("space_org_idx").on(table.organizationId)],
);

// A person's or a group's role in a space.
export const spaceMember = pgTable(
  "space_member",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    // Who holds the role: a user, or everyone active in a directory group linked to the org.
    subjectKind: text("subject_kind", { enum: ["user", "group"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    // Owners manage the space; messagers and owners post; viewers only read.
    role: text("role", { enum: ["owner", "messager", "viewer"] }).notNull(),
    // How the role came to be given.
    source: text("source", { enum: ["direct"] }).notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.subjectKind, table.subjectId] }),
    index("space_member_subject_idx").on(table.subjectKind, table.subjectId),
  ],
);

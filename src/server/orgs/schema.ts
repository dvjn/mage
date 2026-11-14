import { relations } from "drizzle-orm";
import { pgTable, text, integer, index, primaryKey, boolean } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: at("created_at").default(NOW).notNull(),
  updatedAt: at("updated_at")
    .default(NOW)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: at("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
    updatedAt: at("updated_at")
      .default(NOW)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: at("created_at").notNull(),
  metadata: text("metadata"),
  kind: text("kind", { enum: ["personal", "team"] }).notNull(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The role they have in the org: the highest of their own and their linked groups'.
    role: text("role").default("member").notNull(),
    // The role given to them in the org itself, apart from any group; null when they are in only
    // through groups.
    directRole: text("direct_role", { enum: ["owner", "member"] }),
    createdAt: at("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    // Narrows an org's members to one role.
    index("member_org_role_idx").on(table.organizationId, table.role),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

// Choices an org makes for everyone in it.
export const orgSetting = pgTable("org_setting", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // A model ref such as `codex/gpt-5`; null until the org picks one.
  defaultModel: text("default_model"),
  // The model ref that names threads; null to choose one automatically.
  titleModel: text("title_model"),
  // The reasoning effort new threads start with; null for the usual one.
  defaultEffort: text("default_effort", { enum: ["low", "medium", "high"] }),
  // Who may make shared spaces in a team org: any member, or only its owners.
  spaceCreation: text("space_creation", { enum: ["members", "owners"] })
    .default("members")
    .notNull(),
  // Whether a team org's members may make a private space of their own; while not, the ones made
  // are archived.
  memberSpaces: boolean("member_spaces").default(false).notNull(),
  // Whether a space's managers may add MCP servers for it, and its threads use them.
  spaceMcpServers: boolean("space_mcp_servers").default(true).notNull(),
  // Whether a space's managers may add skills for it, and its threads use them.
  spaceSkills: boolean("space_skills").default(true).notNull(),
  // What the agent of the org's threads goes by where people see it; null for the usual name.
  agentName: text("agent_name"),
  createdAt: at("created_at").default(NOW).notNull(),
  updatedAt: at("updated_at")
    .default(NOW)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

// A directory group linked to a team org: everyone active in it is a member with the role.
export const orgGroup = pgTable(
  "org_group",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.groupId] }),
    index("org_group_group_idx").on(table.groupId),
  ],
);

// A single-use link that lets the account with that email join a team org with the role. Only the
// hash of its token is kept.
export const orgInvite = pgTable(
  "org_invite",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Lower-cased.
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: at("created_at").default(NOW).notNull(),
    expiresAt: at("expires_at").notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: at("accepted_at"),
    revokedAt: at("revoked_at"),
  },
  (table) => [index("org_invite_org_idx").on(table.organizationId, table.email)],
);

// Someone removed from an org, so what they wrote there says so; joining again clears it.
export const orgFormerMember = pgTable(
  "org_former_member",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    removedAt: at("removed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

// The SCIM directory's tables, as its library keeps them: the connection a directory provisions
// through, the people and groups it brings, who is in which group, and what it remembers of people
// it deleted. A directory person is linked to one user.

export const scimConnectionBinding = pgTable(
  "scim_connection_binding",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    createdAt: at("created_at").notNull(),
    decommissionedAt: at("decommissioned_at"),
    decommissionStatus: text("decommission_status").default("active").notNull(),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionReconciledUserCount: integer("decommission_reconciled_user_count")
      .default(0)
      .notNull(),
    decommissionBatchCount: integer("decommission_batch_count").default(0).notNull(),
    decommissionRevision: integer("decommission_revision").default(0).notNull(),
    decommissionCompletedAt: at("decommission_completed_at"),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionLeaseExpiresAt: at("decommission_lease_expires_at"),
  },
  (table) => [index("scim_connection_binding_connection_idx").on(table.connectionId)],
);

export const scimIdentityTombstone = pgTable(
  "scim_identity_tombstone",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    externalId: text("external_id").notNull(),
    externalIdKey: text("external_id_key").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    profile: text("profile").notNull(),
    deletedAt: at("deleted_at").notNull(),
  },
  (table) => [
    index("scim_identity_tombstone_connection_idx").on(table.connectionId),
    index("scim_identity_tombstone_domain_idx").on(table.provisioningDomainId),
    index("scim_identity_tombstone_user_idx").on(table.userId),
  ],
);

// A user a directory has provisioned, whether or not it still does.
export const scimSubject = pgTable(
  "scim_subject",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [index("scim_subject_profile_source_idx").on(table.profileSourceId)],
);

export const scimUser = pgTable(
  "scim_user",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionUserKey: text("connection_user_key").notNull().unique(),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull().unique(),
    primaryEmail: text("primary_email").notNull(),
    workEmailValueIndex: text("work_email_value_index").notNull(),
    emailValueIndex: text("email_value_index").notNull(),
    displayName: text("display_name").notNull(),
    formattedName: text("formatted_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    serializedEmails: text("serialized_emails").notNull(),
    serializedAttributes: text("serialized_attributes"),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    active: boolean("active").notNull(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_user_connection_idx").on(table.connectionId),
    index("scim_user_domain_idx").on(table.provisioningDomainId),
    index("scim_user_user_idx").on(table.userId),
  ],
);

export const scimProjectionGrant = pgTable(
  "scim_projection_grant",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceValue: text("source_value"),
    role: text("role").notNull(),
    grantKey: text("grant_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_projection_grant_connection_idx").on(table.connectionId),
    index("scim_projection_grant_domain_idx").on(table.provisioningDomainId),
    index("scim_projection_grant_scim_user_idx").on(table.scimUserId),
    index("scim_projection_grant_user_idx").on(table.userId),
  ],
);

export const scimGroup = pgTable(
  "scim_group",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    revision: integer("revision").default(0).notNull(),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull().unique(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    // The group's mail address as the directory gave it, and lower-cased to look it up by.
    email: text("email"),
    emailKey: text("email_key"),
    orderKey: text("order_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_group_connection_idx").on(table.connectionId),
    index("scim_group_domain_idx").on(table.provisioningDomainId),
    index("scim_group_email_idx").on(table.emailKey),
  ],
);

export const scimGroupMember = pgTable(
  "scim_group_member",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
  },
  (table) => [
    index("scim_group_member_connection_idx").on(table.connectionId),
    index("scim_group_member_group_idx").on(table.groupId),
    index("scim_group_member_scim_user_idx").on(table.scimUserId),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

// Database tables. Migrations are generated from these definitions.

import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  blob,
  primaryKey,
} from "drizzle-orm/sqlite-core";

import { AUTH_KINDS } from "../shared/hosts.ts";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
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

export const account = sqliteTable(
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
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  metadata: text("metadata"),
  kind: text("kind", { enum: ["personal", "team"] }).notNull(),
});

export const member = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    // Narrows an org's members to one role.
    index("member_org_role_idx").on(table.organizationId, table.role),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

// A provider account an org reaches models through.
export const connection = sqliteTable(
  "connection",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user who connected it; null once that user is gone.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // Who serves its models, as the host registry names it.
    host: text("host").notNull(),
    // A subscription sign-in, a key, cloud credentials or a server's address.
    authKind: text("auth_kind", { enum: AUTH_KINDS }).notNull(),
    // The account, as shown to people; for a key, its masked hint.
    account: text("account").notNull(),
    // A name people gave it; null for sign-ins.
    label: text("label"),
    // What is not secret about how it connects, as JSON; null where it says nothing.
    settings: text("settings", { mode: "json" }).$type<Record<string, string>>(),
    // Whether models the provider adds are turned on when first seen.
    autoEnableModels: integer("auto_enable_models", { mode: "boolean" }).default(true).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  // One sign-in of each host per org; the rest as many as people add.
  (table) => [
    uniqueIndex("connection_org_sign_in_idx")
      .on(table.organizationId, table.host)
      .where(sql`${table.authKind} = 'oauth'`),
  ],
);

// Each model a connection's list has shown, whether people can pick it, and when it first showed.
export const connectionModel = sqliteTable(
  "connection_model",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.modelId] })],
);

// A connection's secrets, sealed with the credential key of the recorded version.
export const credential = sqliteTable("credential", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connection.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull(),
  sealed: blob("sealed", { mode: "buffer" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

// A browser sign-in a user started and had not finished, from when Mage offered them; nothing
// writes it now.
export const signInAttempt = sqliteTable("sign_in_attempt", {
  state: text("state").primaryKey(),
  kind: text("kind", { enum: ["codex"] }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

// Choices an org makes for everyone in it.
export const orgSetting = sqliteTable("org_setting", {
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
  // Whether each member of a team org gets a private space of their own on joining.
  memberSpaces: integer("member_spaces", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

// Where an org's threads live; people see a space's threads by being its members.
export const space = sqliteTable(
  "space",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["personal", "shared"] }).notNull(),
    name: text("name").notNull(),
    // The space every personal org starts with; it can be renamed but not deleted.
    primary: integer("is_primary", { mode: "boolean" }).default(false).notNull(),
    // The model ref and reasoning effort its new threads start with; null takes the org's.
    defaultModel: text("default_model"),
    defaultEffort: text("default_effort", { enum: ["low", "medium", "high"] }),
    // The role every member of the org has in a shared space, now and later; null for none.
    everyoneRole: text("everyone_role", { enum: ["messager", "viewer"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("space_org_idx").on(table.organizationId)],
);

// The mode an org set for a tool, for all its spaces.
export const orgToolSetting = sqliteTable(
  "org_tool_setting",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    mode: text("mode", { enum: ["block", "ask", "allow"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.toolId] })],
);

// The mode a space set for a tool; it only makes the org's stricter.
export const spaceToolSetting = sqliteTable(
  "space_tool_setting",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    mode: text("mode", { enum: ["block", "ask", "allow"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolId] })],
);

// A person's or a group's role in a space.
export const spaceMember = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.subjectKind, table.subjectId] }),
    index("space_member_subject_idx").on(table.subjectKind, table.subjectId),
  ],
);

// A directory group linked to a team org: everyone active in it is a member with the role.
export const orgGroup = sqliteTable(
  "org_group",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.groupId] }),
    index("org_group_group_idx").on(table.groupId),
  ],
);

// A single-use link that lets the account with that email join a team org with the role. Only the
// hash of its token is kept.
export const orgInvite = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("org_invite_org_idx").on(table.organizationId, table.email)],
);

// Someone removed from an org, so what they wrote there says so; joining again clears it.
export const orgFormerMember = sqliteTable(
  "org_former_member",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    removedAt: integer("removed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

// A folder in a space, holding some of its threads.
export const folder = sqliteTable(
  "folder",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("folder_space_idx").on(table.spaceId)],
);

// A conversation in a space; its content is its event log.
export const thread = sqliteTable(
  "thread",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    // Null when the thread is at the space's top level.
    folderId: text("folder_id").references(() => folder.id),
    // Null until the first message names it or someone sets it.
    title: text("title"),
    // Who named it: its first message, the agent after it, or a person; null while untitled.
    titleSource: text("title_source", { enum: ["message", "agent", "person"] }),
    // A model ref such as `codex/gpt-5`; null follows its space's default, then its org's.
    model: text("model"),
    // The reasoning effort its model is asked for; null follows the defaults, then the usual one.
    effort: text("effort", { enum: ["low", "medium", "high"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    parentThreadId: text("parent_thread_id"),
    rootThreadId: text("root_thread_id"),
    // The seq of the thread's newest event; 0 before the first.
    lastEventSeq: integer("last_event_seq").default(0).notNull(),
    // The text of its newest message or reply without markdown, on one line, which lists find it by;
    // null before the first.
    lastMessageText: text("last_message_text"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("thread_space_idx").on(table.spaceId, table.updatedAt),
    index("thread_folder_idx").on(table.folderId),
  ],
);

// What happened in a thread, numbered 1, 2, 3… per thread with no gaps.
export const threadEvent = sqliteTable(
  "thread_event",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actorKind: text("actor_kind", { enum: ["user", "agent"] }).notNull(),
    // Kept after the user is gone, so their events still say who wrote them.
    actorUserId: text("actor_user_id"),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("thread_event_thread_seq_idx").on(table.threadId, table.seq),
    index("thread_event_thread_type_idx").on(table.threadId, table.type, table.seq),
  ],
);

// How far into a thread a person has seen: the seq of the newest event they saw there, and when.
export const threadRead = sqliteTable(
  "thread_read",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    lastSeenSeq: integer("last_seen_seq").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);

// A wake-up of the agent in a thread. At most one run per thread is queued, running or waiting.
export const run = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "waiting", "completed", "failed", "cancelled"],
    }).notNull(),
    // The seq of the message that woke the agent.
    triggerSeq: integer("trigger_seq").notNull(),
    // The model ref it replied with, once it started.
    model: text("model"),
    // The run this one follows, and why.
    continuesRunId: text("continues_run_id"),
    reason: text("reason", { enum: ["interrupt", "queued_input", "retry"] }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // How many times this input has been tried, counting this run.
    attempt: integer("attempt").default(1).notNull(),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    cancelRequestedBy: text("cancel_requested_by"),
    // The worker holding the run, until when, and how many times it has been claimed.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    error: text("error"),
    // Why it failed, as a failure kind, and what the provider said.
    errorKind: text("error_kind", { enum: ["auth", "limit", "model", "network"] }),
    errorDetail: text("error_detail"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("run_thread_idx").on(table.threadId),
    index("run_status_idx").on(table.status),
    uniqueIndex("run_active_idx")
      .on(table.threadId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting')`),
  ],
);

// The text an agent reply has streamed so far, of its answer and its reasoning, one row per piece
// the model sent, kept until the reply completes.
export const messageDelta = sqliteTable(
  "message_delta",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    // 0, 1, 2… per message, in the order the model sent them.
    index: integer("idx").notNull(),
    text: text("text").notNull(),
    // Whether the piece is of the answer or of the reasoning before it.
    part: text("part", { enum: ["text", "reasoning"] })
      .default("text")
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.index] }),
    index("message_delta_thread_idx").on(table.threadId),
  ],
);

// Someone outside the thread's space let into that one thread, until their access runs out or is
// revoked. One row per person and thread; inviting them again renews it.
export const threadGuest = sqliteTable(
  "thread_guest",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Whoever's invite last granted the access.
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // Null for access that does not run out.
    accessUntil: integer("access_until", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.userId] }),
    index("thread_guest_user_idx").on(table.userId),
  ],
);

// A single-use link that makes whoever opens it a guest of the thread. Only the hash of its token
// is kept.
export const threadInvite = sqliteTable(
  "thread_invite",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // The link works until then.
    linkExpiresAt: integer("link_expires_at", { mode: "timestamp_ms" }).notNull(),
    // How long the guest's access lasts from accepting.
    accessFor: text("access_for", { enum: ["1h", "1d", "7d", "never"] }).notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("thread_invite_thread_idx").on(table.threadId)],
);

// The SCIM directory's tables, as its library keeps them: the connection a directory provisions
// through, the people and groups it brings, who is in which group, and what it remembers of people
// it deleted. A directory person is linked to one user.

export const scimConnectionBinding = sqliteTable(
  "scim_connection_binding",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    decommissionedAt: integer("decommissioned_at", { mode: "timestamp_ms" }),
    decommissionStatus: text("decommission_status").default("active").notNull(),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionReconciledUserCount: integer("decommission_reconciled_user_count")
      .default(0)
      .notNull(),
    decommissionBatchCount: integer("decommission_batch_count").default(0).notNull(),
    decommissionRevision: integer("decommission_revision").default(0).notNull(),
    decommissionCompletedAt: integer("decommission_completed_at", { mode: "timestamp_ms" }),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionLeaseExpiresAt: integer("decommission_lease_expires_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("scim_connection_binding_connection_idx").on(table.connectionId)],
);

export const scimIdentityTombstone = sqliteTable(
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
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("scim_identity_tombstone_connection_idx").on(table.connectionId),
    index("scim_identity_tombstone_domain_idx").on(table.provisioningDomainId),
    index("scim_identity_tombstone_user_idx").on(table.userId),
  ],
);

// A user a directory has provisioned, whether or not it still does.
export const scimSubject = sqliteTable(
  "scim_subject",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("scim_subject_profile_source_idx").on(table.profileSourceId)],
);

export const scimUser = sqliteTable(
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
    active: integer("active", { mode: "boolean" }).notNull(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("scim_user_connection_idx").on(table.connectionId),
    index("scim_user_domain_idx").on(table.provisioningDomainId),
    index("scim_user_user_idx").on(table.userId),
  ],
);

export const scimProjectionGrant = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("scim_projection_grant_connection_idx").on(table.connectionId),
    index("scim_projection_grant_domain_idx").on(table.provisioningDomainId),
    index("scim_projection_grant_scim_user_idx").on(table.scimUserId),
    index("scim_projection_grant_user_idx").on(table.userId),
  ],
);

export const scimGroup = sqliteTable(
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
    orderKey: text("order_key").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("scim_group_connection_idx").on(table.connectionId),
    index("scim_group_domain_idx").on(table.provisioningDomainId),
  ],
);

export const scimGroupMember = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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

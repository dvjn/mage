// Orgs as the API shows them: the orgs a person is in, a team org's members, linked groups and
// invites, the directory's people and groups to add, joining through an invite, and the settings
// owners choose for its spaces, with the bodies that change them, shared by the server and the web
// client.

import * as z from "zod";

import { pageQuerySchema, pageSchema, tableQuerySchema } from "@/shared/paging.ts";

// Why a role cannot be changed by the one looking at it.
export const lockSchema = z.enum(["self", "last_owner"]);

export type Lock = z.infer<typeof lockSchema>;

export const orgRoleSchema = z.enum(["owner", "member"]);

export type OrgRole = z.infer<typeof orgRoleSchema>;

export const ORG_ROLE_LABELS: Record<OrgRole, string> = { owner: "Owner", member: "Member" };

export const orgSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["personal", "team"]),
  role: orgRoleSchema,
  ownerName: z.string().nullable(),
});

export type OrgSummary = z.infer<typeof orgSummarySchema>;

export const orgListSchema = z.object({
  orgs: z.array(orgSummarySchema),
  // The person may create a team org.
  canCreate: z.boolean(),
});

export type OrgList = z.infer<typeof orgListSchema>;

export const orgNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// A new team org and the space to open in it.
export const createdOrgSchema = z.object({ orgId: z.string(), spaceId: z.string() });

// Where a person or group comes from: Mage itself, or the directory, which alone changes them.
export const recordSourceSchema = z.enum(["local", "scim"]);

export const orgMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  // The role they have: the higher of their own and their linked groups'.
  role: orgRoleSchema,
  // The role given to them in the org itself; null when they are in only through groups.
  directRole: orgRoleSchema.nullable(),
  // A linked group they are in, the first by name, when they are in any.
  viaGroup: z.string().nullable(),
  // The highest role their linked groups give, when they are in any.
  groupRole: orgRoleSchema.nullable(),
  source: recordSourceSchema,
  joinedAt: z.iso.datetime(),
  // How many of the org's linked groups they are in.
  groupCount: z.number().int(),
  // Why the asker may not change their role: it is theirs, or the org's last owner's.
  locked: lockSchema.nullable(),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;

export const orgMemberPageSchema = pageSchema(orgMemberSchema);

// What the members list is narrowed by, besides its text.
export const memberFilterSchema = pageQuerySchema.extend({ role: orgRoleSchema.optional() });

// An invite not yet used, without its token.
export const pendingOrgInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  createdByName: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});

export type PendingOrgInvite = z.infer<typeof pendingOrgInviteSchema>;

// A directory group linked to the org: everyone active in it is a member with at least its role.
export const linkedGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: orgRoleSchema,
  memberCount: z.number().int(),
  linkedAt: z.iso.datetime(),
});

// One of the org's people: a member, someone invited who has not joined yet, or a linked group.
export const orgPersonSchema = z.discriminatedUnion("kind", [
  orgMemberSchema.extend({ kind: z.literal("member") }),
  pendingOrgInviteSchema.extend({ kind: z.literal("invite") }),
  linkedGroupSchema.extend({ kind: z.literal("group") }),
]);

export type OrgPerson = z.infer<typeof orgPersonSchema>;

export const orgPersonPageSchema = pageSchema(orgPersonSchema);

export const personStatusSchema = z.enum(["member", "invited", "group"]);

// What the people table is narrowed by, besides its text, and its page.
export const peopleFilterSchema = tableQuerySchema.extend({
  role: orgRoleSchema.optional(),
  status: personStatusSchema.optional(),
});

// Someone from the directory to add, with a role of their own.
export const newOrgMemberSchema = z.object({ userId: z.string().min(1), role: orgRoleSchema });

// A directory group to link, with the role it gives.
export const newGroupLinkSchema = z.object({ groupId: z.string().min(1), role: orgRoleSchema });

// A person the directory brought, and their role in the org, if any.
export const directoryPersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: orgRoleSchema.nullable(),
});

export type DirectoryPerson = z.infer<typeof directoryPersonSchema>;

export const directoryPersonPageSchema = pageSchema(directoryPersonSchema);

// A directory group, and the role it is linked to the org with, if any.
export const directoryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int(),
  role: orgRoleSchema.nullable(),
});

export type DirectoryGroup = z.infer<typeof directoryGroupSchema>;

export const directoryGroupPageSchema = pageSchema(directoryGroupSchema);

export const newOrgInviteSchema = z.object({ email: z.email().max(254), role: orgRoleSchema });

// An invite just made; its url holds the token, and is shown only this once.
export const createdOrgInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export type CreatedOrgInvite = z.infer<typeof createdOrgInviteSchema>;

export const setOrgRoleSchema = z.object({ role: orgRoleSchema });

export const joinStatusSchema = z.enum(["ok", "used", "expired", "revoked"]);

// What an invite link offers, before joining.
export const joinPreviewSchema = z.object({
  orgName: z.string(),
  inviterName: z.string().nullable(),
  // In full when signed out or signed in as its person; otherwise masked.
  email: z.string(),
  role: orgRoleSchema,
  status: joinStatusSchema,
  // Signed in as the person it is for.
  yours: z.boolean(),
  // Signed in as someone already in the org.
  member: z.boolean(),
});

export type JoinPreview = z.infer<typeof joinPreviewSchema>;

export const acceptOrgInviteSchema = z.object({ token: z.string().min(1).max(200) });

// The org joined, and the space to open there.
export const joinedOrgSchema = z.object({ orgId: z.string(), spaceId: z.string().nullable() });

// Why joining was refused.
export const joinRefusalSchema = z.object({
  error: z.string(),
  reason: z.enum(["used", "expired", "revoked", "not_found", "wrong_account"]),
});

// A group linked to the org, with the role it gives.
export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: recordSourceSchema,
  role: orgRoleSchema,
  memberCount: z.number().int(),
  createdAt: z.iso.datetime(),
});

export type GroupSummary = z.infer<typeof groupSchema>;

export const groupPageSchema = pageSchema(groupSchema);

export const groupMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
});

export type GroupMember = z.infer<typeof groupMemberSchema>;

export const groupMemberPageSchema = pageSchema(groupMemberSchema);

export const teamSettingsSchema = z.object({
  // Who may make shared spaces.
  spaceCreation: z.enum(["members", "owners"]),
  // Whether each member gets a private space of their own on joining.
  memberSpaces: z.boolean(),
});

export type TeamSettings = z.infer<typeof teamSettingsSchema>;

export const teamSettingsChangeSchema = teamSettingsSchema
  .partial()
  .refine((changes) => Object.keys(changes).length > 0);

// What the API answers for an org the person is not in, as when they were removed from it.
export const ORG_NOT_FOUND = "Organization not found";

// Which org a space or thread is in, for opening it in that org.
export const locatedSchema = z.object({ orgId: z.string() });

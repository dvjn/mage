// Thread guests as the API shows them: invite links and how long the access they give lasts, the
// people of a thread, accepting a link, and the threads shared with the signed-in user, shared by
// the server and the web client.

import * as z from "zod";

import { pageSchema } from "@/shared/paging.ts";
import {
  shownModelSchema,
  threadActivitySchema,
  threadStatusSchema,
  threadParticipantsSchema,
} from "@/shared/threads/list.ts";
import { threadSchema } from "@/shared/threads/thread.ts";

// How long a guest's access lasts from accepting the link: an hour, a day, a week or for good.
export const accessForSchema = z.enum(["1h", "1d", "7d", "never"]);

export type AccessFor = z.infer<typeof accessForSchema>;

export const ACCESS_FOR_MS: Record<AccessFor, number | null> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  never: null,
};

// What a guest, or the org's members through the thread's general access, may do: read it, or read
// and post.
export const threadRoleSchema = z.enum(["view", "message"]);

export type ThreadRole = z.infer<typeof threadRoleSchema>;

// What the org's members outside the space may do in a thread: nothing, or as a guest would.
export const orgAccessSchema = z.enum(["none", "view", "message"]);

export type OrgAccess = z.infer<typeof orgAccessSchema>;

export const newInviteSchema = z.object({
  accessFor: accessForSchema,
  role: threadRoleSchema.default("message"),
});

export const orgAccessChangeSchema = z.object({ orgAccess: orgAccessSchema });

export const guestRoleChangeSchema = z.object({ role: threadRoleSchema });

// Adding someone of the thread's org to it directly.
export const newGuestSchema = z.object({
  userId: z.string().min(1).max(100),
  accessFor: accessForSchema,
  role: threadRoleSchema.default("message"),
});

// Adding a group of the thread's org to it directly: everyone in it, while they are, is a guest.
export const newGroupGuestSchema = z.object({
  groupId: z.string().min(1).max(100),
  accessFor: accessForSchema,
  role: threadRoleSchema.default("message"),
});

// A member of the thread's org, or a group of it, who may be added; one who already has access is
// marked with why, short enough to show beside the name, and cannot be.
export const guestCandidateSchema = z.object({
  kind: z.enum(["user", "group"]),
  id: z.string(),
  name: z.string(),
  // A person's email, or a group's if it has one; else empty.
  email: z.string(),
  // How many people are in a group.
  memberCount: z.number().int().nullable(),
  already: z.string().nullable(),
});

export type GuestCandidate = z.infer<typeof guestCandidateSchema>;

export const guestCandidatePageSchema = pageSchema(guestCandidateSchema);

// A link just made; its url holds the token, and is shown only this once.
export const createdInviteSchema = z.object({
  id: z.string(),
  url: z.string(),
  accessFor: accessForSchema,
  role: threadRoleSchema,
  linkExpiresAt: z.iso.datetime(),
});

export type CreatedInvite = z.infer<typeof createdInviteSchema>;

// Someone in the thread: a member of its space who has written in it, with their role there, a
// guest with when their access runs out (null for never) and who let them in, or a group let in as
// guests, whose id stands where a person's would.
export const threadPersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  kind: z.enum(["member", "guest", "group"]),
  // How many people are in a group.
  memberCount: z.number().int().nullable(),
  role: z.enum(["owner", "messager", "viewer"]).nullable(),
  // What a guest or group may do; null for a member.
  access: threadRoleSchema.nullable(),
  accessUntil: z.iso.datetime().nullable(),
  invitedBy: z.string().nullable(),
  // The asker may revoke this guest.
  canRevoke: z.boolean(),
});

export type ThreadPerson = z.infer<typeof threadPersonSchema>;

// A link not yet used, without its token.
export const pendingInviteSchema = z.object({
  id: z.string(),
  accessFor: accessForSchema,
  role: threadRoleSchema,
  createdBy: z.string().nullable(),
  linkExpiresAt: z.iso.datetime(),
  canRevoke: z.boolean(),
});

export type PendingInvite = z.infer<typeof pendingInviteSchema>;

export const threadPeopleSchema = z.object({
  people: z.array(threadPersonSchema),
  invites: z.array(pendingInviteSchema),
  orgAccess: orgAccessSchema,
});

export type ThreadPeople = z.infer<typeof threadPeopleSchema>;

export const acceptInviteSchema = z.object({ token: z.string().min(1).max(200) });

export const acceptedInviteSchema = z.object({ threadId: z.string() });

// Why a link no longer works.
export const inviteRefusalSchema = z.object({
  error: z.string(),
  reason: z.enum(["used", "expired", "revoked", "not_found"]),
});

export type InviteRefusal = z.infer<typeof inviteRefusalSchema>;

// A thread the signed-in user is a guest in, with the space and org it belongs to, and what its
// space's list would say of it.
export const sharedThreadSchema = threadSchema.extend({
  spaceName: z.string(),
  orgName: z.string(),
  // Where it is, as it reads: its space and org, or the space alone when it is named for the org.
  place: z.string(),
  accessUntil: z.iso.datetime().nullable(),
  shownModel: shownModelSchema.nullable(),
  participants: threadParticipantsSchema,
  activity: threadActivitySchema,
  status: threadStatusSchema,
});

export type SharedThread = z.infer<typeof sharedThreadSchema>;

export const sharedThreadListSchema = z.array(sharedThreadSchema);

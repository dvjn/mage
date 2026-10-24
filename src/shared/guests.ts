// Thread guests as the API shows them: invite links and how long the access they give lasts, the
// people of a thread, accepting a link, and the threads shared with the signed-in user, shared by
// the server and the web client.

import * as z from "zod";

import { threadActivitySchema, threadSchema } from "@/shared/threads.ts";

// How long a guest's access lasts from accepting the link: an hour, a day, a week or for good.
export const accessForSchema = z.enum(["1h", "1d", "7d", "never"]);

export type AccessFor = z.infer<typeof accessForSchema>;

export const ACCESS_FOR_MS: Record<AccessFor, number | null> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  never: null,
};

export const newInviteSchema = z.object({ accessFor: accessForSchema });

// A link just made; its url holds the token, and is shown only this once.
export const createdInviteSchema = z.object({
  id: z.string(),
  url: z.string(),
  accessFor: accessForSchema,
  linkExpiresAt: z.iso.datetime(),
});

export type CreatedInvite = z.infer<typeof createdInviteSchema>;

// Someone in the thread: a member of its space who has written in it, with their role there, or a
// guest with when their access runs out (null for never) and who let them in.
export const threadPersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  kind: z.enum(["member", "guest"]),
  role: z.enum(["owner", "messager", "viewer"]).nullable(),
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
  createdBy: z.string().nullable(),
  linkExpiresAt: z.iso.datetime(),
  canRevoke: z.boolean(),
});

export type PendingInvite = z.infer<typeof pendingInviteSchema>;

export const threadPeopleSchema = z.object({
  people: z.array(threadPersonSchema),
  invites: z.array(pendingInviteSchema),
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

// A thread the signed-in user is a guest in, with the space and org it belongs to.
export const sharedThreadSchema = threadSchema.extend({
  spaceName: z.string(),
  orgName: z.string(),
  // Where it is, as it reads: its space and org, or the space alone when it is named for the org.
  place: z.string(),
  accessUntil: z.iso.datetime().nullable(),
  activity: threadActivitySchema.nullable(),
});

export type SharedThread = z.infer<typeof sharedThreadSchema>;

export const sharedThreadListSchema = z.array(sharedThreadSchema);

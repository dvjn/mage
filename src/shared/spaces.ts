// Spaces as the API shows them and the bodies that make and rename them and set their defaults,
// shared by the server and the web client.

import * as z from "zod";

import { lockSchema } from "@/shared/orgs.ts";
import { pageSchema, tableQuerySchema } from "@/shared/paging.ts";
import { effortSchema } from "@/shared/threads/thread.ts";

export const spaceRoleSchema = z.enum(["owner", "messager", "viewer"]);

export type SpaceRole = z.infer<typeof spaceRoleSchema>;

export const everyoneRoleSchema = z.enum(["messager", "viewer"]);

export const spaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["personal", "shared"]),
  name: z.string(),
  // The space every personal org starts with; it cannot be deleted.
  primary: z.boolean(),
  // The reader's role in it; null for a team org's owner who manages it without one.
  role: spaceRoleSchema.nullable(),
  // The reader may change its settings and who is in it.
  manage: z.boolean(),
  // The role everyone in the org has in a shared space; null for none.
  everyoneRole: everyoneRoleSchema.nullable(),
  // The model ref and reasoning effort its new threads start with; null takes the org's.
  defaultModel: z.string().nullable(),
  defaultEffort: effortSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export type SpaceSummary = z.infer<typeof spaceSchema>;

// A space as a team org's owners see it in the list of all its spaces: who made it, how many people
// and groups have a role there, and whether it has threads, which keep it from being deleted.
export const orgSpaceSchema = spaceSchema.extend({
  ownerName: z.string().nullable(),
  memberCount: z.number().int(),
  hasThreads: z.boolean(),
});

export type OrgSpace = z.infer<typeof orgSpaceSchema>;

export const orgSpacePageSchema = pageSchema(orgSpaceSchema);

// What the org's spaces are narrowed by, besides their names, and their page.
export const orgSpaceFilterSchema = tableQuerySchema.extend({
  kind: z.enum(["personal", "shared"]).optional(),
  everyone: z.enum(["none", "viewer", "messager"]).optional(),
});

export const spaceListSchema = z.array(spaceSchema);

export const spaceNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Null goes back to the org's; a field left out is kept.
export const spaceDefaultsSchema = z
  .object({
    model: z.string().min(1).nullable().optional(),
    effort: effortSchema.nullable().optional(),
  })
  .refine((changes) => changes.model !== undefined || changes.effort !== undefined);

// A person's or group's role in a space: the role given, the role a person ends up with and what
// gives it when it is not their own, the groups that also cover them, and a group's size.
export const spaceGrantSchema = z.object({
  kind: z.enum(["user", "group"]),
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: spaceRoleSchema,
  effective: spaceRoleSchema,
  via: z.string().nullable(),
  // The group that gives the higher role, when one does.
  viaGroupId: z.string().nullable(),
  coveredBy: z.array(z.object({ name: z.string(), role: spaceRoleSchema })),
  memberCount: z.number().int().nullable(),
  // Why the asker may not change it: it is their own, or the space's last owner's.
  locked: lockSchema.nullable(),
});

export type SpaceGrant = z.infer<typeof spaceGrantSchema>;

export const spaceMembersSchema = z.object({
  kind: z.enum(["personal", "shared"]),
  everyoneRole: everyoneRoleSchema.nullable(),
  orgName: z.string(),
  grants: pageSchema(spaceGrantSchema),
});

// What a space's members are narrowed by, besides their names, and their page.
export const spaceMemberFilterSchema = tableQuerySchema.extend({
  role: spaceRoleSchema.optional(),
});

export type SpaceMembers = z.infer<typeof spaceMembersSchema>;

// Gives a person or group a role, or with null takes it away.
export const setSpaceMemberSchema = z.object({
  kind: z.enum(["user", "group"]),
  id: z.string().min(1),
  role: spaceRoleSchema.nullable(),
});

export const setEveryoneSchema = z.object({ role: everyoneRoleSchema.nullable() });

// What a member's first space is stored as; it is shown named for its person.
export const FIRST_SPACE_NAME = "Your space";

// A person's own space, the first of their personal org or the private one a team org gives them:
// it is named for them and cannot be renamed.
export function namedForPerson(space: { kind: "personal" | "shared"; primary: boolean }) {
  return space.kind === "personal" && space.primary;
}

// A space's name as everyone sees it: a person's own space is named for them, following their name;
// any other space goes by its own.
export function spaceNameFor(
  space: { name: string; kind: "personal" | "shared"; primary: boolean },
  ownerName: string,
) {
  return namedForPerson(space) ? `${ownerName}'s Space` : space.name;
}

// Spaces as the API shows them and the bodies that make and rename them and set their defaults,
// shared by the server and the web client.

import * as z from "zod";

import { agentNameSchema, lockSchema } from "@/shared/orgs.ts";
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
  // A member's own space while their org does not allow them: its person may read it, move its
  // threads out and delete them or it, nothing more.
  archived: z.boolean(),
  // The role everyone in the org has in a shared space; null for none.
  everyoneRole: everyoneRoleSchema.nullable(),
  // The model ref and reasoning effort its new threads start with; null takes the org's.
  defaultModel: z.string().nullable(),
  defaultEffort: effortSchema.nullable(),
  // What the agent of its threads goes by where people see it; null takes the org's.
  agentName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type SpaceSummary = z.infer<typeof spaceSchema>;

// A space as a team org's owners see it in the list of all its spaces: who made it, how many people
// and groups have a role there, and how many threads it has, which keep a shared one from being
// deleted.
export const orgSpaceSchema = spaceSchema.extend({
  ownerName: z.string().nullable(),
  memberCount: z.number().int(),
  threadCount: z.number().int(),
});

export type OrgSpace = z.infer<typeof orgSpaceSchema>;

export const orgSpacePageSchema = pageSchema(orgSpaceSchema);

// What the org's spaces are narrowed by, besides their names, and their page.
export const orgSpaceFilterSchema = tableQuerySchema.extend({
  kind: z.enum(["personal", "shared"]).optional(),
  everyone: z.enum(["none", "viewer", "messager"]).optional(),
});

export const spaceListSchema = z.array(spaceSchema);

// A member's own space in trash, as whoever put it there and the org's owners see it.
export const trashedSpaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  trashedByName: z.string().nullable(),
  trashedAt: z.iso.datetime(),
  threadCount: z.number().int(),
});

export type TrashedSpaceSummary = z.infer<typeof trashedSpaceSchema>;

export const trashedSpaceListSchema = z.array(trashedSpaceSchema);

// How long a space stays in trash before it is deleted for good.
export const TRASH_DAYS = 30;

export const spaceNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Null goes back to the org's; a field left out is kept.
export const spaceDefaultsSchema = z
  .object({
    model: z.string().min(1).nullable().optional(),
    effort: effortSchema.nullable().optional(),
    agentName: agentNameSchema.shape.name.nullable().optional(),
  })
  .refine(
    (changes) =>
      changes.model !== undefined ||
      changes.effort !== undefined ||
      changes.agentName !== undefined,
  );

export type SpaceDefaultsChange = z.infer<typeof spaceDefaultsSchema>;

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

// What a person's own space is called to them.
export const OWN_SPACE_NAME = "Personal Space";

// A space's name as a person sees it: their own space is their personal space, someone else's is
// named for its person, following their name; any other space goes by its own.
export function spaceNameFor(
  space: { name: string; kind: "personal" | "shared"; primary: boolean },
  ownerName: string,
  own = false,
) {
  if (!namedForPerson(space)) return space.name;
  return own ? OWN_SPACE_NAME : `${ownerName}'s Space`;
}

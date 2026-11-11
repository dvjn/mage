// Artifacts as the API shows them: pages the agent publishes in a space, who may view them, the
// links that open them on their own origin, and what open viewers are told as they change.

import * as z from "zod";

import { pageSchema } from "@/shared/paging.ts";

// Who may view an artifact: the members of its space, its org's members, or anyone with the link.
export const artifactSharingSchema = z.enum(["space", "org", "public"]);

export type ArtifactSharing = z.infer<typeof artifactSharingSchema>;

// What a person, or the org's members while it is shared with them, may do with an artifact: view
// it, or also change who it is shared with.
export const artifactRoleSchema = z.enum(["view", "edit"]);

export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

// The theme a page is shown in, set as `data-theme` on its root; none leaves it unset.
export const artifactThemeSchema = z.enum(["light", "dark"]);

export type ArtifactTheme = z.infer<typeof artifactThemeSchema>;

export const artifactAssetSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});

export type ArtifactAsset = z.infer<typeof artifactAssetSchema>;

export const artifactVersionSchema = z.object({
  version: z.number().int().positive(),
  label: z.string().nullable(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  // The thread whose agent published it, when the viewer can read it.
  thread: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

// A sharing level the viewer may not choose, and why: all of them, for one who may not share.
export const artifactLevelBlockSchema = z.object({
  level: artifactSharingSchema,
  reason: z.string(),
});

// An artifact as of its newest version, with what the viewer may do with it: change its sharing,
// to which levels, and why not to the others.
export const artifactSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  version: z.number().int().positive(),
  label: z.string().nullable(),
  sharing: artifactSharingSchema,
  // What the org's members may do while it is shared with them.
  orgRole: artifactRoleSchema,
  assets: z.array(artifactAssetSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
  sharingLevels: z.array(artifactSharingSchema),
  sharingBlocked: z.array(artifactLevelBlockSchema),
  // Set for one the viewer reads about in a thread but may not open: only its name is shown.
  locked: z.boolean(),
});

export type Artifact = z.infer<typeof artifactSchema>;

export const artifactDetailSchema = artifactSchema.extend({
  versions: z.array(artifactVersionSchema),
  // The thread it was made in, and the threads that used it, where the viewer can read them.
  madeIn: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  usedIn: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  // Its space, to a member of it.
  space: z.object({ id: z.string(), name: z.string() }).nullable(),
  // For one who may change it: the threads that used it with guests, and whether it is shared with
  // them.
  guestThreads: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      guests: z.number().int().positive(),
      shared: z.boolean(),
    }),
  ),
  // For one who may change it: the groups given access.
  groups: z.array(
    z.object({
      groupId: z.string(),
      name: z.string(),
      memberCount: z.number().int(),
      role: artifactRoleSchema,
    }),
  ),
  // For one who may change it: the people given access, and whether they still have it, which a
  // former member does not.
  people: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      former: z.boolean(),
      guest: z.boolean(),
      role: artifactRoleSchema,
    }),
  ),
  // Where anyone can open it, while it is public.
  publicUrl: z.string().nullable(),
});

export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

// Shares the artifact with the guests of a thread that used it, or stops.
export const artifactGuestShareSchema = z.object({ threadId: z.string(), shared: z.boolean() });

// Someone, or a group, who may be given access to an artifact: a member of its org or a guest of a
// thread that used it. One who has it already says why, and cannot be picked; one who has it only to
// view says at what level, and can be given edit.
export const artifactCandidateSchema = z.object({
  kind: z.enum(["user", "group"]),
  id: z.string(),
  name: z.string(),
  // A person's email, or a group's if it has one; else empty.
  email: z.string(),
  guest: z.boolean(),
  // How many people are in a group.
  memberCount: z.number().int().nullable(),
  already: z.string().nullable(),
  current: z.string().nullable(),
});

export type ArtifactCandidate = z.infer<typeof artifactCandidateSchema>;

export const artifactCandidateQuerySchema = z.object({ q: z.string().max(200).optional() });

// What a thread's artifact says of its guests, for one who may change it in a thread that has
// some: how many, whether it is shared with them, and whether the reader may change that.
export const artifactGuestsSchema = z.object({
  count: z.number().int().positive(),
  shared: z.boolean(),
  canChange: z.boolean(),
});

// The reason a refusal gives for an artifact the reader sees in a thread but has not been given.
export const ARTIFACT_NOT_SHARED = "not_shared";

// Asks for a link to view the artifact: its newest version or the one given, in a theme.
export const artifactViewRequestSchema = z.object({
  version: z.number().int().positive().optional(),
  theme: artifactThemeSchema.optional(),
});

export type ArtifactViewRequest = z.infer<typeof artifactViewRequestSchema>;

// A link to the page on the artifacts' origin, good until it expires; its files load relative to
// it. A new one is asked for before then.
export const artifactViewSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export type ArtifactView = z.infer<typeof artifactViewSchema>;

// A new level, with what the org's members may do at it when that is changed too.
export const artifactSharingChangeSchema = z.object({
  sharing: artifactSharingSchema,
  orgRole: artifactRoleSchema.optional(),
});

// What a person given the artifact may do; a guest of a thread may only view.
export const artifactPersonChangeSchema = z.object({ role: artifactRoleSchema.default("view") });

// Whether artifacts may be made public: for the org, or for a space, whose own switch counts only
// while its org's is on.
export const artifactSettingsSchema = z.object({
  publicAllowed: z.boolean(),
  orgPublicAllowed: z.boolean(),
  canManage: z.boolean(),
});

export type ArtifactSettings = z.infer<typeof artifactSettingsSchema>;

export const artifactSettingsChangeSchema = z.object({ publicAllowed: z.boolean() });

// What an open viewer of an artifact is told: a new version was published, its sharing changed,
// or it was deleted.
export const artifactEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("published"),
    artifactId: z.string(),
    version: z.number().int().positive(),
    label: z.string().nullable(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("sharing"),
    artifactId: z.string(),
    sharing: artifactSharingSchema,
  }),
  z.object({ type: z.literal("deleted"), artifactId: z.string() }),
]);

export type ArtifactEvent = z.infer<typeof artifactEventSchema>;

// The tools whose calls publish or change an artifact; their output names it.
export const ARTIFACT_TOOLSET = "artifact";
export const ARTIFACT_TOOLS = {
  publish: "artifact.publish",
  update: "artifact.update",
  read: "artifact.read",
  list: "artifact.list",
  preview: "artifact.preview",
} as const;

// Which of a space's artifacts the agent's list shows: those this thread used, or all of the space's.
export const artifactScopeSchema = z.enum(["thread", "space"]);

// One artifact in the gallery: what a card shows, and where it was made.
export const artifactListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  sharing: artifactSharingSchema,
  // The thread it was made in, when the viewer can read it.
  madeIn: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  space: z.object({ id: z.string(), name: z.string() }),
});

export type ArtifactListItem = z.infer<typeof artifactListItemSchema>;

export const artifactPageSchema = pageSchema(artifactListItemSchema);

// A page of the gallery.
export const artifactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(1000).optional(),
});

export type ArtifactListQuery = z.infer<typeof artifactListQuerySchema>;

// An artifact in a thread's list: its guests, when the reader may give them access from there.
export const threadArtifactSchema = artifactSchema.extend({
  guests: artifactGuestsSchema.nullable(),
});

export type ThreadArtifact = z.infer<typeof threadArtifactSchema>;

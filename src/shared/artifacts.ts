// Artifacts as the API shows them: pages the agent publishes from a thread, who may view them, the
// links that open them on their own origin, and what open viewers are told as they change.

import * as z from "zod";

import { pageSchema } from "@/shared/paging.ts";

// Who may view an artifact besides the people who can read its thread: no one else, its org's
// members, or anyone with the link.
export const artifactSharingSchema = z.enum(["thread", "org", "public"]);

export type ArtifactSharing = z.infer<typeof artifactSharingSchema>;

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
  threadId: z.string(),
  spaceId: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  version: z.number().int().positive(),
  label: z.string().nullable(),
  sharing: artifactSharingSchema,
  assets: z.array(artifactAssetSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  canShare: z.boolean(),
  sharingLevels: z.array(artifactSharingSchema),
  sharingBlocked: z.array(artifactLevelBlockSchema),
});

export type Artifact = z.infer<typeof artifactSchema>;

export const artifactDetailSchema = artifactSchema.extend({
  versions: z.array(artifactVersionSchema),
  // The thread it was made in, when the viewer can read it.
  thread: z.object({ title: z.string().nullable() }).nullable(),
  // Where anyone can open it, while it is public.
  publicUrl: z.string().nullable(),
});

export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

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

export const artifactSharingChangeSchema = z.object({ sharing: artifactSharingSchema });

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

// The tools whose calls publish, change or delete an artifact; their output names it.
export const ARTIFACT_TOOLSET = "artifact";
export const ARTIFACT_TOOLS = {
  publish: "artifact.publish",
  update: "artifact.update",
  read: "artifact.read",
  list: "artifact.list",
  delete: "artifact.delete",
  preview: "artifact.preview",
} as const;

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
  thread: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  space: z.object({ id: z.string(), name: z.string() }),
});

export type ArtifactListItem = z.infer<typeof artifactListItemSchema>;

export const artifactPageSchema = pageSchema(artifactListItemSchema);

// The gallery narrowed to a space or a sharing level, and its page.
export const artifactListQuerySchema = z.object({
  space: z.string().max(100).optional(),
  sharing: artifactSharingSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(1000).optional(),
});

export type ArtifactListQuery = z.infer<typeof artifactListQuerySchema>;

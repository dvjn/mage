// Spaces as the API shows them and the bodies that make and rename them, shared by the server and
// the web client.

import * as z from "zod";

export const spaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["personal", "shared"]),
  name: z.string(),
  // The space every personal org starts with; it cannot be deleted.
  primary: z.boolean(),
  role: z.enum(["owner", "messager", "viewer"]),
  createdAt: z.iso.datetime(),
});

export type SpaceSummary = z.infer<typeof spaceSchema>;

export const spaceListSchema = z.array(spaceSchema);

export const spaceNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// The name every personal org's first space starts with.
export const FIRST_SPACE_NAME = "Your space";

// A space's name as someone outside its org sees it: another person's untouched first space is
// theirs, not "Your space".
export function outsiderSpaceName(
  space: { name: string; kind: "personal" | "shared"; primary: boolean },
  orgName: string,
) {
  return space.kind === "personal" && space.primary && space.name === FIRST_SPACE_NAME
    ? `${orgName}'s space`
    : space.name;
}

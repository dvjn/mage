// Spaces as the API shows them and the bodies that make and rename them, shared by the server and
// the web client.

import * as z from "zod";

export const spaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["personal", "shared"]),
  name: z.string(),
  // The space every personal org starts with; it cannot be deleted.
  primary: z.boolean(),
  role: z.enum(["owner", "member"]),
  createdAt: z.iso.datetime(),
});

export type SpaceSummary = z.infer<typeof spaceSchema>;

export const spaceListSchema = z.array(spaceSchema);

export const spaceNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

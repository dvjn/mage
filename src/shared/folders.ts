// Folders as the API shows them and the body that makes or renames one, shared by the server and
// the web client.

import * as z from "zod";

export const folderSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type FolderSummary = z.infer<typeof folderSchema>;

export const folderListSchema = z.array(folderSchema);

export const folderNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

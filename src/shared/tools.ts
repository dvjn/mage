// The agent's tools as the API shows them, shared by the server and the web client: Mage's own
// tools, the switches and levels orgs and spaces set for them, and the bodies that change those.

import * as z from "zod";

// Mage's own tools, in the order settings list them.
export const SYSTEM_TOOL_IDS = [
  "thread.info",
  "thread.rename",
  "thread.move",
  "thread.set_model",
] as const;

// What each of Mage's own tools does, as settings name it.
export const TOOL_LABELS: Record<string, string> = {
  "thread.info": "Read the thread's details",
  "thread.rename": "Rename the thread",
  "thread.move": "Move the thread to a folder",
  "thread.set_model": "Change the thread's model",
};

// Whether a person may run a tool, or needs approval for each call.
export const toolLevelSchema = z.enum(["run", "approve"]);

export type ToolLevel = z.infer<typeof toolLevelSchema>;

// A tool in the org's settings: on or off for all its spaces.
export const orgToolSchema = z.object({ id: z.string(), enabled: z.boolean() });

export type OrgTool = z.infer<typeof orgToolSchema>;

export const orgToolListSchema = z.array(orgToolSchema);

export const orgToolChangeSchema = z.object({ toolId: z.string().min(1), enabled: z.boolean() });

// A tool in a space's settings: on there, whether its org left it on, and the level its messagers
// and guests get.
export const spaceToolSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  orgEnabled: z.boolean(),
  messager: toolLevelSchema,
  guest: toolLevelSchema,
});

export type SpaceTool = z.infer<typeof spaceToolSchema>;

export const spaceToolListSchema = z.array(spaceToolSchema);

export const spaceToolChangeSchema = z
  .object({
    toolId: z.string().min(1),
    enabled: z.boolean().optional(),
    messager: toolLevelSchema.optional(),
    guest: toolLevelSchema.optional(),
  })
  .refine(
    (change) =>
      change.enabled !== undefined || change.messager !== undefined || change.guest !== undefined,
  );

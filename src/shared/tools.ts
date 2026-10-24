// The agent's tools as the API shows them, shared by the server and the web client: their
// definitions, the switches and levels orgs and spaces set for them, and the bodies that change
// those.

import * as z from "zod";

// A JSON Schema, as tools describe what they take and give back.
export type JsonSchema = Record<string, unknown>;

// A tool as MCP defines one: its name, which is its id, an optional title and description, and the
// JSON Schemas of its input and, where it says, its output. Mage's own tools come the same way, so
// nothing shows a tool from anything else.
export const toolDefinitionSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

// Whether a person may run a tool, or needs approval for each call.
export const toolLevelSchema = z.enum(["run", "approve"]);

export type ToolLevel = z.infer<typeof toolLevelSchema>;

// A tool in the org's settings: on or off for all its spaces.
export const orgToolSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  definition: toolDefinitionSchema,
});

export type OrgTool = z.infer<typeof orgToolSchema>;

export const orgToolListSchema = z.array(orgToolSchema);

export const orgToolChangeSchema = z.object({ toolId: z.string().min(1), enabled: z.boolean() });

// A tool in a space's settings: on there, whether its org left it on, and the level its messagers
// and guests get.
export const spaceToolSchema = z.object({
  id: z.string(),
  definition: toolDefinitionSchema,
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

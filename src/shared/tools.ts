// The agent's tools as the API shows them, shared by the server and the web client: their
// definitions, the toolsets they come in, the modes and levels orgs and spaces set for them, and the
// bodies that change those.

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

// How a tool is set: allowed, so anyone who can message runs it without asking; asking each time,
// so every call waits for someone who can message; or blocked, so it is off. Strictest first.
export const toolModeSchema = z.enum(["block", "ask", "allow"]);

export type ToolMode = z.infer<typeof toolModeSchema>;

// The stricter of two modes.
export function strictest(a: ToolMode, b: ToolMode): ToolMode {
  const order = toolModeSchema.options;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

// Where a toolset comes from: Mage itself, or an MCP server.
export const toolsetSourceSchema = z.enum(["builtin", "mcp"]);

export type ToolsetSource = z.infer<typeof toolsetSourceSchema>;

// A tool in settings: its definition, the mode the org gives it, and the mode it has where it is
// shown (for the org, the same).
export const toolSettingSchema = z.object({
  id: z.string(),
  definition: toolDefinitionSchema,
  orgMode: toolModeSchema,
  mode: toolModeSchema,
});

export type ToolSetting = z.infer<typeof toolSettingSchema>;

// A toolset in settings: what it is, where it comes from, and its tools.
export const toolsetSettingSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: toolsetSourceSchema,
  tools: z.array(toolSettingSchema),
});

export type ToolsetSetting = z.infer<typeof toolsetSettingSchema>;

export const toolsetSettingListSchema = z.array(toolsetSettingSchema);

// Sets each named tool to the mode, as one change.
export const toolModeChangeSchema = z.object({
  toolIds: z.array(z.string().min(1)).min(1),
  mode: toolModeSchema,
});

export type ToolModeChange = z.infer<typeof toolModeChangeSchema>;

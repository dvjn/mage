// The agent's tools as the API shows them, shared by the server and the web client: their
// definitions, the toolsets they come in, the access policies orgs and spaces keep and assign to
// them, and the bodies that change those.

import * as z from "zod";

// A JSON Schema, as tools describe what they take and give back.
export type JsonSchema = Record<string, unknown>;

// A tool as MCP defines one: its name, which is its id, an optional title and description, and the
// JSON Schemas of its input and, where it says, its output. Mage's own tools come the same way, so
// nothing shows a tool from anything else. Where tools of many toolsets show together, each carries
// its toolset's name: an MCP server's, or that of Mage's own toolset it is in.
export const toolDefinitionSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  toolset: z.string().optional(),
});

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

// The connection of one's own a tool's calls run with, as one person sees it: the server it is to,
// how it is made (signing in, or header values by name), and whether they have one that works.
export const toolConnectionSchema = z.object({
  serverId: z.string(),
  title: z.string(),
  kind: z.enum(["oauth", "headers"]),
  headers: z.array(z.string()),
  connected: z.boolean(),
});

export type ToolConnection = z.infer<typeof toolConnectionSchema>;

// Whether a person may run a tool, or needs approval for each call.
export const toolLevelSchema = z.enum(["run", "approve"]);

export type ToolLevel = z.infer<typeof toolLevelSchema>;

// The colours a policy can be shown in.
export const POLICY_COLORS = [
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "orange",
  "amber",
  "yellow",
  "lime",
  "gray",
] as const;

export const policyColorSchema = z.enum(POLICY_COLORS);

export type PolicyColor = z.infer<typeof policyColorSchema>;

// Who can use a policy's tools without approval: everyone in the thread, only the people and
// groups it lists, or no one.
export const policyUseSchema = z.enum(["everyone", "some", "none"]);

export type PolicyUse = z.infer<typeof policyUseSchema>;

// A person or a linked group a policy names, by a stable key: `user:<id>` or `group:<id>`. As an
// approver, `editors` also stands for anyone who can edit the thread.
export const EDITORS = "editors";

const memberKeySchema = z.string().regex(/^(user|group):.+$/, "Name a person or a group");
const approverKeySchema = z.union([z.literal(EDITORS), memberKeySchema]);

// The kind of identity a key names.
export function identityKind(key: string): "user" | "group" | "editors" {
  if (key === EDITORS) return "editors";
  return key.startsWith("group:") ? "group" : "user";
}

// A policy as it is created or changed. Who approves is asked only when not everyone can use it,
// and then someone must.
export const toolPolicyInputSchema = z
  .object({
    name: z.string().trim().min(1, "A name is required").max(60),
    color: policyColorSchema,
    use: policyUseSchema,
    users: z.array(memberKeySchema).max(200),
    approvers: z.array(approverKeySchema).max(200),
    independent: z.boolean(),
  })
  .refine((policy) => policy.use === "everyone" || policy.approvers.length > 0, {
    message: "Pick at least one approver",
    path: ["approvers"],
  });

export type ToolPolicyInput = z.infer<typeof toolPolicyInputSchema>;

// A person, group, or anyone who can edit the thread, as a policy shows them: a stale one is a
// person or group that is gone or no longer linked, and never matches anyone.
export const policyIdentitySchema = z.object({
  key: z.string(),
  kind: z.enum(["user", "group", "editors"]),
  name: z.string(),
  detail: z.string().nullable(),
  stale: z.boolean(),
});

export type PolicyIdentity = z.infer<typeof policyIdentitySchema>;

// A policy as settings show it: whose it is (the org's when spaceId is null), its rule, and how
// many tools use it, in the org and all its spaces.
export const toolPolicySchema = z.object({
  id: z.string(),
  spaceId: z.string().nullable(),
  name: z.string(),
  color: policyColorSchema,
  use: policyUseSchema,
  users: z.array(policyIdentitySchema),
  approvers: z.array(policyIdentitySchema),
  independent: z.boolean(),
  toolCount: z.number().int(),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const toolPolicyListSchema = z.array(toolPolicySchema);

// What a tool is set to in an org or a space: a policy's id, off, or null when nothing is set.
export const TOOL_OFF = "off";

export const toolAssignmentSchema = z.string().min(1).nullable();

export type ToolAssignment = z.infer<typeof toolAssignmentSchema>;

// Where a toolset comes from: Mage itself, or an MCP server.
export const toolsetSourceSchema = z.enum(["builtin", "mcp"]);

export type ToolsetSource = z.infer<typeof toolsetSourceSchema>;

// A tool in settings: its definition, what the org set it to, and what the scope shown set it to
// (for the org, the same; for a space, its extra rule on the org's tools, or its own choice on
// its own).
export const toolSettingSchema = z.object({
  id: z.string(),
  definition: toolDefinitionSchema,
  orgPolicy: toolAssignmentSchema,
  policy: toolAssignmentSchema,
  // Always on, with no policy.
  fixed: z.boolean().optional(),
});

export type ToolSetting = z.infer<typeof toolSettingSchema>;

// A toolset in settings: what it is, where it comes from, whether the org or the space has it, and
// its tools.
export const toolsetSettingSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: toolsetSourceSchema,
  scope: z.enum(["org", "space"]),
  // What a toolset of no tools is for.
  description: z.string().optional(),
  // Always on: its switch cannot turn it off.
  fixed: z.boolean().optional(),
  // Built-in toolset switches; MCP servers expose their switches through server settings.
  enabled: z.boolean().optional(),
  orgEnabled: z.boolean().optional(),
  // A built-in toolset's options, each off unless set on: whether it is on, and whether the org has
  // it on.
  options: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        enabled: z.boolean(),
        orgEnabled: z.boolean(),
      }),
    )
    .optional(),
  tools: z.array(toolSettingSchema),
});

export type ToolsetSetting = z.infer<typeof toolsetSettingSchema>;

export const toolsetSettingListSchema = z.array(toolsetSettingSchema);

// Sets each named tool to a policy, to off, or with null back to nothing set, as one change.
export const toolPolicyChangeSchema = z.object({
  toolIds: z.array(z.string().min(1)).min(1),
  policy: toolAssignmentSchema,
});

export type ToolPolicyChange = z.infer<typeof toolPolicyChangeSchema>;

export const toolsetEnabledChangeSchema = z.object({ enabled: z.boolean() });

// Built-in tools by the ids they had before, so calls made under those still show as theirs.
export const FORMER_TOOL_IDS: Readonly<Record<string, string>> = {
  "tools.search": "mcp_servers.search_tools",
  "resource.list": "mcp_servers.list_resources",
  "resource.read": "mcp_servers.read_resource",
  "mcp._.search_tools": "mcp_servers.search_tools",
  "mcp._.list_resources": "mcp_servers.list_resources",
  "mcp._.read_resource": "mcp_servers.read_resource",
  "helpers.start": "subagents.start",
  "helpers.message": "subagents.send",
  "helpers.status": "subagents.list",
  "helpers.wait": "subagents.watch",
  "subagents.wait": "subagents.watch",
  "helpers.stop": "subagents.stop",
  "helpers.archive": "subagents.archive",
};

// The id the tool a call was made under has now.
export function toolIdNow(toolId: string) {
  return FORMER_TOOL_IDS[toolId] ?? toolId;
}

// The most characters providers take in a tool's name.
export const WIRE_NAME_MAX = 64;

// A tool's name for the model as providers take it: letters, digits, `_` and `-`, each dot as two
// underscores and anything else as one.
export function wireToolName(name: string) {
  return name.replaceAll(".", "__").replace(/[^a-zA-Z0-9_-]/g, "_");
}

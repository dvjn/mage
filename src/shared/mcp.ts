// MCP servers as the API shows them, shared by the server and the web client: what is not secret
// about each, how it answered when last reached, and the bodies that add, change and authorize one;
// a change is the add body again, its stored secrets left out to keep them.
// An org's owners add servers for all its spaces; a space's managers add them for that space.

import * as z from "zod";

import { OWNED_HEADERS } from "@/shared/connections.ts";

// The transports Mage reaches servers on: Streamable HTTP, or the older HTTP+SSE.
export const mcpTransportSchema = z.enum(["streamable-http", "sse"]);

export type McpTransport = z.infer<typeof mcpTransportSchema>;

// Whether it answered when last reached, needs authorizing again, or failed.
export const mcpStatusSchema = z.enum(["ok", "needs_auth", "error"]);

export type McpStatus = z.infer<typeof mcpStatusSchema>;

export const mcpAuthKindSchema = z.enum(["none", "headers", "oauth"]);

export type McpAuthKind = z.infer<typeof mcpAuthKindSchema>;

// A stored header as people may see it again: its name, and the end of its value.
export const mcpHeaderSummarySchema = z.object({ name: z.string(), hint: z.string() });

// How a server is authorized, without its secrets: headers by name; for OAuth, the client Mage
// is (registered by the server itself, or entered, with the end of its secret), the authorization
// server, and whether Mage holds tokens.
export const mcpAuthSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("headers"), headers: z.array(mcpHeaderSummarySchema) }),
  z.object({
    kind: z.literal("oauth"),
    clientId: z.string().nullable(),
    clientSecretHint: z.string().nullable(),
    registration: z.enum(["dynamic", "manual"]).nullable(),
    issuer: z.string().nullable(),
    authorized: z.boolean(),
  }),
]);

export type McpAuthSummary = z.infer<typeof mcpAuthSummarySchema>;

export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  // The space it was added for; null for the whole org.
  spaceId: z.string().nullable(),
  auth: mcpAuthSummarySchema,
  transport: mcpTransportSchema.nullable(),
  // The protocol revision it last answered with.
  protocolVersion: z.string().nullable(),
  status: mcpStatusSchema,
  error: z.string().nullable(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
  toolCount: z.number(),
  toolsReadAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type McpServerSummary = z.infer<typeof mcpServerSchema>;

export const mcpServerListSchema = z.array(mcpServerSchema);

// The servers of an org, and whether its spaces may add their own.
export const orgMcpServersSchema = z.object({
  servers: mcpServerListSchema,
  spaceServers: z.boolean(),
});

export type OrgMcpServers = z.infer<typeof orgMcpServersSchema>;

// A space's own servers, and whether the org lets it have them.
export const spaceMcpServersSchema = z.object({
  servers: mcpServerListSchema,
  allowed: z.boolean(),
});

export type SpaceMcpServers = z.infer<typeof spaceMcpServersSchema>;

export const spaceServersChangeSchema = z.object({ allowed: z.boolean() });

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Headers the transports set themselves, which a server's headers may not change.
const MCP_OWNED_HEADERS = [
  ...OWNED_HEADERS.filter((name) => name !== "authorization"),
  "accept",
  "content-length",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

// Headers as they are set, by name: a null value keeps the one stored. Names are kept in lower
// case, each once.
export const mcpHeadersInputSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1, "Give each header a name").max(200),
      value: z
        .string()
        .min(1, "Give each header a value")
        .max(8000)
        .regex(/^[^\r\n]*$/, "Header values are one line")
        .nullable(),
    }),
  )
  .max(20, "At most 20 headers")
  .superRefine((headers, ctx) => {
    const names = headers.map((header) => header.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "Give each header once" });
    }
    for (const name of names) {
      if (!HEADER_NAME.test(name)) {
        ctx.addIssue({ code: "custom", message: `${name} is not a header name` });
      } else if (MCP_OWNED_HEADERS.includes(name)) {
        ctx.addIssue({ code: "custom", message: `Mage sets ${name} itself` });
      }
    }
  })
  .transform((headers) =>
    headers.map((header) => ({ name: header.name.toLowerCase(), value: header.value })),
  );

export type McpHeadersInput = z.infer<typeof mcpHeadersInputSchema>;

// How a server is authorized: not at all, by headers (a bearer token is an Authorization header),
// or by OAuth with a client the server registers itself or one entered here. On a change, a null
// header value or client secret keeps the stored one.
export const mcpAuthInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("headers"), headers: mcpHeadersInputSchema }),
  z.object({
    kind: z.literal("oauth"),
    clientId: z.string().trim().max(500).nullable(),
    clientSecret: z.string().max(2000).nullable(),
  }),
]);

export type McpAuthInput = z.infer<typeof mcpAuthInputSchema>;

export const mcpServerNameSchema = z.string().trim().min(1).max(80);

// An http(s) address; local and private addresses are fine, as people run servers beside Mage.
export const mcpUrlSchema = z
  .url({ protocol: /^https?$/, error: "Give an http or https address" })
  .max(2000);

export const newMcpServerSchema = z.object({
  name: mcpServerNameSchema,
  url: mcpUrlSchema,
  auth: mcpAuthInputSchema,
});

export type NewMcpServer = z.infer<typeof newMcpServerSchema>;

// A new name, address or authorization; what is left out stays.
export const mcpServerChangeSchema = z.object({
  name: mcpServerNameSchema.optional(),
  url: mcpUrlSchema.optional(),
  auth: mcpAuthInputSchema.optional(),
});

export type McpServerChange = z.infer<typeof mcpServerChangeSchema>;

// Where to send the browser to authorize Mage, or the server when it needed no one to.
export const mcpAuthorizeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("redirect"), url: z.url() }),
  z.object({ status: z.literal("authorized"), server: mcpServerSchema }),
]);

export type McpAuthorize = z.infer<typeof mcpAuthorizeSchema>;

// The id of the toolset a server's tools come in, and of each of its tools.
export function mcpToolsetId(serverId: string) {
  return `mcp:${serverId}`;
}

export function mcpToolId(serverId: string, toolName: string) {
  return `mcp:${serverId}/${toolName}`;
}

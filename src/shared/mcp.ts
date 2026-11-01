// MCP servers as the API shows them, shared by the server and the web client: what is not secret
// about each, whether it is on, how it answered when last reached, and the bodies that add, change,
// authorize and turn one on or off; a change is the add body again, its stored secrets left out to
// keep them. An org's owners add servers for all its spaces; a space's managers add them for that
// space, and may turn one of the org's off for the space alone. A server whose people each connect
// their own credentials lists each person's connections, and takes what they connect with.

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

// Whose credentials its tools are called with: one set everyone shares, or each person's own, the
// shared set then only reading its tools.
export const mcpCredentialModeSchema = z.enum(["shared", "personal"]);

export type McpCredentialMode = z.infer<typeof mcpCredentialModeSchema>;

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
  // What the agent calls it: its tools are mcp.<slug>.<tool> to the model.
  slug: z.string(),
  url: z.string(),
  // The space it was added for; null for the whole org.
  spaceId: z.string().nullable(),
  // Whether it offers its tools; one turned off keeps its connection and tools.
  enabled: z.boolean(),
  auth: mcpAuthSummarySchema,
  credentials: mcpCredentialModeSchema,
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

// One of the org's servers as a space sees it: with whether the space uses it. One the org turned
// off is off in the space whatever the space set.
export const spaceOrgMcpServerSchema = mcpServerSchema.extend({ inSpace: z.boolean() });

export type SpaceOrgMcpServer = z.infer<typeof spaceOrgMcpServerSchema>;

// The servers a space has: the org's, each with whether the space uses it, and its own, with
// whether the org lets it have its own.
export const spaceMcpServersSchema = z.object({
  org: z.array(spaceOrgMcpServerSchema),
  own: mcpServerListSchema,
  allowed: z.boolean(),
});

export type SpaceMcpServers = z.infer<typeof spaceMcpServersSchema>;

export const spaceServersChangeSchema = z.object({ allowed: z.boolean() });

// Turning a server on or off: for everyone, or for one space.
export const mcpEnabledChangeSchema = z.object({ enabled: z.boolean() });

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

// A server's short name for the agent: lower case letters, digits, `_` and `-`.
export const mcpSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Use up to 32 lower-case letters, digits, - and _");

// A name as a server's short name; "server" when nothing of it is left.
export function mcpSlugOf(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 32)
      .replace(/[-_]+$/, "") || "server"
  );
}

// An http(s) address; local and private addresses are fine, as people run servers beside Mage.
export const mcpUrlSchema = z
  .url({ protocol: /^https?$/, error: "Give an http or https address" })
  .max(2000);

export const newMcpServerSchema = z.object({
  name: mcpServerNameSchema,
  // Made from the name when not given.
  slug: mcpSlugSchema.optional(),
  url: mcpUrlSchema,
  auth: mcpAuthInputSchema,
  // Shared when not given.
  credentials: mcpCredentialModeSchema.optional(),
});

export type NewMcpServer = z.infer<typeof newMcpServerSchema>;

// A new name, address or authorization; what is left out stays.
export const mcpServerChangeSchema = z.object({
  name: mcpServerNameSchema.optional(),
  slug: mcpSlugSchema.optional(),
  url: mcpUrlSchema.optional(),
  auth: mcpAuthInputSchema.optional(),
  credentials: mcpCredentialModeSchema.optional(),
});

export type McpServerChange = z.infer<typeof mcpServerChangeSchema>;

// Where to send the browser to authorize Mage, or the server when it needed no one to.
export const mcpAuthorizeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("redirect"), url: z.url() }),
  z.object({ status: z.literal("authorized"), server: mcpServerSchema }),
]);

export type McpAuthorize = z.infer<typeof mcpAuthorizeSchema>;

// A server whose people each connect their own credentials, as one person sees it: where it is
// used, how one connects to it, and whether they have, whether it worked when last used or needs
// connecting again, and since when.
export const mcpConnectionSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  // The space the server was added for; null for the whole org.
  spaceId: z.string().nullable(),
  kind: z.enum(["oauth", "headers"]),
  headers: z.array(z.string()),
  status: z.enum(["ok", "needs_auth"]).nullable(),
  connectedAt: z.iso.datetime().nullable(),
});

export type McpConnection = z.infer<typeof mcpConnectionSchema>;

export const mcpConnectionListSchema = z.array(mcpConnectionSchema);

// A person's own header values, by the names the server is sent.
export const mcpConnectHeadersSchema = z.object({
  headers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        value: z
          .string()
          .min(1, "Give each header a value")
          .max(8000)
          .regex(/^[^\r\n]*$/, "Header values are one line"),
      }),
    )
    .min(1)
    .max(20),
});

export type McpConnectHeaders = z.infer<typeof mcpConnectHeadersSchema>;

// Signing in with the server as oneself, and the page of Mage to come back to.
export const mcpConnectAuthorizeSchema = z.object({
  returnTo: z
    .string()
    .max(500)
    .regex(/^\/(?![/\\])/, "Give a path in Mage")
    .optional(),
});

// Where to send the browser to sign in, or that the tokens held still worked.
export const mcpConnectResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("redirect"), url: z.url() }),
  z.object({ status: z.literal("connected") }),
]);

export type McpConnectResult = z.infer<typeof mcpConnectResultSchema>;

// The id of the toolset a server's tools come in, and of each of its tools.
export function mcpToolsetId(serverId: string) {
  return `mcp:${serverId}`;
}

export function mcpToolId(serverId: string, toolName: string) {
  return `mcp:${serverId}/${toolName}`;
}

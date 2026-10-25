// MCP servers an org or one of its spaces added, the secrets each is reached with, and the client
// that reaches them: listing their tools and calling one, each over a connection of its own, with
// headers or OAuth, and authorizing Mage with a server's authorization server.

import type { McpAuthKind, McpStatus, McpTransport } from "@/shared/mcp.ts";
import type { ToolDefinition } from "@/shared/tools.ts";

export interface McpServer {
  id: string;
  orgId: string;
  // The space it was added for; null for the whole org.
  spaceId: string | null;
  name: string;
  url: string;
  authKind: McpAuthKind;
  // What is not secret about its authorization.
  settings: McpSettings;
  transport: McpTransport | null;
  status: McpStatus;
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  // The tools it last listed, as MCP defines them.
  tools: ToolDefinition[];
  toolsReadAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface McpSettings {
  // Header names, each with the end of its value.
  headers?: { name: string; hint: string }[];
  // The OAuth client: entered by people, or registered by the authorization server; its issuer.
  clientId?: string | null;
  registration?: "dynamic" | "manual" | null;
  issuer?: string | null;
}

export type NewMcpServer = Pick<
  McpServer,
  "orgId" | "spaceId" | "name" | "url" | "authKind" | "settings"
> & { createdBy: string };

export type McpServerChanges = Partial<
  Pick<
    McpServer,
    "name" | "settings" | "transport" | "status" | "error" | "serverInfo" | "tools" | "toolsReadAt"
  >
>;

export interface McpServerStore {
  create(server: NewMcpServer): McpServer;
  find(id: string): McpServer | null;
  // The org's own servers, for all its spaces.
  inOrg(orgId: string): McpServer[];
  // The servers added for a space.
  inSpace(spaceId: string): McpServer[];
  update(id: string, changes: McpServerChanges): void;
  delete(id: string): void;
}

// Whose secrets a call goes with: the ones the server shares with everyone who uses it, or later
// one person's own.
export type McpHolder = { kind: "shared" } | { kind: "user"; userId: string };

// A server's secrets: the headers it is sent, or the OAuth client Mage is with its authorization
// server, the tokens it gave, and what discovery found.
export interface McpSecrets {
  headers?: Record<string, string>;
  oauth?: McpOAuthState;
}

export interface McpOAuthState {
  client?: Record<string, unknown>;
  // Whether people entered the client, so that it is kept when the server forgets it.
  manual?: boolean;
  tokens?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
}

export interface McpCredentialStore {
  get(serverId: string, holder: McpHolder): McpSecrets | null;
  put(serverId: string, holder: McpHolder, secrets: McpSecrets): void;
  delete(serverId: string, holder: McpHolder): void;
}

// How a client authorizes itself with a server: not at all, with headers, or with OAuth state it
// reads and saves as the flow goes.
export type McpAuth =
  | { kind: "none" }
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "oauth"; state: McpOAuthStore };

export interface McpOAuthStore {
  load(): McpOAuthState;
  save(state: McpOAuthState): void;
}

export interface McpTarget {
  url: string;
  // The transport it answered on before, tried first; null tries Streamable HTTP, then HTTP+SSE.
  transport: McpTransport | null;
  auth: McpAuth;
}

export interface McpListing {
  transport: McpTransport;
  serverInfo: { name: string; version: string } | null;
  tools: ToolDefinition[];
}

// MCP's result of a tool call: its content, structured content where the tool gives some, and
// whether it is an error.
export interface McpCallResult {
  content: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// Why a server could not be reached: it needs authorizing (again), or it failed.
export class McpError extends Error {
  readonly kind: "needs_auth" | "error";

  constructor(kind: McpError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

// The OAuth client Mage registers as, and where the authorization server sends people back.
export interface McpOAuthClient {
  redirectUrl: string;
  clientName: string;
}

export interface McpClient {
  // Throws McpError.
  list(target: McpTarget): Promise<McpListing>;
  call(
    target: McpTarget,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  // Starts authorizing Mage: the address to send the person to, with `state` and the PKCE
  // verifier kept in `pending`; or null when the tokens held are still good or were renewed.
  authorize(
    url: string,
    oauth: McpOAuthStore,
    state: string,
    pending: { value?: string },
  ): Promise<string | null>;
  // Finishes it with the code the authorization server sent back.
  finish(
    url: string,
    oauth: McpOAuthStore,
    verifier: string,
    callback: { code: string; iss?: string },
  ): Promise<void>;
}

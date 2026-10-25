// MCP servers as toolsets: an org's owners add servers every space of the org uses, and a space's
// managers add servers that space alone uses, unless the org turned that off. Each server is
// reached with no authorization, with headers, or with OAuth that someone who manages it completes
// once in the browser for everyone; its secrets stay sealed and never leave the server. The tools a
// server lists are kept and offered from there until it is read again, and each call goes to the
// server with the secrets of whoever the call runs as: today always the ones the server shares.

import { randomBytes } from "node:crypto";

import * as z from "zod";

import type { Principal } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";
import {
  type McpCallResult,
  type McpClient,
  type McpCredentialStore,
  McpError,
  type McpHolder,
  type McpOAuthStore,
  type McpSecrets,
  type McpServer,
  type McpServerStore,
  type McpSettings,
  type McpTarget,
} from "@/ports/mcp.ts";
import type { OrgSettingStore } from "@/ports/org-settings.ts";
import type { Space } from "@/ports/spaces.ts";
import type { AnyToolSpec, ToolContext, ToolOutput, Toolset } from "@/ports/tools.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Spaces } from "@/services/spaces.ts";
import {
  type McpAuthSummary,
  type McpHeadersInput,
  type McpServerChange,
  type McpServerSummary,
  mcpToolId,
  mcpToolsetId,
  type NewMcpServer,
} from "@/shared/mcp.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import type { ToolDefinition } from "@/shared/tools.ts";

export interface McpServersOptions {
  servers: McpServerStore;
  credentials: McpCredentialStore;
  client: McpClient;
  spaces: Pick<Spaces, "require">;
  settings: Pick<OrgSettingStore, "get" | "setSpaceMcpServers">;
  logger: Logger;
  now?: () => Date;
}

export type McpServers = ReturnType<typeof createMcpServers>;

// Whose secrets a call goes with, and the call they go with: who approved it, when someone did.
export interface McpCaller {
  approvedBy: string | null;
}

// How long an authorization begun in the browser may take.
const AUTHORIZE_TTL_MS = 10 * 60 * 1000;

const SHARED: McpHolder = { kind: "shared" };

const ORG_ONLY = "Only the organization's owners can manage its MCP servers";
const SPACES_OFF = "The organization does not let spaces add MCP servers";

// A begun authorization, by the state the authorization server sends back.
interface Pending {
  serverId: string;
  holder: McpHolder;
  userId: string;
  verifier: { value?: string };
  expiresAt: number;
}

// Any input object; the server checks it against its own schema.
const anyInput = z.record(z.string(), z.unknown());

// The end of a secret, as people may see it again.
export function secretHint(value: string) {
  return value.length >= 12 ? `…${value.slice(-4)}` : "••••";
}

// How much a call can do, from what the server says of the tool: one it marks destructive asks
// each time; anything else follows the people in the thread.
export function riskOfAnnotations(annotations: Record<string, unknown> | undefined): ToolRisk {
  return annotations?.destructiveHint === true && annotations.readOnlyHint !== true
    ? "ask"
    : "normal";
}

function textOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

// A tool's result as the thread keeps it: its structured content, else its text, or why it failed.
export function outputOf(result: McpCallResult): ToolOutput {
  const text = result.content
    .map((part) => {
      switch (part.type) {
        case "text":
          return textOf(part.text);
        case "resource_link":
          return `${textOf(part.name)} ${textOf(part.uri)}`.trim();
        case "resource": {
          const resource = (part.resource ?? {}) as { text?: string; uri?: string };
          return resource.text ?? resource.uri ?? "";
        }
        default:
          return `[${[part.type, part.mimeType].map(textOf).filter(Boolean).join(" ")}]`;
      }
    })
    .filter(Boolean)
    .join("\n");
  if (result.isError) return { ok: false, error: text || "The tool failed." };
  return { ok: true, value: result.structuredContent ?? text };
}

// Headers as the server keeps them: a value left out keeps the one stored under its name.
export function mergeHeaders(input: McpHeadersInput, stored: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  for (const { name, value } of input) {
    const kept = value ?? stored[name];
    if (kept === undefined) throw new ServiceError(400, `Give a value for ${name}`);
    headers[name] = kept;
  }
  return headers;
}

function headerHints(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => ({ name, hint: secretHint(value) }));
}

export function createMcpServers(options: McpServersOptions) {
  const { servers, credentials, client, spaces, settings, logger } = options;
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, Pending>();

  // Where a server's OAuth state is kept: with whoever's secrets they are.
  function oauthStore(serverId: string, holder: McpHolder): McpOAuthStore {
    return {
      load: () => credentials.get(serverId, holder)?.oauth ?? {},
      save(state) {
        const secrets = credentials.get(serverId, holder) ?? {};
        credentials.put(serverId, holder, { ...secrets, oauth: state });
      },
    };
  }

  // Whose secrets a call of the server's tools goes with. Every server shares one set today; a
  // server whose people each connect their own would pick the approver's here.
  function holderFor(_server: McpServer, _caller: McpCaller): McpHolder {
    return SHARED;
  }

  function targetOf(server: McpServer, holder: McpHolder): McpTarget {
    const secrets = credentials.get(server.id, holder);
    return {
      url: server.url,
      transport: server.transport,
      auth:
        server.authKind === "headers"
          ? { kind: "headers", headers: secrets?.headers ?? {} }
          : server.authKind === "oauth"
            ? { kind: "oauth", state: oauthStore(server.id, holder) }
            : { kind: "none" },
    };
  }

  function authSummary(server: McpServer): McpAuthSummary {
    const { settings: own } = server;
    switch (server.authKind) {
      case "none":
        return { kind: "none" };
      case "headers":
        return { kind: "headers", headers: own.headers ?? [] };
      case "oauth": {
        const oauth = credentials.get(server.id, SHARED)?.oauth;
        return {
          kind: "oauth",
          clientId: own.clientId ?? null,
          registration: own.registration ?? null,
          issuer: own.issuer ?? null,
          authorized: !!oauth?.tokens,
        };
      }
    }
  }

  function summary(server: McpServer): McpServerSummary {
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      spaceId: server.spaceId,
      auth: authSummary(server),
      transport: server.transport,
      status: server.status,
      error: server.error,
      serverInfo: server.serverInfo,
      toolCount: server.tools.length,
      toolsReadAt: server.toolsReadAt?.toISOString() ?? null,
      createdAt: server.createdAt.toISOString(),
    };
  }

  function spacesMayAdd(orgId: string) {
    return settings.get(orgId).spaceMcpServers;
  }

  // The server when the principal may manage it: an org's own by its owners, a space's by those
  // who manage the space. One they cannot see is not found.
  function manageable(principal: Principal, id: string) {
    const server = servers.find(id);
    if (!server || server.orgId !== principal.orgId) {
      throw new ServiceError(404, "MCP server not found");
    }
    if (server.spaceId) spaces.require(principal, server.spaceId, "manage");
    else if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
    return server;
  }

  // Reads the server's tools again, and keeps them with how it answered.
  async function refreshed(server: McpServer) {
    try {
      const listing = await client.list(targetOf(server, SHARED));
      servers.update(server.id, {
        transport: listing.transport,
        serverInfo: listing.serverInfo,
        tools: listing.tools,
        toolsReadAt: now(),
        status: "ok",
        error: null,
      });
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      logger.info({ serverId: server.id, err: err.message }, "mcp server unreachable");
      servers.update(server.id, { status: err.kind, error: err.message });
    }
    oauthSettled(server.id);
    return servers.find(server.id)!;
  }

  // Notes the OAuth client and authorization server the shared tokens came from.
  function oauthSettled(serverId: string) {
    const server = servers.find(serverId);
    if (server?.authKind !== "oauth") return;
    const oauth = credentials.get(serverId, SHARED)?.oauth;
    const clientId = (oauth?.client?.client_id as string | undefined) ?? null;
    const issuer = (oauth?.tokens?.issuer as string | undefined) ?? server.settings.issuer ?? null;
    const registration = clientId ? (oauth?.manual ? "manual" : "dynamic") : null;
    const next: McpSettings = { ...server.settings, clientId, issuer, registration };
    if (JSON.stringify(next) !== JSON.stringify(server.settings)) {
      servers.update(serverId, { settings: next });
    }
  }

  // The server's tools as Mage offers them, each call sent to it.
  function toolsetOf(server: McpServer): Toolset {
    return {
      id: mcpToolsetId(server.id),
      title: server.name,
      source: "mcp",
      tools: server.tools.map((definition) => specOf(server, definition)),
    };
  }

  function specOf(server: McpServer, definition: ToolDefinition): AnyToolSpec {
    return {
      name: mcpToolId(server.id, definition.name),
      title: definition.title ?? definition.name,
      description: definition.description ?? definition.title ?? definition.name,
      input: anyInput,
      inputSchema: definition.inputSchema,
      ...(definition.outputSchema && { outputSchema: definition.outputSchema }),
      ...(definition.annotations && { annotations: definition.annotations }),
      risk: () => riskOfAnnotations(definition.annotations),
      run: (input, ctx) => call(server.id, definition.name, input as Record<string, unknown>, ctx),
    };
  }

  // Calls the tool on the server, as whoever the call runs as. A server that cannot be reached
  // says why, and is marked so for those who manage it.
  async function call(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    ctx: Pick<ToolContext, "approvedBy">,
  ): Promise<ToolOutput> {
    const server = servers.find(serverId);
    if (!server) return { ok: false, error: "This MCP server was removed." };
    const holder = holderFor(server, { approvedBy: ctx.approvedBy });
    try {
      const result = await client.call(targetOf(server, holder), name, args);
      if (server.status !== "ok") servers.update(server.id, { status: "ok", error: null });
      return outputOf(result);
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      if (holder.kind === "shared")
        servers.update(server.id, { status: err.kind, error: err.message });
      const after =
        err.kind === "needs_auth"
          ? " Someone who manages it needs to reconnect it in settings."
          : "";
      return { ok: false, error: `${server.name}: ${err.message}${after}` };
    }
  }

  // The secrets a new server is kept with.
  function secretsOf(input: NewMcpServer): { secrets: McpSecrets | null; settings: McpSettings } {
    const { auth } = input;
    switch (auth.kind) {
      case "none":
        return { secrets: null, settings: {} };
      case "headers": {
        const headers = mergeHeaders(auth.headers);
        return { secrets: { headers }, settings: { headers: headerHints(headers) } };
      }
      case "oauth": {
        if (!auth.clientId) return { secrets: { oauth: {} }, settings: { registration: null } };
        const client = {
          client_id: auth.clientId,
          ...(auth.clientSecret && { client_secret: auth.clientSecret }),
        };
        return {
          secrets: { oauth: { client, manual: true } },
          settings: { clientId: auth.clientId, registration: "manual" },
        };
      }
    }
  }

  async function add(principal: Principal, spaceId: string | null, input: NewMcpServer) {
    if (spaceId) {
      spaces.require(principal, spaceId, "manage");
      if (!spacesMayAdd(principal.orgId)) throw new ServiceError(403, SPACES_OFF);
    } else if (principal.role !== "owner") {
      throw new ServiceError(403, ORG_ONLY);
    }
    const { secrets, settings: own } = secretsOf(input);
    const server = servers.create({
      orgId: principal.orgId,
      spaceId,
      name: input.name,
      url: input.url,
      authKind: input.auth.kind,
      settings: own,
      createdBy: principal.userId,
    });
    if (secrets) credentials.put(server.id, SHARED, secrets);
    // One authorized by OAuth is read once someone authorizes Mage.
    if (input.auth.kind === "oauth") {
      servers.update(server.id, { status: "needs_auth" });
      return summary(servers.find(server.id)!);
    }
    return summary(await refreshed(server));
  }

  return {
    holderFor,
    summary,

    // The org's own servers, which its members may read, and whether its spaces may add theirs.
    orgServers(principal: Principal) {
      return {
        servers: servers.inOrg(principal.orgId).map(summary),
        spaceServers: spacesMayAdd(principal.orgId),
      };
    },

    setSpaceServers(principal: Principal, allowed: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
      settings.setSpaceMcpServers(principal.orgId, allowed);
    },

    // A space's own servers, for those who manage it.
    spaceServers(principal: Principal, spaceId: string) {
      const space = spaces.require(principal, spaceId, "manage");
      return {
        servers: servers.inSpace(space.id).map(summary),
        allowed: spacesMayAdd(space.orgId),
      };
    },

    // The server for anyone who may read it: an org's by its members, a space's by those who
    // manage the space.
    get(principal: Principal, id: string) {
      const server = servers.find(id);
      if (!server || server.orgId !== principal.orgId) {
        throw new ServiceError(404, "MCP server not found");
      }
      if (server.spaceId) spaces.require(principal, server.spaceId, "manage");
      return summary(server);
    },

    addToOrg(principal: Principal, input: NewMcpServer) {
      return add(principal, null, input);
    },

    addToSpace(principal: Principal, spaceId: string, input: NewMcpServer) {
      return add(principal, spaceId, input);
    },

    // Renames the server, or sets its headers and reads it again with them.
    async change(principal: Principal, id: string, change: McpServerChange) {
      const server = manageable(principal, id);
      if (change.name) servers.update(id, { name: change.name });
      if (change.headers) {
        if (server.authKind !== "headers") {
          throw new ServiceError(400, "This server is not authorized by headers");
        }
        const stored = credentials.get(id, SHARED) ?? {};
        const headers = mergeHeaders(change.headers, stored.headers);
        credentials.put(id, SHARED, { ...stored, headers });
        servers.update(id, { settings: { ...server.settings, headers: headerHints(headers) } });
        return summary(await refreshed(servers.find(id)!));
      }
      return summary(servers.find(id)!);
    },

    // Reads the server's tools again.
    async refresh(principal: Principal, id: string) {
      return summary(await refreshed(manageable(principal, id)));
    },

    remove(principal: Principal, id: string) {
      manageable(principal, id);
      servers.delete(id);
    },

    // Starts authorizing Mage with the server's authorization server, for everyone who uses it:
    // where to send the browser, or the server read again when its tokens were still good.
    async authorize(principal: Principal, id: string) {
      const server = manageable(principal, id);
      if (server.authKind !== "oauth") {
        throw new ServiceError(400, "This server is not authorized by OAuth");
      }
      for (const [key, attempt] of pending) {
        if (attempt.expiresAt <= now().getTime()) pending.delete(key);
      }
      const state = randomBytes(24).toString("base64url");
      const attempt: Pending = {
        serverId: id,
        holder: SHARED,
        userId: principal.userId,
        verifier: {},
        expiresAt: now().getTime() + AUTHORIZE_TTL_MS,
      };
      let url: string | null;
      try {
        url = await client.authorize(server.url, oauthStore(id, SHARED), state, attempt.verifier);
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        servers.update(id, { status: "needs_auth", error: err.message });
        throw new ServiceError(502, err.message);
      }
      if (url) {
        pending.set(state, attempt);
        return { status: "redirect" as const, url };
      }
      return { status: "authorized" as const, server: summary(await refreshed(server)) };
    },

    // Finishes an authorization the authorization server sent the browser back from, for the
    // person who began it: the server's tools read again, and the page to go back to with what
    // went wrong, if anything.
    async finishAuthorization(
      userId: string | null,
      query: { state?: string; code?: string; iss?: string; error?: string },
    ): Promise<{ server: McpServer | null; error: string | null }> {
      const attempt = query.state ? pending.get(query.state) : undefined;
      if (!attempt || attempt.expiresAt <= now().getTime() || attempt.userId !== userId) {
        return { server: null, error: "This authorization expired. Try again." };
      }
      pending.delete(query.state!);
      const server = servers.find(attempt.serverId);
      if (!server) return { server: null, error: "MCP server not found" };
      if (query.error || !query.code || !attempt.verifier.value) {
        const error = `The authorization server said: ${query.error ?? "no code"}.`;
        servers.update(server.id, { status: "needs_auth", error });
        return { server, error };
      }
      try {
        await client.finish(
          server.url,
          oauthStore(server.id, attempt.holder),
          attempt.verifier.value,
          { code: query.code, ...(query.iss && { iss: query.iss }) },
        );
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        servers.update(server.id, { status: "needs_auth", error: err.message });
        return { server, error: err.message };
      }
      const read = await refreshed(server);
      return { server: read, error: read.status === "ok" ? null : read.error };
    },

    // The servers every space of the org uses, as toolsets.
    toolsetsInOrg(orgId: string): Toolset[] {
      return servers.inOrg(orgId).map(toolsetOf);
    },

    // The space's own servers, as toolsets, while the org lets spaces have them.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">): Toolset[] {
      if (!spacesMayAdd(space.orgId)) return [];
      return servers.inSpace(space.id).map(toolsetOf);
    },
  };
}

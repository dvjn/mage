// MCP servers as toolsets: an org's owners add servers every space of the org uses, and a space's
// managers add servers that space alone uses, unless the org turned that off. Whoever manages a
// server turns it on or off: one that is off keeps everything but offers no tools anywhere. A
// space's managers also turn one of the org's off for their space alone, though never on while the
// org has it off. Each server is reached with no authorization, with headers, or with OAuth that
// someone who manages it completes once in the browser for everyone; its secrets stay sealed and
// never leave the server. An address with no path that does not answer as an MCP server is tried
// again at /mcp. Everything about a server can be changed later: a secret left out keeps the
// stored one, and a new address or way of authorizing drops the secrets and tokens that went with
// the old one. The tools a server lists are kept and offered from there until it is read again, and
// each call goes to the server with the secrets of whoever the call runs as: today always the ones
// the server shares. Each server has a short name for the agent, made from its name unless given,
// unique among the servers any one space has; its tools reach the model as mcp.<slug>.<tool>, while
// their ids stay with the server's id, so renaming it keeps their policies and history. Servers
// kept from before short names get one when the service starts.

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
  type McpOAuthState,
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
  type McpAuthInput,
  type McpAuthSummary,
  type McpHeadersInput,
  type McpServerChange,
  type McpServerSummary,
  mcpToolId,
  mcpSlugOf,
  mcpToolsetId,
  type NewMcpServer,
  type SpaceOrgMcpServer,
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
const ORG_OFF = "The organization turned this server off";
const NOT_MCP = "This address didn't answer as an MCP server. MCP servers usually live at /mcp.";

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

// The slug, or it with the first number from 2 that no server in `taken` has.
export function uniqueSlug(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
}

export function createMcpServers(options: McpServersOptions) {
  const { servers, credentials, client, spaces, settings, logger } = options;
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, Pending>();

  // The slugs a server of the org, or of one of its spaces, may not take: those of every server
  // some space has beside it. The org's are in every space, so they clash with any space's.
  function takenSlugs(orgId: string, spaceId: string | null, except?: string) {
    const all = servers.everyInOrg(orgId);
    return new Set(
      all
        .filter((server) => server.id !== except && server.slug)
        .filter((server) => !spaceId || server.spaceId === null || server.spaceId === spaceId)
        .map((server) => server.slug),
    );
  }

  function slugFor(
    orgId: string,
    spaceId: string | null,
    wanted: string | undefined,
    name: string,
    except?: string,
  ) {
    const taken = takenSlugs(orgId, spaceId, except);
    if (wanted) {
      if (taken.has(wanted)) throw new ServiceError(409, `Another server here is called ${wanted}`);
      return wanted;
    }
    return uniqueSlug(mcpSlugOf(name), taken);
  }

  // Servers kept from before slugs get one made from their names, oldest first.
  for (const server of servers.withoutSlug()) {
    servers.update(server.id, {
      slug: slugFor(server.orgId, server.spaceId, undefined, server.name),
    });
  }

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
      protocolVersion: server.protocolVersion,
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
        const secret = oauth?.manual ? oauth.client?.client_secret : undefined;
        return {
          kind: "oauth",
          clientId: own.clientId ?? null,
          clientSecretHint: typeof secret === "string" ? secretHint(secret) : null,
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
      slug: server.slug,
      url: server.url,
      spaceId: server.spaceId,
      enabled: server.enabled,
      auth: authSummary(server),
      transport: server.transport,
      protocolVersion: server.protocolVersion,
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

  // The org's servers the space uses: those on, and not turned off in the space.
  function orgServersIn(space: Pick<Space, "id" | "orgId">) {
    const set = servers.inSpaceSettings(space.id);
    return servers
      .inOrg(space.orgId)
      .filter((server) => server.enabled && set.get(server.id) !== false);
  }

  // The space's own servers the space uses: those on, while the org lets spaces have them.
  function ownServersIn(space: Pick<Space, "id" | "orgId">) {
    if (!spacesMayAdd(space.orgId)) return [];
    return servers.inSpace(space.id).filter((server) => server.enabled);
  }

  // One of the org's servers as the space sees it.
  function inSpaceSummary(server: McpServer, set: Map<string, boolean>): SpaceOrgMcpServer {
    return { ...summary(server), inSpace: set.get(server.id) !== false };
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
        protocolVersion: listing.protocolVersion,
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
      modelName: `mcp.${server.slug}.${definition.name}`,
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

  // The headers sent with a server's requests, for asking whether its address answers.
  function headersOf(secrets: McpSecrets | null) {
    return secrets?.headers ?? {};
  }

  // Where the server is: the address given, or, when one with no path does not answer as an MCP
  // server, the same at /mcp where that one does. One that cannot be reached is kept as given.
  async function located(url: string, headers: Record<string, string>) {
    const given = new URL(url);
    if (given.pathname !== "/" || given.search) return url;
    const root = await client.probe(url, headers);
    if (root === "mcp" || root === "unreachable") return url;
    const conventional = new URL("/mcp", given).href;
    const there = await client.probe(conventional, headers);
    if (there === "mcp" || (there === "auth" && root === "other")) return conventional;
    if (root === "auth") return url;
    throw new ServiceError(400, NOT_MCP);
  }

  // The secrets and settings a server is kept with once its authorization is set as given: header
  // values and an OAuth client secret left out keep the stored ones of the same kind, and OAuth
  // keeps its tokens while the client stays the same.
  function secretsOf(
    auth: McpAuthInput,
    before?: { server: McpServer; secrets: McpSecrets | null },
  ): { secrets: McpSecrets | null; settings: McpSettings } {
    const same = before?.server.authKind === auth.kind ? before : undefined;
    switch (auth.kind) {
      case "none":
        return { secrets: null, settings: {} };
      case "headers": {
        const headers = mergeHeaders(auth.headers, same?.secrets?.headers);
        return { secrets: { headers }, settings: { headers: headerHints(headers) } };
      }
      case "oauth": {
        const stored = same?.secrets?.oauth;
        const enteredBefore = stored?.manual ? (stored.client?.client_id as string) : null;
        if (same && stored && (auth.clientId || null) === enteredBefore) {
          const secret = auth.clientSecret ?? stored.client?.client_secret;
          const oauth: McpOAuthState = auth.clientId
            ? {
                ...stored,
                client: {
                  ...stored.client,
                  client_id: auth.clientId,
                  ...(typeof secret === "string" && secret && { client_secret: secret }),
                },
              }
            : stored;
          return { secrets: { oauth }, settings: same.server.settings };
        }
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

  // OAuth state for a server at a new address: the tokens, what discovery found and a client the
  // authorization server registered were for the old one; a client people entered stays.
  function moved(
    secrets: McpSecrets | null,
    settings: McpSettings,
  ): { secrets: McpSecrets | null; settings: McpSettings } {
    const oauth = secrets?.oauth;
    if (!oauth) return { secrets, settings };
    const kept: McpOAuthState = oauth.manual ? { client: oauth.client, manual: true } : {};
    return {
      secrets: { ...secrets, oauth: kept },
      settings: oauth.manual
        ? { clientId: settings.clientId ?? null, registration: "manual" }
        : { registration: null },
    };
  }

  async function add(principal: Principal, spaceId: string | null, input: NewMcpServer) {
    if (spaceId) {
      spaces.require(principal, spaceId, "manage");
      if (!spacesMayAdd(principal.orgId)) throw new ServiceError(403, SPACES_OFF);
    } else if (principal.role !== "owner") {
      throw new ServiceError(403, ORG_ONLY);
    }
    const { secrets, settings: own } = secretsOf(input.auth);
    const url = await located(input.url, headersOf(secrets));
    const server = servers.create({
      orgId: principal.orgId,
      spaceId,
      name: input.name,
      slug: slugFor(principal.orgId, spaceId, input.slug, input.name),
      url,
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

  // Changes the server as given, then reads it again; one authorized by OAuth without tokens for
  // its address needs someone to connect it first.
  async function change(principal: Principal, id: string, input: McpServerChange) {
    const server = manageable(principal, id);
    const stored = credentials.get(id, SHARED);
    const authKind = input.auth?.kind ?? server.authKind;
    let next = input.auth
      ? secretsOf(input.auth, { server, secrets: stored })
      : { secrets: stored, settings: server.settings };
    const url =
      input.url && input.url !== server.url
        ? await located(input.url, headersOf(next.secrets))
        : server.url;
    // Anything the server answered on before was for the old address.
    const elsewhere = url !== server.url;
    if (elsewhere) next = moved(next.secrets, next.settings);
    const slug =
      input.slug && input.slug !== server.slug
        ? slugFor(server.orgId, server.spaceId, input.slug, server.name, server.id)
        : undefined;
    servers.update(id, {
      ...(input.name && { name: input.name }),
      ...(slug && { slug }),
      url,
      authKind,
      settings: next.settings,
      ...(elsewhere && { transport: null, protocolVersion: null }),
    });
    if (next.secrets) credentials.put(id, SHARED, next.secrets);
    else credentials.delete(id, SHARED);
    if (!input.auth && !elsewhere) return summary(servers.find(id)!);
    if (authKind === "oauth" && !next.secrets?.oauth?.tokens) {
      servers.update(id, { status: "needs_auth", error: null });
      return summary(servers.find(id)!);
    }
    return summary(await refreshed(servers.find(id)!));
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

    // The servers a space has, for those who manage it: the org's, each with whether the space
    // uses it, and its own.
    spaceServers(principal: Principal, spaceId: string) {
      const space = spaces.require(principal, spaceId, "manage");
      const set = servers.inSpaceSettings(space.id);
      return {
        org: servers.inOrg(space.orgId).map((server) => inSpaceSummary(server, set)),
        own: servers.inSpace(space.id).map(summary),
        allowed: spacesMayAdd(space.orgId),
      };
    },

    // Turns one of the org's servers on or off for the space alone; never on while the org has it
    // off.
    setInSpace(principal: Principal, spaceId: string, serverId: string, enabled: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      const server = servers.find(serverId);
      if (!server || server.orgId !== space.orgId || server.spaceId) {
        throw new ServiceError(404, "MCP server not found");
      }
      if (enabled && !server.enabled) throw new ServiceError(409, ORG_OFF);
      servers.setInSpace(space.id, server.id, enabled);
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

    // Changes its name, address or authorization, and reads it again.
    change,

    // Turns the server on or off for everyone who has it, keeping everything else about it.
    setEnabled(principal: Principal, id: string, enabled: boolean) {
      manageable(principal, id);
      servers.update(id, { enabled });
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

    // Settings keep every server's tools visible, including those currently off.
    toolsetsForOrgSettings(orgId: string): Toolset[] {
      return servers.inOrg(orgId).map(toolsetOf);
    },

    toolsetsForSpaceSettings(space: Pick<Space, "id" | "orgId">): Toolset[] {
      return [...servers.inOrg(space.orgId), ...servers.inSpace(space.id)].map(toolsetOf);
    },

    // The servers the space uses, as toolsets: the org's it did not turn off, then its own, while
    // the org lets spaces have them; none that is off.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">): Toolset[] {
      return [...orgServersIn(space), ...ownServersIn(space)].map(toolsetOf);
    },
  };
}

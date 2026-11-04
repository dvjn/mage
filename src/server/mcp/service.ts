// MCP servers as toolsets: an org's owners add servers every space of the org uses, and a space's
// managers add servers that space alone uses, unless the org turned that off. Whoever manages a
// server turns it on or off: one that is off keeps everything but offers no tools anywhere. A
// space's managers also turn one of the org's off for their space alone, though never on while the
// org has it off. Each server is reached with no authorization, with headers, or with OAuth that
// someone who manages it completes once in the browser for everyone; its secrets stay sealed and
// never leave the server. An address with no path that does not answer as an MCP server is tried
// again at /mcp. Everything about a server can be changed later: a secret left out keeps the
// stored one, and a new address or way of authorizing drops the secrets and tokens that went with
// the old one. The tools a server lists are kept and offered from there until it is read again.
// Each call goes to the server with the secrets it shares with everyone who uses it, unless those
// who manage it made its credentials personal: then the shared secrets only check it and read its
// tools, and each call goes with the secrets of the person it runs as, who connects their own once
// (signing in, or giving their own header values). A call never falls back to anyone else's: one
// whose person has none, or whose secrets the server refuses, fails, and refused secrets are marked
// to be connected again. Leaving an org forgets one's own secrets for its servers. Each server has
// a short name for the agent, made from its name unless given, unique among the servers any one
// space has; its tools reach the model as mcp.<slug>.<tool>, while their ids stay with the server's
// id, so renaming it keeps their policies and history. Servers kept from before short names get one
// when the service starts. The resources of servers that declare them are listed and read through
// Mage's own Resource toolset, each call going with the credentials of the server it names. The
// prompts a server offers are kept with its tools, and people run them as commands, each going
// with the credentials the server's calls go with: for personal ones, the sender's own.

import { randomBytes } from "node:crypto";

import * as z from "zod";

import type { McpServerGuidance } from "@/server/agent/context.ts";
import type {
  AnyToolSpec,
  ToolContext,
  ToolOutput,
  ToolNames,
  Toolset,
  ToolSpec,
} from "@/server/agent/tools.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { OrgSettingStore } from "@/server/orgs/service.ts";
import type { Space, Spaces } from "@/server/spaces/service.ts";
import {
  contentText,
  type McpContentPart,
  type McpAuthInput,
  type McpAuthSummary,
  type McpConnectHeaders,
  type McpConnection,
  type McpCredentialMode,
  type McpHeadersInput,
  type McpRegistration,
  type McpServerChange,
  type McpServerSummary,
  MCP_INSTRUCTIONS_MAX,
  MCP_OWN_TOOLSET,
  mcpToolId,
  mcpToolOf,
  mcpSlugOf,
  mcpToolsetId,
  type NewMcpServer as McpServerInput,
  type SpaceOrgMcpServer,
  type McpAuthKind,
  type McpStatus,
  type McpTransport,
} from "@/shared/mcp.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";
import type { ToolConnection, ToolDefinition } from "@/shared/tools.ts";

import {
  type McpOAuthStore,
  type McpTarget,
  type McpCallResult,
  McpError,
  type McpClient,
  type McpPrompt,
  type McpResource,
} from "./client.ts";
import { promptArguments, promptText } from "./prompts.ts";
import { contentsOf, listed, RESOURCE_LIST_MAX } from "./resources.ts";

// Whether each tool is on in a space: not turned off by the org or the space.
export type ToolsOn = (space: Pick<Space, "id" | "orgId">) => (toolId: string) => boolean;

export interface McpServer {
  id: string;
  orgId: string;
  // The space it was added for; null for the whole org.
  spaceId: string | null;
  name: string;
  // What the agent calls it: its tools are named mcp.<slug>.<tool> for the model.
  slug: string;
  url: string;
  // Whether it offers its tools; one turned off keeps everything else.
  enabled: boolean;
  authKind: McpAuthKind;
  // Whose secrets its tools are called with: the shared ones, or each person's own.
  credentials: McpCredentialMode;
  // What is not secret about its authorization.
  settings: McpSettings;
  transport: McpTransport | null;
  // The protocol revision it last answered with; null until it has.
  protocolVersion: string | null;
  status: McpStatus;
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  // What it said about using its tools when last read, as the server wrote it and kept to a cap,
  // and whether it was cut to fit; null when it said nothing.
  instructions: string | null;
  instructionsCut: boolean;
  // Whether it declared resources when last read.
  resources: boolean;
  // The tools it last listed, as MCP defines them.
  tools: ToolDefinition[];
  // The prompts it last offered.
  prompts: McpPrompt[];
  toolsReadAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface McpSettings {
  // Header names, each with the end of its value.
  headers?: { name: string; hint: string }[];
  // The OAuth client: entered by people, Mage's metadata document, or registered by the
  // authorization server; its issuer.
  clientId?: string | null;
  registration?: McpRegistration | null;
  issuer?: string | null;
}

export type NewMcpServer = Pick<
  McpServer,
  "orgId" | "spaceId" | "name" | "slug" | "url" | "authKind" | "credentials" | "settings"
> & { createdBy: string };

export type McpServerChanges = Partial<
  Pick<
    McpServer,
    | "name"
    | "slug"
    | "url"
    | "enabled"
    | "authKind"
    | "credentials"
    | "settings"
    | "transport"
    | "protocolVersion"
    | "status"
    | "error"
    | "serverInfo"
    | "instructions"
    | "instructionsCut"
    | "resources"
    | "tools"
    | "prompts"
    | "toolsReadAt"
  >
>;

export interface McpServerStore {
  create(server: NewMcpServer): McpServer;
  find(id: string): McpServer | null;
  // The org's own servers, for all its spaces.
  inOrg(orgId: string): McpServer[];
  // The servers added for a space.
  inSpace(spaceId: string): McpServer[];
  // Every server of the org, its own and its spaces'.
  everyInOrg(orgId: string): McpServer[];
  // The ids, orgs and spaces and names of servers given no slug yet, oldest first.
  withoutSlug(): Pick<McpServer, "id" | "orgId" | "spaceId" | "name">[];
  update(id: string, changes: McpServerChanges): void;
  delete(id: string): void;
  // Whether the space uses each of the org's servers, for those it set.
  inSpaceSettings(spaceId: string): Map<string, boolean>;
  setInSpace(spaceId: string, serverId: string, enabled: boolean): void;
}

// Whose secrets a call goes with: the ones the server shares with everyone who uses it, or one
// person's own.
export type McpHolder = { kind: "shared" } | { kind: "user"; userId: string };

// Whether secrets worked when last used, or the server refused them.
export type McpCredentialStatus = "ok" | "needs_auth";

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
  // Whether the client is the address of Mage's client metadata document.
  document?: boolean;
  tokens?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
}

export interface McpCredentialStore {
  get(serverId: string, holder: McpHolder): McpSecrets | null;
  // Saving secrets counts them as working again.
  put(serverId: string, holder: McpHolder, secrets: McpSecrets): void;
  delete(serverId: string, holder: McpHolder): void;
  // Forgets every person's own secrets for the server.
  deletePeople(serverId: string): void;
  // Whether the secrets worked when last used; null when there are none.
  status(serverId: string, holder: McpHolder): McpCredentialStatus | null;
  setStatus(serverId: string, holder: McpHolder, status: McpCredentialStatus): void;
  // The servers the person keeps their own secrets for, and since when.
  ofUser(userId: string): { serverId: string; status: McpCredentialStatus; updatedAt: Date }[];
}

export interface McpServersOptions {
  servers: McpServerStore;
  credentials: McpCredentialStore;
  client: McpClient;
  spaces: Pick<Spaces, "require">;
  settings: Pick<OrgSettingStore, "get" | "setSpaceMcpServers">;
  logger: Logger;
  // Where the service hears that people left an org, to forget their own secrets there.
  hooks?: Hooks;
  now?: () => Date;
}

export type McpServers = ReturnType<typeof createMcpServers>;

// How long an authorization begun in the browser may take.
const AUTHORIZE_TTL_MS = 10 * 60 * 1000;

const SHARED: McpHolder = { kind: "shared" };

const ORG_ONLY = "Only the organization's owners can manage its MCP servers";
const SPACES_OFF = "The organization does not let spaces add MCP servers";
const ORG_OFF = "The organization turned this server off";
const NOT_MCP = "This address didn't answer as an MCP server. MCP servers usually live at /mcp.";
const NOTHING_PERSONAL = "Personal credentials need headers or OAuth";
const NOT_PERSONAL = "This server's credentials are not personal";

// A begun authorization, by the state the authorization server sends back, and for one person's
// own secrets the page of Mage to go back to.
interface Pending {
  serverId: string;
  holder: McpHolder;
  userId: string;
  verifier: { value?: string };
  expiresAt: number;
  returnTo?: string;
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

// A tool's result as the thread keeps it: its structured content, else its text, or its content
// parts where they hold more than text, such as images and links; or why it failed.
export function outputOf(result: McpCallResult): ToolOutput {
  const parts = result.content.filter(
    (part): part is McpContentPart => typeof part.type === "string",
  );
  const text = contentText(parts);
  if (result.isError) return { ok: false, error: text || "The tool failed." };
  if (result.structuredContent) return { ok: true, value: result.structuredContent };
  const plain = parts.every((part) => part.type === "text");
  return { ok: true, value: plain ? text : { content: parts } };
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

// The names of the headers a server is sent, in one string to compare.
function headerNames(settings: McpSettings) {
  return (settings.headers ?? [])
    .map((header) => header.name)
    .sort()
    .join("\n");
}

function headerHints(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => ({ name, hint: secretHint(value) }));
}

// A server's instructions as kept: trimmed, and cut to the cap where longer; none when empty.
export function keptInstructions(raw: string | null) {
  const text = raw?.trim() ?? "";
  if (!text) return { instructions: null, instructionsCut: false };
  if (text.length <= MCP_INSTRUCTIONS_MAX) return { instructions: text, instructionsCut: false };
  return { instructions: text.slice(0, MCP_INSTRUCTIONS_MAX).trimEnd(), instructionsCut: true };
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
  const { servers, credentials, client, spaces, settings, logger, hooks } = options;
  const now = options.now ?? (() => new Date());

  // Someone who leaves an org loses their own secrets for its servers and its spaces' servers;
  // coming back means connecting again.
  hooks?.on("org.membersSettled", ({ orgId, left }) => {
    if (!left.length) return;
    for (const server of servers.everyInOrg(orgId)) {
      for (const userId of left) credentials.delete(server.id, own(userId));
    }
  });
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

  function own(userId: string): McpHolder {
    return { kind: "user", userId };
  }

  // Whether the person has their own secrets for the server that worked when last used: tokens
  // from signing in, or header values.
  function connectedAs(server: McpServer, userId: string) {
    if (credentials.status(server.id, own(userId)) !== "ok") return false;
    const secrets = credentials.get(server.id, own(userId));
    return server.authKind === "oauth"
      ? !!secrets?.oauth?.tokens
      : Object.keys(secrets?.headers ?? {}).length > 0;
  }

  // The person's own connection to a server whose credentials are personal, as they see it.
  function connectionOf(server: McpServer, userId: string): ToolConnection {
    return {
      serverId: server.id,
      title: server.name,
      kind: server.authKind === "oauth" ? "oauth" : "headers",
      headers: (server.settings.headers ?? []).map((header) => header.name),
      connected: connectedAs(server, userId),
    };
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
      credentials: server.credentials,
      transport: server.transport,
      protocolVersion: server.protocolVersion,
      status: server.status,
      error: server.error,
      serverInfo: server.serverInfo,
      instructions: server.instructions,
      instructionsCut: server.instructionsCut,
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
        ...keptInstructions(listing.instructions),
        resources: listing.resources,
        tools: listing.tools,
        prompts: listing.prompts,
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
    const registration = !clientId
      ? null
      : oauth?.manual
        ? "manual"
        : oauth?.document
          ? "document"
          : "dynamic";
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
      prefix: `mcp.${server.slug}`,
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
      ...(server.credentials === "personal" && {
        connection: () => (userId: string) => connectionOf(server, userId),
      }),
      run: (input, ctx) => call(server.id, definition.name, input as Record<string, unknown>, ctx),
    };
  }

  // Calls the tool on the server.
  async function call(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    ctx: Pick<ToolContext, "runAs">,
  ): Promise<ToolOutput> {
    const server = servers.find(serverId);
    if (!server) return { ok: false, error: "This MCP server was removed." };
    return reach(server, ctx, async (target) => outputOf(await client.call(target, name, args)));
  }

  // Does the work on the server with its shared secrets, or for personal credentials with those of
  // the person the call runs as, saying whose they were. A server that cannot be reached says why,
  // and is marked so for those who manage it; a person's own secrets it refuses are marked to be
  // connected again.
  async function reach(
    server: McpServer,
    ctx: Pick<ToolContext, "runAs">,
    work: (target: McpTarget) => Promise<ToolOutput>,
  ): Promise<ToolOutput> {
    if (server.credentials === "personal") {
      const userId = ctx.runAs;
      if (!userId || !connectedAs(server, userId)) {
        return {
          ok: false,
          error: `${server.name}: the person this call runs as has no working connection to it.`,
          ...(userId && { ranAs: userId }),
        };
      }
      return reachAs(server, userId, work);
    }
    try {
      const output = await work(targetOf(server, SHARED));
      if (server.status !== "ok") servers.update(server.id, { status: "ok", error: null });
      return output;
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      servers.update(server.id, { status: err.kind, error: err.message });
      const after =
        err.kind === "needs_auth"
          ? " Someone who manages it needs to reconnect it in settings."
          : "";
      return { ok: false, error: `${server.name}: ${err.message}${after}` };
    }
  }

  async function reachAs(
    server: McpServer,
    userId: string,
    work: (target: McpTarget) => Promise<ToolOutput>,
  ): Promise<ToolOutput> {
    try {
      return { ...(await work(targetOf(server, own(userId)))), ranAs: userId };
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      if (!err.refused)
        return { ok: false, error: `${server.name}: ${err.message}`, ranAs: userId };
      credentials.setStatus(server.id, own(userId), "needs_auth");
      return {
        ok: false,
        error: `${server.name}: the server refused the connection this call ran with. It needs connecting again.`,
        ranAs: userId,
      };
    }
  }

  // The servers the space uses whose resources the agent may list and read: those that declared
  // resources and have a tool on there.
  function resourceServersIn(space: Pick<Space, "id" | "orgId">, toolsOn: ToolsOn) {
    const on = toolsOn(space);
    return [...orgServersIn(space), ...ownServersIn(space)].filter(
      (server) =>
        server.resources && server.tools.some((tool) => on(mcpToolId(server.id, tool.name))),
    );
  }

  // Mage's own tools for listing and reading the resources of the space's servers, of use where
  // one has resources. A call that names a server goes with that server's credentials, as its
  // tools' calls do: the shared ones, or the own login of the person it runs as; one that names
  // none lists only the servers whose credentials are shared, since one call has one login.
  function resourceTools(toolsOn: ToolsOn): AnyToolSpec[] {
    const usefulIn = (space: Pick<Space, "id" | "orgId">) =>
      resourceServersIn(space, toolsOn).length > 0;
    const named = (space: Pick<Space, "id" | "orgId">, slug: string) =>
      resourceServersIn(space, toolsOn).find((server) => server.slug === slug);
    const missing = (space: Pick<Space, "id" | "orgId">, slug: string): ToolOutput => {
      const slugs = resourceServersIn(space, toolsOn).map((server) => server.slug);
      return {
        ok: false,
        error: slugs.length
          ? `No server here named ${slug} has resources. Those that do: ${slugs.join(", ")}.`
          : `No server here named ${slug} has resources. None here do.`,
      };
    };
    const personalConnection = (space: Pick<Space, "id" | "orgId">, slug: string | undefined) => {
      const server = slug ? named(space, slug) : undefined;
      return server?.credentials === "personal"
        ? (userId: string) => connectionOf(server, userId)
        : null;
    };
    const serverInput = z
      .string()
      .trim()
      .min(1)
      .meta({ title: "Server", description: "Its short name, as in mcp.<server>.*" });

    const list: ToolSpec<{ server?: string }> = {
      name: `${MCP_OWN_TOOLSET}.list_resources`,
      title: "List resources",
      annotations: { readOnlyHint: true },
      description:
        "List the resources MCP servers here offer: each one's server, uri, name, description and type. Name a server to list only its own.",
      input: z.object({ server: serverInput.optional() }),
      risk: () => "normal",
      usefulIn,
      connection: ({ server }, space) => personalConnection(space, server),
      async run({ server: slug }, ctx) {
        const space = { id: ctx.spaceId, orgId: ctx.orgId };
        if (slug) {
          const server = named(space, slug);
          if (!server) return missing(space, slug);
          return reach(server, ctx, async (target) => {
            const resources = await client.listResources(target);
            return {
              ok: true,
              value: {
                resources: resources
                  .slice(0, RESOURCE_LIST_MAX)
                  .map((resource) => listed(server.slug, resource)),
                ...(resources.length > RESOURCE_LIST_MAX && { more: true }),
              },
            };
          });
        }
        const found: ReturnType<typeof listed>[] = [];
        const errors: string[] = [];
        const personal: string[] = [];
        for (const server of resourceServersIn(space, toolsOn)) {
          if (server.credentials === "personal") {
            personal.push(server.slug);
            continue;
          }
          const output = await reach(server, ctx, async (target) => ({
            ok: true,
            value: await client.listResources(target),
          }));
          if (!output.ok) errors.push(output.error);
          else {
            for (const resource of output.value as McpResource[]) {
              found.push(listed(server.slug, resource));
            }
          }
        }
        return {
          ok: true,
          value: {
            resources: found.slice(0, RESOURCE_LIST_MAX),
            ...(found.length > RESOURCE_LIST_MAX && { more: true }),
            ...(errors.length > 0 && { errors }),
            ...(personal.length > 0 && {
              personal: `These servers use each person's own login; name one to list its resources: ${personal.join(", ")}.`,
            }),
          },
        };
      },
    };

    const read: ToolSpec<{ server: string; uri: string }> = {
      name: `${MCP_OWN_TOOLSET}.read_resource`,
      title: "Read resource",
      annotations: { readOnlyHint: true },
      description:
        "Read a resource from an MCP server here, by the server and the resource's uri. Text comes back as text; binary content only as its type and size.",
      input: z.object({
        server: serverInput,
        uri: z.string().trim().min(1).meta({ title: "Resource", description: "Its uri" }),
      }),
      risk: () => "normal",
      usefulIn,
      connection: ({ server }, space) => personalConnection(space, server),
      async run({ server: slug, uri }, ctx) {
        const space = { id: ctx.spaceId, orgId: ctx.orgId };
        const server = named(space, slug);
        if (!server) return missing(space, slug);
        return reach(server, ctx, async (target) => ({
          ok: true,
          value: {
            server: server.slug,
            uri,
            ...contentsOf(await client.readResource(target, uri)),
          },
        }));
      },
    };

    return [list, read];
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

  async function add(principal: Principal, spaceId: string | null, input: McpServerInput) {
    if (spaceId) {
      spaces.require(principal, spaceId, "manage");
      if (!spacesMayAdd(principal.orgId)) throw new ServiceError(403, SPACES_OFF);
    } else if (principal.role !== "owner") {
      throw new ServiceError(403, ORG_ONLY);
    }
    const mode = input.credentials ?? "shared";
    if (mode === "personal" && input.auth.kind === "none") {
      throw new ServiceError(400, NOTHING_PERSONAL);
    }
    const { secrets, settings: kept } = secretsOf(input.auth);
    const url = await located(input.url, headersOf(secrets));
    const server = servers.create({
      orgId: principal.orgId,
      spaceId,
      name: input.name,
      slug: slugFor(principal.orgId, spaceId, input.slug, input.name),
      url,
      authKind: input.auth.kind,
      credentials: mode,
      settings: kept,
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
  // its address needs someone to connect it first. People's own secrets go once they no longer
  // fit: for another way of authorizing or another address, or once credentials are shared.
  async function change(principal: Principal, id: string, input: McpServerChange) {
    const server = manageable(principal, id);
    const stored = credentials.get(id, SHARED);
    const authKind = input.auth?.kind ?? server.authKind;
    const mode = input.credentials ?? server.credentials;
    if (mode === "personal" && authKind === "none") throw new ServiceError(400, NOTHING_PERSONAL);
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
      credentials: mode,
      settings: next.settings,
      ...(elsewhere && { transport: null, protocolVersion: null }),
    });
    if (next.secrets) credentials.put(id, SHARED, next.secrets);
    else credentials.delete(id, SHARED);
    if (
      mode === "shared" ||
      elsewhere ||
      authKind !== server.authKind ||
      headerNames(next.settings) !== headerNames(server.settings)
    ) {
      credentials.deletePeople(id);
    }
    if (!input.auth && !elsewhere) return summary(servers.find(id)!);
    if (authKind === "oauth" && !next.secrets?.oauth?.tokens) {
      servers.update(id, { status: "needs_auth", error: null });
      return summary(servers.find(id)!);
    }
    return summary(await refreshed(servers.find(id)!));
  }

  // A server whose credentials are personal, for someone who may use it to connect their own: one
  // of the org's for its members, a space's for those who can see the space.
  function connectable(principal: Principal, id: string) {
    const server = servers.find(id);
    if (!server || server.orgId !== principal.orgId) {
      throw new ServiceError(404, "MCP server not found");
    }
    if (server.spaceId) spaces.require(principal, server.spaceId);
    if (server.credentials !== "personal") throw new ServiceError(409, NOT_PERSONAL);
    return server;
  }

  // Whether the person can see the server: one of the org's, or one of a space they can see.
  function seen(principal: Principal, server: McpServer) {
    if (!server.spaceId) return true;
    try {
      spaces.require(principal, server.spaceId);
      return true;
    } catch (err) {
      if (err instanceof ServiceError) return false;
      throw err;
    }
  }

  // Starts the person signing in with the server's authorization server as themselves, with the
  // client and what discovery found for its shared secrets when they have none yet of their own.
  async function authorizeOwn(principal: Principal, server: McpServer, returnTo?: string) {
    const holder = own(principal.userId);
    if (!credentials.get(server.id, holder)) {
      const shared = credentials.get(server.id, SHARED)?.oauth;
      credentials.put(server.id, holder, {
        oauth: {
          ...(shared?.client && { client: shared.client }),
          ...(shared?.manual && { manual: true }),
          ...(shared?.document && { document: true }),
          ...(shared?.discovery && { discovery: shared.discovery }),
        },
      });
    }
    const state = randomBytes(24).toString("base64url");
    const attempt: Pending = {
      serverId: server.id,
      holder,
      userId: principal.userId,
      verifier: {},
      expiresAt: now().getTime() + AUTHORIZE_TTL_MS,
      ...(returnTo && { returnTo }),
    };
    let url: string | null;
    try {
      url = await client.authorize(
        server.url,
        oauthStore(server.id, holder),
        state,
        attempt.verifier,
      );
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      throw new ServiceError(502, err.message);
    }
    if (url) {
      pending.set(state, attempt);
      return { status: "redirect" as const, url };
    }
    credentials.setStatus(server.id, holder, "ok");
    return { status: "connected" as const };
  }

  function forgetExpired() {
    for (const [key, attempt] of pending) {
      if (attempt.expiresAt <= now().getTime()) pending.delete(key);
    }
  }

  // The servers the space uses that offer prompts, by their short names.
  function promptServersIn(space: Pick<Space, "id" | "orgId">) {
    return [...orgServersIn(space), ...ownServersIn(space)].filter(
      (server) => server.prompts.length > 0,
    );
  }

  return {
    summary,
    resourceTools,

    // The prompts the servers the space uses offer, each with its server, and for a server whose
    // credentials are personal the person's own connection to it.
    promptsIn(space: Pick<Space, "id" | "orgId">, userId: string) {
      return promptServersIn(space).flatMap((server) =>
        server.prompts.map((prompt) => ({
          server: server.slug,
          serverName: server.name,
          prompt,
          ...(server.credentials === "personal" && {
            connection: connectionOf(server, userId),
          }),
        })),
      );
    },

    // Gets one of those prompts for the person with the words they gave after it, as the text the
    // agent reads; null when the space has no such prompt. Refuses arguments it requires and was
    // not given, and a server whose credentials are personal that the person has not connected to.
    async runPrompt(
      space: Pick<Space, "id" | "orgId">,
      userId: string,
      slug: string,
      name: string,
      args: string,
    ) {
      const server = promptServersIn(space).find((candidate) => candidate.slug === slug);
      const prompt = server?.prompts.find((candidate) => candidate.name === name);
      if (!server || !prompt) return null;
      const { values, missing } = promptArguments(prompt, args);
      if (missing.length > 0) {
        throw new ServiceError(400, `/${slug}:${name} needs ${missing.join(", ")}`);
      }
      if (server.credentials === "personal" && !connectedAs(server, userId)) {
        throw new ServiceError(409, `Connect to ${server.name} first`);
      }
      const output = await reach(server, { runAs: userId }, async (target) => ({
        ok: true,
        value: promptText(await client.getPrompt(target, prompt.name, values)),
      }));
      if (!output.ok) throw new ServiceError(502, output.error);
      return { server: server.name, text: output.value as string };
    },

    clientDocument() {
      return client.clientDocument();
    },

    // The servers with personal credentials the person may connect to, the org's and those of the
    // spaces they can see, each with their own connection to it, if any.
    connections(principal: Principal): McpConnection[] {
      const mine = new Map(credentials.ofUser(principal.userId).map((row) => [row.serverId, row]));
      return servers
        .everyInOrg(principal.orgId)
        .filter((server) => server.credentials === "personal" && seen(principal, server))
        .map((server) => {
          const row = mine.get(server.id);
          const { kind, headers, connected } = connectionOf(server, principal.userId);
          return {
            serverId: server.id,
            serverName: server.name,
            spaceId: server.spaceId,
            kind,
            headers,
            // A sign-in begun but never finished needs connecting too.
            status: row ? (connected ? ("ok" as const) : ("needs_auth" as const)) : null,
            connectedAt: row?.updatedAt.toISOString() ?? null,
          };
        });
    },

    // Keeps the person's own header values for the server, once it takes them: one for each
    // header its shared secrets are sent with.
    async connectHeaders(principal: Principal, id: string, input: McpConnectHeaders) {
      const server = connectable(principal, id);
      if (server.authKind !== "headers") {
        throw new ServiceError(400, "This server is not authorized by headers");
      }
      const headers = Object.fromEntries(
        input.headers.map((header) => [header.name.toLowerCase(), header.value]),
      );
      if (
        headerNames({ headers: Object.keys(headers).map((name) => ({ name, hint: "" })) }) !==
        headerNames(server.settings)
      ) {
        throw new ServiceError(400, "Give a value for each of the server's headers");
      }
      try {
        await client.list({ ...targetOf(server, SHARED), auth: { kind: "headers", headers } });
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        throw new ServiceError(400, err.message);
      }
      credentials.put(server.id, own(principal.userId), { headers });
    },

    // Starts the person signing in with the server as themselves: where to send the browser, or
    // that the tokens they hold still work. The browser comes back to `returnTo`.
    async connectOAuth(principal: Principal, id: string, returnTo?: string) {
      const server = connectable(principal, id);
      if (server.authKind !== "oauth") {
        throw new ServiceError(400, "This server is not authorized by OAuth");
      }
      forgetExpired();
      return authorizeOwn(principal, server, returnTo);
    },

    // Forgets the person's own secrets for the server.
    disconnect(principal: Principal, id: string) {
      const server = servers.find(id);
      if (!server || server.orgId !== principal.orgId) {
        throw new ServiceError(404, "MCP server not found");
      }
      credentials.delete(server.id, own(principal.userId));
    },

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

    addToOrg(principal: Principal, input: McpServerInput) {
      return add(principal, null, input);
    },

    addToSpace(principal: Principal, spaceId: string, input: McpServerInput) {
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

    // What the model knows one of a server's tools by, for a server that no longer lists it.
    named(toolId: string): ToolNames | null {
      const tool = mcpToolOf(toolId);
      const server = tool && servers.find(tool.serverId);
      if (!tool || !server?.slug) return null;
      return { title: `mcp.${server.slug}.${tool.name}`, toolset: null };
    },

    // Starts authorizing Mage with the server's authorization server, for everyone who uses it:
    // where to send the browser, or the server read again when its tokens were still good.
    async authorize(principal: Principal, id: string) {
      const server = manageable(principal, id);
      if (server.authKind !== "oauth") {
        throw new ServiceError(400, "This server is not authorized by OAuth");
      }
      forgetExpired();
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
    // person who began it: for the shared secrets the server's tools read again, for their own
    // the connection kept; and the page to go back to with what went wrong, if anything.
    async finishAuthorization(
      userId: string | null,
      query: { state?: string; code?: string; iss?: string; error?: string },
    ): Promise<{ server: McpServer | null; error: string | null; returnTo?: string }> {
      const attempt = query.state ? pending.get(query.state) : undefined;
      if (!attempt || attempt.expiresAt <= now().getTime() || attempt.userId !== userId) {
        return { server: null, error: "This authorization expired. Try again." };
      }
      pending.delete(query.state!);
      const server = servers.find(attempt.serverId);
      if (!server) return { server: null, error: "MCP server not found" };
      if (attempt.holder.kind === "user") {
        const back = { server, returnTo: attempt.returnTo ?? "/account" };
        if (query.error || !query.code || !attempt.verifier.value) {
          return { ...back, error: `The authorization server said: ${query.error ?? "no code"}.` };
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
          return { ...back, error: err.message };
        }
        credentials.setStatus(server.id, attempt.holder, "ok");
        return { ...back, error: null };
      }
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

    // Whether the org has servers, or for a space, the org or the space.
    hasServers: ({ orgId, spaceId }: { orgId: string; spaceId: string | null }) =>
      servers.inOrg(orgId).length > 0 || (!!spaceId && servers.inSpace(spaceId).length > 0),

    // What the servers the space uses say about their tools, for the agent's prompt: only those
    // with a tool offered in the run, in the order their toolsets come.
    instructionsIn(
      space: Pick<Space, "id" | "orgId">,
      offered: readonly Pick<AnyToolSpec, "name">[],
    ): McpServerGuidance[] {
      const names = new Set(offered.map((spec) => spec.name));
      return [...orgServersIn(space), ...ownServersIn(space)].flatMap((server) =>
        server.instructions &&
        server.tools.some((tool) => names.has(mcpToolId(server.id, tool.name)))
          ? [
              {
                name: server.name,
                prefix: `mcp.${server.slug}.*`,
                text: server.instructions,
                cut: server.instructionsCut,
              },
            ]
          : [],
      );
    },

    // The servers the space uses, as toolsets: the org's it did not turn off, then its own, while
    // the org lets spaces have them; none that is off.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">): Toolset[] {
      return [...orgServersIn(space), ...ownServersIn(space)].map(toolsetOf);
    },
  };
}

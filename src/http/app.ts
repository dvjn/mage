// API routes under /api and, in production, the built web client.

import { setTimeout as sleep } from "node:timers/promises";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { validator } from "hono/validator";
import type * as z from "zod";

import type { Connection } from "@/ports/connections.ts";
import type { Folder } from "@/ports/folders.ts";
import type { Identity, Principal, SignedIn } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";
import { type AttemptStatus, ConnectionError, type Connections } from "@/services/connections.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Folders } from "@/services/folders.ts";
import type { Groups } from "@/services/groups.ts";
import type { Guests } from "@/services/guests.ts";
import type { McpServers } from "@/services/mcp-servers.ts";
import type { ConnectionModel, Models } from "@/services/models.ts";
import type { Orgs } from "@/services/orgs.ts";
import type { Spaces, SpaceView } from "@/services/spaces.ts";
import type { Threads } from "@/services/threads.ts";
import type { ToolDecisions } from "@/services/tools.ts";
import {
  type AttemptSummary,
  type ConnectionSummary,
  proxyInputSchema,
  type ProxySummary,
} from "@/shared/connections.ts";
import { type FolderSummary, folderNameSchema } from "@/shared/folders.ts";
import {
  connectionChangeSchema,
  connectionInputSchema,
  methodOf,
  splitValues,
} from "@/shared/hosts.ts";
import { acceptInviteSchema, newInviteSchema } from "@/shared/guests.ts";
import {
  mcpEnabledChangeSchema,
  mcpServerChangeSchema,
  type McpServerSummary,
  newMcpServerSchema,
  spaceServersChangeSchema,
} from "@/shared/mcp.ts";
import type { Me } from "@/shared/me.ts";
import type { SignInOptions } from "@/shared/sign-in.ts";
import {
  type ConnectionModels,
  connectionModelsChangeSchema,
  type DefaultEffort,
  defaultEffortSchema,
  type DefaultModel,
  type ModelListSummary,
  setDefaultModelSchema,
  setTitleModelSchema,
  type TitleModel,
} from "@/shared/models.ts";
import {
  acceptOrgInviteSchema,
  ORG_NOT_FOUND,
  memberFilterSchema,
  newGroupLinkSchema,
  newOrgInviteSchema,
  newOrgMemberSchema,
  peopleFilterSchema,
  orgNameSchema,
  setOrgRoleSchema,
  teamSettingsChangeSchema,
} from "@/shared/orgs.ts";
import { pageParams, pageQuerySchema } from "@/shared/paging.ts";
import {
  orgSpaceFilterSchema,
  setEveryoneSchema,
  setSpaceMemberSchema,
  spaceDefaultsSchema,
  spaceMemberFilterSchema,
  type SpaceSummary,
  spaceNameSchema,
} from "@/shared/spaces.ts";
import {
  messageInputSchema,
  newThreadSchema,
  pendingChangeSchema,
  retrySchema,
  threadReadSchema,
  threadSearchSchema,
  threadUpdateSchema,
  toolDecisionSchema,
} from "@/shared/threads.ts";
import { spaceThreadPageQuerySchema, threadPageQuerySchema } from "@/shared/thread-status.ts";
import { toolModeChangeSchema } from "@/shared/tools.ts";

export interface AppOptions {
  // Answers every request under /api/auth.
  handleAuth: (request: Request) => Promise<Response>;
  // Tells who is signed in for each request under /api/v1.
  identity: Identity;
  // The signed-in user's connections, including signing in to make one and their proxies.
  connections: Connections;
  // The models the org's connections unlock, its default model and its title model.
  models: Models;
  // The spaces the signed-in user can see in their org.
  spaces: Spaces;
  // The folders that arrange those spaces' threads.
  folders: Folders;
  // Threads in those spaces and the ones shared with the user, and their events.
  threads: Threads;
  // Invite links to threads and the guests they let in.
  guests: Guests;
  // Decisions on the agent's tool calls, and the tools orgs and spaces turn on and off.
  tools: ToolDecisions;
  // The MCP servers orgs and spaces add, and authorizing Mage with them.
  mcp: McpServers;
  // The orgs people are in, their members and invites, and creating team orgs.
  orgs: Orgs;
  // A team org's groups, as a directory brings them.
  groups: Groups;
  logger: Logger;
  // How often a live event stream sends a comment to keep the connection open, and checks the
  // reader may still read the thread.
  heartbeatMs?: number;
  // Aborted when the server stops, which ends the live event streams.
  shutdown?: AbortSignal;
  // The ways to sign in this server offers, for the sign-in page.
  signInOptions: SignInOptions;
  // Reports whether the database answers a query.
  pingDatabase: () => Promise<boolean>;
  // Directory holding the built web client. Unset in dev, where Vite serves it.
  webRoot?: string;
}

export type App = Hono<{ Variables: RequestIdVariables }>;

type ApiEnv = { Variables: { principal: Principal | null; account: SignedIn | null } };

// Set for every org route behind the signed-in check.
function signedIn(principal: Principal | null): Principal {
  if (!principal) throw new Error("route reached without a principal");
  return principal;
}

// Set for every route behind the signed-in check.
function accountOf(account: SignedIn | null) {
  if (!account) throw new Error("route reached without an account");
  return { userId: account.userId, email: account.email };
}

// The header that names the org a request acts in; `?org=` names it where headers cannot be sent.
export const ORG_HEADER = "X-Mage-Org";

// Routes about the person rather than one of their orgs, which work whichever org is named.
const PERSONAL_ROUTES = [
  "/v1/orgs",
  "/v1/org-invites/",
  "/v1/locate",
  "/v1/shared-threads",
  "/v1/invites/",
];

function summary(
  connection: Connection,
  proxy: ProxySummary | null = null,
  hints: Record<string, string> = {},
): ConnectionSummary {
  const { id, host, authKind, account, label, settings, createdAt } = connection;
  return {
    id,
    host,
    authKind,
    account,
    label,
    settings,
    hints,
    proxy,
    createdAt: createdAt.toISOString(),
  };
}

function connectionModelsBody(list: {
  autoEnable: boolean;
  models: (ConnectionModel & { orgDefault: boolean })[];
  spacesUsingOff?: { id: string; name: string }[];
}): ConnectionModels {
  return {
    ...list,
    models: list.models.map(({ firstSeenAt, ...model }) => ({
      ...model,
      firstSeenAt: firstSeenAt.toISOString(),
    })),
  };
}

function spaceSummary(space: SpaceView): SpaceSummary {
  const { id, kind, name, primary, role, manage, everyoneRole, defaultModel, defaultEffort } =
    space;
  return {
    id,
    kind,
    name,
    primary,
    role,
    manage,
    everyoneRole,
    defaultModel,
    defaultEffort,
    createdAt: space.createdAt.toISOString(),
  };
}

function folderSummary(folder: Folder): FolderSummary {
  const { id, spaceId, name, createdAt, updatedAt } = folder;
  return {
    id,
    spaceId,
    name,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function attemptSummary(attempt: AttemptStatus): AttemptSummary {
  return attempt.status === "connected"
    ? { status: "connected", connection: summary(attempt.connection) }
    : attempt;
}

// A JSON body that must match the schema; otherwise 400 with the error given.
function jsonBody<T extends z.ZodType>(schema: T, error: string) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return c.json({ error }, 400);
    return parsed.data as z.output<T>;
  });
}

const setDefaultModel = jsonBody(setDefaultModelSchema, "ref is required");
const setTitleModel = jsonBody(setTitleModelSchema, "ref must be a model ref or null");
const spaceName = jsonBody(spaceNameSchema, "A name of 1 to 80 characters is required");
const setDefaultEffort = jsonBody(defaultEffortSchema, "effort is low, medium, high or null");
const spaceDefaults = jsonBody(
  spaceDefaultsSchema,
  "Give a model ref or null, or an effort of low, medium, high or null",
);
const newThread = jsonBody(
  newThreadSchema,
  "text must be a non-empty string, folderId an id, model a ref, effort low, medium or high",
);
const folderName = jsonBody(folderNameSchema, "A name of 1 to 80 characters is required");
const threadUpdate = jsonBody(threadUpdateSchema, "Give a title, a model or a folder");
const message = jsonBody(messageInputSchema, "text is required; mode is steer, queue or interrupt");
const pendingChange = jsonBody(pendingChangeSchema, "Give a text, or a mode of steer or queue");
const retry = jsonBody(retrySchema, "runId is required");
const threadRead = jsonBody(threadReadSchema, "seq is required");
const toolDecision = jsonBody(toolDecisionSchema, "allow is required; scope is once or for_now");
// A body that must match the schema; otherwise 400 with what is wrong first.
function checkedBody<T extends z.ZodType>(schema: T) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "The body is not valid" }, 400);
    }
    return parsed.data as z.output<T>;
  });
}

const newMcpServer = checkedBody(newMcpServerSchema);
const mcpServerChange = checkedBody(mcpServerChangeSchema);
const spaceServersChange = jsonBody(spaceServersChangeSchema, "allowed is true or false");
const mcpEnabledChange = jsonBody(mcpEnabledChangeSchema, "enabled is true or false");

// Where the browser goes back to once an authorization finishes: the server's page.
function mcpServerPage(server: Pick<McpServerSummary, "id" | "spaceId"> | null) {
  if (!server) return "/org/tools";
  return server.spaceId
    ? `/s/${server.spaceId}/settings/tools/mcp/${server.id}`
    : `/org/tools/mcp/${server.id}`;
}

const toolModeChange = jsonBody(
  toolModeChangeSchema,
  "Give toolIds and a mode of allow, ask or block",
);
const newInvite = jsonBody(newInviteSchema, "accessFor is 1h, 1d, 7d or never");
const acceptInvite = jsonBody(acceptInviteSchema, "token is required");
const orgName = jsonBody(orgNameSchema, "A name of 1 to 80 characters is required");
const newOrgInvite = jsonBody(newOrgInviteSchema, "Give an email address and a role");
const setOrgRole = jsonBody(setOrgRoleSchema, "role is owner or member");
const newOrgMember = jsonBody(newOrgMemberSchema, "Give a directory person's id and a role");
const newGroupLink = jsonBody(newGroupLinkSchema, "Give a directory group's id and a role");
const acceptOrgInvite = jsonBody(acceptOrgInviteSchema, "token is required");
const teamSettingsChange = jsonBody(teamSettingsChangeSchema, "Give spaceCreation or memberSpaces");
const setSpaceMember = jsonBody(
  setSpaceMemberSchema,
  "Give a user or group id and a role of owner, messager, viewer or null",
);
const setEveryone = jsonBody(setEveryoneSchema, "role is messager, viewer or null");

// `?space=` or `?thread=` to find the org of.
const placeQuery = validator("query", (value: { space?: string; thread?: string }) => ({
  space: typeof value.space === "string" ? value.space : undefined,
  thread: typeof value.thread === "string" ? value.thread : undefined,
}));

// A connection body: the host, the way it connects with each of its fields, and its proxy, if
// any, every header given a value; refused with what is wrong.
const connectionInput = validator("json", (value, c) => {
  const parsed = connectionInputSchema.safeParse(value);
  if (!parsed.success) {
    return c.json({ error: "Give a provider, a way to connect and its fields" }, 400);
  }
  const { proxy: rawProxy, ...input } = parsed.data;
  if (rawProxy === undefined || rawProxy === null) return { ...input, proxy: null };
  const proxy = proxyInputSchema.safeParse(rawProxy);
  if (!proxy.success) {
    const issue = proxy.error.issues[0];
    const error =
      issue?.path[0] === "baseUrl" ? "The base URL must be an http or https URL" : issue?.message;
    return c.json({ error: error ?? "Give a base URL and headers" }, 400);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(proxy.data.headers)) {
    if (headerValue === null) return c.json({ error: `Give a value for ${name}` }, 400);
    headers[name] = headerValue;
  }
  const empty = !proxy.data.baseUrl && Object.keys(headers).length === 0;
  return { ...input, proxy: empty ? null : { baseUrl: proxy.data.baseUrl, headers } };
});

const connectionModelsChange = jsonBody(
  connectionModelsChangeSchema,
  "Give autoEnable, or set with model ids and enabled",
);

const connectionChange = jsonBody(
  connectionChangeSchema,
  "Give a way to connect, a label of at most 80 characters, and its fields",
);

// A proxy body, refused with what is wrong with it.
const proxyInput = validator("json", (value, c) => {
  const parsed = proxyInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error =
      issue?.path[0] === "baseUrl" ? "The base URL must be an http or https URL" : issue?.message;
    return c.json({ error: error ?? "Give a base URL and headers" }, 400);
  }
  return parsed.data;
});

// A query string that must match the schema; otherwise 400.
function queryOf<T extends z.ZodType>(schema: T) {
  return validator("query", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return c.json({ error: "Give q, limit, cursor and filters as they are" }, 400);
    return parsed.data as z.output<T>;
  });
}

const pageQuery = queryOf(pageQuerySchema);
const memberQuery = queryOf(memberFilterSchema);
const peopleQuery = queryOf(peopleFilterSchema);
const orgSpaceQuery = queryOf(orgSpaceFilterSchema);
const spaceMemberQuery = queryOf(spaceMemberFilterSchema);
const threadPageQuery = queryOf(threadPageQuerySchema);
const spaceThreadPageQuery = queryOf(spaceThreadPageQuerySchema);

// `?q=` with the text to find in thread titles.
const threadSearch = validator("query", (value: { q?: string }, c) => {
  const parsed = threadSearchSchema.safeParse(value);
  if (!parsed.success) return c.json({ error: "q must be 1 to 200 characters" }, 400);
  return parsed.data;
});

// `?refresh=1` reads the lists again instead of from the cache.
const refreshQuery = validator("query", (value: { refresh?: string }) => ({
  refresh: value.refresh === "1",
}));

// Owners change what applies to the whole org.
function requireAdmin(principal: Principal) {
  if (principal.role !== "owner") {
    throw new ServiceError(403, "Only the organization's owners can change this");
  }
}

// Also how often a stream checks its reader may still read the thread.
const HEARTBEAT_MS = 15_000;

// Waits until a stream's next heartbeat, or until the server stops.
function heartbeat({ heartbeatMs = HEARTBEAT_MS, shutdown }: AppOptions) {
  return sleep(heartbeatMs, undefined, { signal: shutdown }).catch(() => {});
}

// Where a live event stream resumes: after the Last-Event-ID a reconnecting browser sends, or
// `?after=`, or from the start.
const eventCursor = validator("query", (value: { after?: string }, c) => {
  const raw = c.req.header("Last-Event-ID") ?? value.after ?? "0";
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) {
    return c.json({ error: "The cursor must be a seq" }, 400);
  }
  return { after };
});

// The typed API routes, mounted under /api.
function createApi(options: AppOptions) {
  const {
    identity,
    connections,
    models,
    spaces,
    folders,
    threads,
    guests,
    orgs,
    groups,
    tools,
    mcp,
  } = options;

  // A connection as the API shows it, with its proxy and the ends of its secrets.
  function shown(owner: Principal, connection: Connection) {
    return summary(
      connection,
      connections.proxyOf(owner, connection.id),
      connections.hintsOf(owner, connection.id),
    );
  }

  return (
    new Hono<ApiEnv>()
      .get("/sign-in-options", (c) => c.json(options.signInOptions, 200))
      // What an org invite link offers; signed out, the whole email it is for.
      .get("/org-invites/:token", async (c) => {
        const account = await identity.resolve(c.req.raw.headers, null);
        return c.json(orgs.preview(c.req.param("token"), account && accountOf(account)), 200);
      })
      // Where an MCP server's authorization server sends the browser back, for whoever began it.
      .get("/mcp/oauth/callback", async (c) => {
        const account = await identity.resolve(c.req.raw.headers, null);
        const { state, code, iss, error } = c.req.query();
        const { server } = await mcp.finishAuthorization(account?.userId ?? null, {
          state,
          code,
          iss,
          error,
        });
        return c.redirect(mcpServerPage(server), 302);
      })
      .use("/v1/*", async (c, next) => {
        const named = c.req.header(ORG_HEADER) ?? c.req.query("org") ?? null;
        let account = await identity.resolve(c.req.raw.headers, named);
        if (!account) return c.json({ error: "unauthorized" }, 401);
        if (!account.principal && named) {
          // An org the person is not in is not found, except on routes about the person.
          const personal = PERSONAL_ROUTES.some((route) => c.req.path.startsWith(`/api${route}`));
          if (!personal) return c.json({ error: ORG_NOT_FOUND }, 404);
          account = await identity.resolve(c.req.raw.headers, null);
          if (!account) return c.json({ error: "unauthorized" }, 401);
        }
        if (!account.principal) return c.json({ error: ORG_NOT_FOUND }, 404);
        c.set("account", account);
        c.set("principal", account.principal);
        await next();
      })
      .get("/health", async (c) => {
        const database = await options.pingDatabase();
        return c.json({ ok: database, database }, database ? 200 : 503);
      })
      .get("/v1/me", async (c) => {
        return c.json((await identity.profile(signedIn(c.var.principal))) satisfies Me, 200);
      })
      .get("/v1/orgs", (c) => {
        return c.json(orgs.list(accountOf(c.var.account)), 200);
      })
      .post("/v1/orgs", orgName, async (c) => {
        return c.json(await orgs.create(accountOf(c.var.account), c.req.valid("json").name), 200);
      })
      .get("/v1/locate", placeQuery, (c) => {
        const orgId = orgs.locate(accountOf(c.var.account), c.req.valid("query"));
        if (!orgId) return c.json({ error: "Not found" }, 404);
        return c.json({ orgId }, 200);
      })
      .post("/v1/org-invites/accept", acceptOrgInvite, async (c) => {
        const { token } = c.req.valid("json");
        return c.json(await orgs.accept(accountOf(c.var.account), token), 200);
      })
      .patch("/v1/org", orgName, (c) => {
        orgs.rename(signedIn(c.var.principal), c.req.valid("json").name);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org", (c) => {
        orgs.delete(signedIn(c.var.principal));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/spaces", orgSpaceQuery, (c) => {
        const { kind, everyone, ...query } = c.req.valid("query");
        const page = spaces.catalog(signedIn(c.var.principal), {
          ...pageParams(query),
          ...(kind && { kind }),
          ...(everyone && { everyone }),
        });
        return c.json(
          {
            ...page,
            items: page.items.map(({ ownerName, memberCount, hasThreads, ...space }) => ({
              ...spaceSummary(space),
              ownerName,
              memberCount,
              hasThreads,
            })),
          },
          200,
        );
      })
      .get("/v1/org/members", memberQuery, (c) => {
        const { role, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(role && { role }) };
        return c.json(orgs.members(signedIn(c.var.principal), params), 200);
      })
      .get("/v1/org/members/:userId", (c) => {
        return c.json(orgs.member(signedIn(c.var.principal), c.req.param("userId")), 200);
      })
      .get("/v1/org/members/:userId/groups", pageQuery, (c) => {
        const params = pageParams(c.req.valid("query"));
        const page = orgs.groupsOf(signedIn(c.var.principal), c.req.param("userId"), params);
        return c.json(
          {
            ...page,
            items: page.items.map((group) => ({
              id: group.id,
              name: group.name,
              source: group.source,
              role: group.role,
              memberCount: group.memberCount,
              createdAt: group.createdAt.toISOString(),
            })),
          },
          200,
        );
      })
      .get("/v1/org/people", peopleQuery, (c) => {
        const { role, status, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(role && { role }), ...(status && { status }) };
        return c.json(orgs.people(signedIn(c.var.principal), params), 200);
      })
      .patch("/v1/org/members/:userId", setOrgRole, (c) => {
        const { role } = c.req.valid("json");
        orgs.setRole(signedIn(c.var.principal), c.req.param("userId"), role);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org/members/:userId", (c) => {
        orgs.removeMember(signedIn(c.var.principal), c.req.param("userId"));
        return c.json({ ok: true }, 200);
      })
      .post("/v1/org/members", newOrgMember, (c) => {
        const { userId, role } = c.req.valid("json");
        orgs.addMember(signedIn(c.var.principal), userId, role);
        return c.json({ ok: true }, 200);
      })
      .post("/v1/org/groups", newGroupLink, (c) => {
        const { groupId, role } = c.req.valid("json");
        orgs.linkGroup(signedIn(c.var.principal), groupId, role);
        return c.json({ ok: true }, 200);
      })
      .patch("/v1/org/groups/:id", setOrgRole, (c) => {
        orgs.setGroupRole(signedIn(c.var.principal), c.req.param("id"), c.req.valid("json").role);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/org/groups/:id", (c) => {
        orgs.unlinkGroup(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/directory/people", pageQuery, (c) => {
        const page = orgs.directoryPeople(
          signedIn(c.var.principal),
          pageParams(c.req.valid("query")),
        );
        return c.json(
          {
            ...page,
            items: page.items.map(({ id, name, email, role }) => ({
              userId: id,
              name,
              email,
              role,
            })),
          },
          200,
        );
      })
      .get("/v1/directory/groups", pageQuery, (c) => {
        const page = orgs.directoryGroups(
          signedIn(c.var.principal),
          pageParams(c.req.valid("query")),
        );
        return c.json(
          {
            ...page,
            items: page.items.map(({ id, name, memberCount, role }) => ({
              id,
              name,
              memberCount,
              role,
            })),
          },
          200,
        );
      })
      .post("/v1/org/invites", newOrgInvite, (c) => {
        const { email, role } = c.req.valid("json");
        return c.json(orgs.invite(signedIn(c.var.principal), email, role), 200);
      })
      .delete("/v1/org/invites/:id", (c) => {
        orgs.revokeInvite(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/settings", (c) => {
        return c.json(orgs.settings(signedIn(c.var.principal)), 200);
      })
      .patch("/v1/org/settings", teamSettingsChange, (c) => {
        return c.json(orgs.setSettings(signedIn(c.var.principal), c.req.valid("json")), 200);
      })
      .get("/v1/org/groups", pageQuery, (c) => {
        return c.json(
          groups.list(signedIn(c.var.principal), pageParams(c.req.valid("query"))),
          200,
        );
      })
      .get("/v1/org/groups/:id", (c) => {
        return c.json(groups.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .get("/v1/org/groups/:id/members", pageQuery, (c) => {
        const params = pageParams(c.req.valid("query"));
        return c.json(groups.members(signedIn(c.var.principal), c.req.param("id"), params), 200);
      })
      .get("/v1/models", refreshQuery, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const list = await models.resolveModels(orgId, c.req.valid("query"));
        return c.json(list satisfies ModelListSummary, 200);
      })
      .get("/v1/settings/default-model", (c) => {
        const ref = models.defaultModel(signedIn(c.var.principal).orgId);
        return c.json({ ref } satisfies DefaultModel, 200);
      })
      .put("/v1/settings/default-model", setDefaultModel, async (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { ref } = c.req.valid("json");
        await models.setDefaultModel(principal.orgId, ref);
        return c.json({ ref } satisfies DefaultModel, 200);
      })
      .get("/v1/settings/default-effort", (c) => {
        const effort = models.defaultEffort(signedIn(c.var.principal).orgId);
        return c.json({ effort } satisfies DefaultEffort, 200);
      })
      .put("/v1/settings/default-effort", setDefaultEffort, (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { effort } = c.req.valid("json");
        models.setDefaultEffort(principal.orgId, effort);
        return c.json({ effort } satisfies DefaultEffort, 200);
      })
      .get("/v1/settings/title-model", async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const ref = models.chosenTitleModel(orgId);
        const automatic = await models.automaticTitleModel(orgId);
        return c.json({ ref, automatic } satisfies TitleModel, 200);
      })
      .put("/v1/settings/title-model", setTitleModel, async (c) => {
        const principal = signedIn(c.var.principal);
        requireAdmin(principal);
        const { ref } = c.req.valid("json");
        await models.setTitleModel(principal.orgId, ref);
        const automatic = await models.automaticTitleModel(principal.orgId);
        return c.json({ ref, automatic } satisfies TitleModel, 200);
      })
      .get("/v1/spaces", (c) => {
        return c.json(spaces.list(signedIn(c.var.principal)).map(spaceSummary), 200);
      })
      .post("/v1/spaces", spaceName, (c) => {
        const space = spaces.create(signedIn(c.var.principal), c.req.valid("json").name);
        return c.json(spaceSummary(space), 200);
      })
      .patch("/v1/spaces/:id", spaceName, (c) => {
        const { name } = c.req.valid("json");
        const space = spaces.rename(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(spaceSummary(space), 200);
      })
      .patch("/v1/spaces/:id/defaults", spaceDefaults, async (c) => {
        const changes = c.req.valid("json");
        const space = await spaces.setDefaults(
          signedIn(c.var.principal),
          c.req.param("id"),
          changes,
        );
        return c.json(spaceSummary(space), 200);
      })
      .delete("/v1/spaces/:id", (c) => {
        spaces.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/spaces/:id/members", spaceMemberQuery, (c) => {
        const { role, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(role && { role }) };
        return c.json(spaces.members(signedIn(c.var.principal), c.req.param("id"), params), 200);
      })
      .put("/v1/spaces/:id/members", setSpaceMember, (c) => {
        const { kind, id, role } = c.req.valid("json");
        spaces.setMember(signedIn(c.var.principal), c.req.param("id"), { kind, id }, role);
        return c.json({ ok: true }, 200);
      })
      .put("/v1/spaces/:id/everyone", setEveryone, (c) => {
        const { role } = c.req.valid("json");
        const space = spaces.setEveryone(signedIn(c.var.principal), c.req.param("id"), role);
        return c.json(spaceSummary(space), 200);
      })
      .get("/v1/spaces/:id/folders", (c) => {
        const list = folders.list(signedIn(c.var.principal), c.req.param("id"));
        return c.json(list.map(folderSummary), 200);
      })
      .post("/v1/spaces/:id/folders", folderName, (c) => {
        const { name } = c.req.valid("json");
        const folder = folders.create(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(folderSummary(folder), 200);
      })
      .patch("/v1/folders/:id", folderName, (c) => {
        const { name } = c.req.valid("json");
        const folder = folders.rename(signedIn(c.var.principal), c.req.param("id"), name);
        return c.json(folderSummary(folder), 200);
      })
      .delete("/v1/folders/:id", (c) => {
        folders.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/spaces/:id/threads", (c) => {
        return c.json(threads.list(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .get("/v1/spaces/:id/threads/sidebar", (c) => {
        return c.json(threads.sidebar(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .get("/v1/spaces/:id/threads/page", spaceThreadPageQuery, (c) => {
        const { folder, show, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(folder && { folder }), ...(show && { show }) };
        return c.json(threads.listPage(signedIn(c.var.principal), c.req.param("id"), params), 200);
      })
      .post("/v1/spaces/:id/threads", newThread, async (c) => {
        const input = c.req.valid("json");
        const thread = await threads.create(signedIn(c.var.principal), c.req.param("id"), input);
        return c.json(thread, 200);
      })
      .get("/v1/shared-threads", (c) => {
        return c.json(threads.shared(signedIn(c.var.principal)), 200);
      })
      .get("/v1/shared-threads/page", threadPageQuery, (c) => {
        const { show, ...query } = c.req.valid("query");
        const params = { ...pageParams(query), ...(show && { show }) };
        return c.json(threads.sharedPage(signedIn(c.var.principal), params), 200);
      })
      .post("/v1/invites/accept", acceptInvite, (c) => {
        const { token } = c.req.valid("json");
        return c.json(guests.accept(signedIn(c.var.principal), token), 200);
      })
      .get("/v1/threads/search", threadSearch, (c) => {
        const { q } = c.req.valid("query");
        return c.json(threads.search(signedIn(c.var.principal), q), 200);
      })
      .get("/v1/threads/:id", async (c) => {
        return c.json(await threads.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/threads/:id", threadUpdate, async (c) => {
        const changes = c.req.valid("json");
        const thread = await threads.update(signedIn(c.var.principal), c.req.param("id"), changes);
        return c.json(thread, 200);
      })
      .delete("/v1/threads/:id", (c) => {
        threads.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/threads/:id/events", eventCursor, (c) => {
        const principal = signedIn(c.var.principal);
        const id = c.req.param("id");
        // Answers 404 before the stream starts.
        threads.visible(principal, id);
        const { after } = c.req.valid("query");
        return streamSSE(c, async (stream) => {
          // One write at a time, in order.
          let writing = Promise.resolve();
          function write(send: () => Promise<void>) {
            writing = writing.then(send, send);
            return writing;
          }
          // Events carry their seq as the id a reconnecting browser resumes after; reply pieces
          // carry none, and are sent again from the start of each reply on reconnecting.
          const unsubscribe = threads.follow(principal, id, after, (item) => {
            void write(() =>
              item.kind === "event"
                ? stream.writeSSE({
                    id: String(item.event.seq),
                    event: "thread-event",
                    data: JSON.stringify(item.event),
                  })
                : stream.writeSSE({ event: "message-delta", data: JSON.stringify(item.delta) }),
            );
          });
          stream.onAbort(unsubscribe);
          while (!stream.aborted && !options.shutdown?.aborted) {
            await heartbeat(options);
            if (stream.aborted || options.shutdown?.aborted) break;
            // Whoever may no longer read the thread, as a guest whose access ended or a member who
            // left its space, is told so, and the stream ends.
            if (!threads.readable(principal, id)) {
              unsubscribe();
              await write(() => stream.writeSSE({ event: "access-ended", data: "{}" }));
              break;
            }
            await write(() => stream.write(": heartbeat\n\n").then(() => {}));
          }
          // The server is stopping.
          if (!stream.aborted && options.shutdown?.aborted) unsubscribe();
        });
      })
      .put("/v1/threads/:id/read", threadRead, (c) => {
        const { seq } = c.req.valid("json");
        return c.json(threads.markRead(signedIn(c.var.principal), c.req.param("id"), seq), 200);
      })
      .get("/v1/inbox/events", (c) => {
        const principal = signedIn(c.var.principal);
        return streamSSE(c, async (stream) => {
          // One write at a time, in order.
          let writing = Promise.resolve();
          function write(send: () => Promise<void>) {
            writing = writing.then(send, send);
            return writing;
          }
          const inbox = threads.inbox(principal, (item) => {
            void write(() =>
              item.kind === "thread"
                ? stream.writeSSE({
                    event: "thread",
                    data: JSON.stringify({ thread: item.thread, shared: item.shared }),
                  })
                : item.kind === "read"
                  ? stream.writeSSE({
                      event: "thread-read",
                      data: JSON.stringify({ threadId: item.threadId, seq: item.seq }),
                    })
                  : stream.writeSSE({
                      event: "thread-gone",
                      data: JSON.stringify({ threadId: item.threadId }),
                    }),
            );
          });
          stream.onAbort(() => inbox.stop());
          while (!stream.aborted && !options.shutdown?.aborted) {
            await heartbeat(options);
            if (stream.aborted || options.shutdown?.aborted) break;
            // Threads the reader can no longer read, as a guest whose access ended, are gone.
            inbox.recheck();
            await write(() => stream.write(": heartbeat\n\n").then(() => {}));
          }
          inbox.stop();
        });
      })
      .post("/v1/threads/:id/messages", message, (c) => {
        const { text, mode } = c.req.valid("json");
        const principal = signedIn(c.var.principal);
        return c.json(threads.postMessage(principal, c.req.param("id"), text, mode), 202);
      })
      .patch("/v1/threads/:id/messages/:messageId", pendingChange, (c) => {
        const { id, messageId } = c.req.param();
        const change = c.req.valid("json");
        return c.json(threads.changeMessage(signedIn(c.var.principal), id, messageId, change), 200);
      })
      .delete("/v1/threads/:id/messages/:messageId", (c) => {
        const { id, messageId } = c.req.param();
        return c.json(threads.withdrawMessage(signedIn(c.var.principal), id, messageId), 200);
      })
      .post("/v1/threads/:id/stop", (c) => {
        threads.stop(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 202);
      })
      .post("/v1/threads/:id/tools/:callId/decision", toolDecision, (c) => {
        const { id, callId } = c.req.param();
        const decision = c.req.valid("json");
        tools.decide(signedIn(c.var.principal), id, callId, decision);
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/tools", (c) => {
        return c.json(tools.orgTools(signedIn(c.var.principal)), 200);
      })
      .patch("/v1/org/tools", toolModeChange, (c) => {
        const principal = signedIn(c.var.principal);
        tools.setOrgTools(principal, c.req.valid("json"));
        return c.json(tools.orgTools(principal), 200);
      })
      .get("/v1/spaces/:id/tools", (c) => {
        return c.json(tools.spaceTools(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/spaces/:id/tools", toolModeChange, (c) => {
        const principal = signedIn(c.var.principal);
        tools.setSpaceTools(principal, c.req.param("id"), c.req.valid("json"));
        return c.json(tools.spaceTools(principal, c.req.param("id")), 200);
      })
      .get("/v1/org/mcp-servers", (c) => {
        return c.json(mcp.orgServers(signedIn(c.var.principal)), 200);
      })
      .post("/v1/org/mcp-servers", newMcpServer, async (c) => {
        return c.json(await mcp.addToOrg(signedIn(c.var.principal), c.req.valid("json")), 200);
      })
      .put("/v1/org/mcp-servers/space-servers", spaceServersChange, (c) => {
        const principal = signedIn(c.var.principal);
        mcp.setSpaceServers(principal, c.req.valid("json").allowed);
        return c.json(mcp.orgServers(principal), 200);
      })
      .get("/v1/spaces/:id/mcp-servers", (c) => {
        return c.json(mcp.spaceServers(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/spaces/:id/mcp-servers", newMcpServer, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await mcp.addToSpace(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .put("/v1/spaces/:id/mcp-servers/:serverId", mcpEnabledChange, (c) => {
        const principal = signedIn(c.var.principal);
        const { id, serverId } = c.req.param();
        mcp.setInSpace(principal, id, serverId, c.req.valid("json").enabled);
        return c.json(mcp.spaceServers(principal, id), 200);
      })
      .get("/v1/mcp-servers/:id", (c) => {
        return c.json(mcp.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/mcp-servers/:id", mcpServerChange, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await mcp.change(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .put("/v1/mcp-servers/:id/enabled", mcpEnabledChange, (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(
          mcp.setEnabled(principal, c.req.param("id"), c.req.valid("json").enabled),
          200,
        );
      })
      .post("/v1/mcp-servers/:id/refresh", async (c) => {
        return c.json(await mcp.refresh(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/mcp-servers/:id/authorize", async (c) => {
        return c.json(await mcp.authorize(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .delete("/v1/mcp-servers/:id", (c) => {
        mcp.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .post("/v1/threads/:id/retry", retry, (c) => {
        const { runId } = c.req.valid("json");
        return c.json(threads.retry(signedIn(c.var.principal), c.req.param("id"), runId), 202);
      })
      .post("/v1/threads/:id/invites", newInvite, (c) => {
        const { accessFor } = c.req.valid("json");
        return c.json(guests.invite(signedIn(c.var.principal), c.req.param("id"), accessFor), 200);
      })
      .get("/v1/threads/:id/people", (c) => {
        return c.json(guests.people(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .delete("/v1/threads/:id/invites/:inviteId", (c) => {
        const { id, inviteId } = c.req.param();
        guests.revokeInvite(signedIn(c.var.principal), id, inviteId);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/threads/:id/guests/:userId", (c) => {
        const { id, userId } = c.req.param();
        guests.revokeGuest(signedIn(c.var.principal), id, userId);
        return c.json({ ok: true }, 200);
      })
      // Everyone in an org sees its connections; only its owners change them, and a team org
      // connects with no subscription sign-ins.
      .use("/v1/connections/*", async (c, next) => {
        const { org, role } = await identity.profile(signedIn(c.var.principal));
        const reading =
          c.req.method === "GET" && /^\/api\/v1\/connections(\/[^/]+\/models)?$/.test(c.req.path);
        if (!reading && role !== "owner") {
          return c.json(
            { error: "Only the organization's owners can manage model providers" },
            403,
          );
        }
        if (org.kind === "team" && c.req.path.startsWith("/api/v1/connections/codex/")) {
          return c.json(
            {
              error: "Subscription sign-ins are for personal organizations; add an API key instead",
            },
            403,
          );
        }
        await next();
      })
      .get("/v1/connections", (c) => {
        const owner = signedIn(c.var.principal);
        const list = connections.list(owner);
        return c.json(
          list.map((connection) => shown(owner, connection)),
          200,
        );
      })
      .patch("/v1/connections/:id/proxy", proxyInput, (c) => {
        const owner = signedIn(c.var.principal);
        const id = c.req.param("id");
        connections.setProxy(owner, id, c.req.valid("json"));
        models.invalidate(id);
        const connection = connections.list(owner).find((found) => found.id === id);
        if (!connection) throw new ConnectionError(404, "Connection not found");
        return c.json(shown(owner, connection), 200);
      })
      .post("/v1/connections", connectionInput, async (c) => {
        const owner = signedIn(c.var.principal);
        const { host, method: methodId, label, values, proxy } = c.req.valid("json");
        const split = splitValues(host, methodId, values);
        if (!split.ok) return c.json({ error: split.error }, 400);
        const { method, settings, secrets } = split;
        if (method.authKind === "oauth") return c.json({ error: "Sign in instead" }, 400);
        const connection = await models.add(owner, {
          host,
          authKind: method.authKind,
          label,
          settings,
          secrets,
          proxy,
        });
        return c.json(shown(owner, connection), 200);
      })
      .patch("/v1/connections/:id", connectionChange, async (c) => {
        const owner = signedIn(c.var.principal);
        const id = c.req.param("id");
        const { method: methodId, label, values } = c.req.valid("json");
        const { connection, values: merged } = connections.editValues(owner, id, values);
        const current = methodOf(connection.host, connection.settings.method, connection.authKind);
        const split = splitValues(connection.host, methodId ?? current?.id ?? "", merged);
        if (!split.ok) return c.json({ error: split.error }, 400);
        const { method, settings, secrets } = split;
        if (method.authKind === "oauth") return c.json({ error: "Sign in instead" }, 400);
        const changed = await models.edit(owner, id, {
          authKind: method.authKind,
          label: label === undefined ? connection.label : label,
          settings,
          secrets,
        });
        return c.json(shown(owner, changed), 200);
      })
      .get("/v1/connections/:id/models", refreshQuery, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const list = await models.connectionModels(orgId, c.req.param("id"), c.req.valid("query"));
        return c.json(connectionModelsBody(list), 200);
      })
      .patch("/v1/connections/:id/models", connectionModelsChange, async (c) => {
        const { orgId } = signedIn(c.var.principal);
        const result = await models.setConnectionModels(
          orgId,
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json(connectionModelsBody(result), 200);
      })
      .post("/v1/connections/codex/device", async (c) => {
        return c.json(await connections.startDevice("codex", signedIn(c.var.principal)), 200);
      })
      .get("/v1/connections/codex/attempts/:id", (c) => {
        const owner = signedIn(c.var.principal);
        return c.json(attemptSummary(connections.attempt("codex", owner, c.req.param("id"))), 200);
      })
      .post("/v1/connections/codex/attempts/:id/cancel", (c) => {
        connections.cancel("codex", signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/connections/:id", (c) => {
        connections.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}

export type Api = ReturnType<typeof createApi>;

export function createApp(options: AppOptions): App {
  const { logger } = options;
  const app: App = new Hono();

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    logger.info(
      {
        reqId: c.var.requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof ServiceError) {
      return c.json({ error: err.message, ...(err.reason && { reason: err.reason }) }, err.status);
    }
    if (err instanceof ConnectionError) return c.json({ error: err.message }, err.status);
    logger.error({ reqId: c.var.requestId, err }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  app.route("/api", createApi(options));
  app.on(["GET", "POST"], "/api/auth/*", (c) => options.handleAuth(c.req.raw));
  // A SCIM directory also replaces, patches and deletes what it provisioned.
  app.on(["PUT", "PATCH", "DELETE"], "/api/auth/scim/v2/*", (c) => options.handleAuth(c.req.raw));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (options.webRoot) {
    const indexHtml = serveStatic({ root: options.webRoot, path: "index.html" });
    app.use("*", serveStatic({ root: options.webRoot }));
    // Extensionless paths are client routes; a missing file with an extension is a 404.
    app.get("*", async (c, next) =>
      /\.[^/]*$/.test(c.req.path) ? c.notFound() : indexHtml(c, next),
    );
  }

  return app;
}

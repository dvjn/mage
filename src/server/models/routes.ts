import { Hono } from "hono";
import { validator } from "hono/validator";

import { type ApiEnv, signedIn, jsonBody } from "@/server/http.ts";
import type { Identity, Principal } from "@/server/orgs/identity.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import {
  type AttemptSummary,
  type ConnectionSummary,
  pastedCodeSchema,
  proxyInputSchema,
  type ProxySummary,
} from "@/shared/connections.ts";
import {
  connectionChangeSchema,
  connectionInputSchema,
  methodOf,
  splitValues,
} from "@/shared/hosts.ts";
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
  type Connection,
  type AttemptStatus,
  ConnectionError,
  type Connections,
} from "./connections.ts";
import type { ConnectionModel, Models } from "./service.ts";

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

function attemptSummary(attempt: AttemptStatus): AttemptSummary {
  return attempt.status === "connected"
    ? { status: "connected", connection: summary(attempt.connection) }
    : attempt;
}

const setDefaultModel = jsonBody(setDefaultModelSchema, "ref is required");

const setTitleModel = jsonBody(setTitleModelSchema, "ref must be a model ref or null");

const setDefaultEffort = jsonBody(defaultEffortSchema, "effort is low, medium, high or null");

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

const pastedCode = jsonBody(pastedCodeSchema, "Paste the code");

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

export function modelRoutes(options: {
  identity: Identity;
  connections: Connections;
  models: Models;
}) {
  const { identity, connections, models } = options;

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
        if (org.kind === "team" && /^\/api\/v1\/connections\/(codex|claude)\//.test(c.req.path)) {
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
      .post("/v1/connections/claude/authorization", (c) => {
        return c.json(connections.startAuthorization("claude", signedIn(c.var.principal)), 200);
      })
      .post("/v1/connections/claude/attempts/:id/code", pastedCode, async (c) => {
        const connection = await connections.finishAuthorization(
          "claude",
          signedIn(c.var.principal),
          c.req.param("id"),
          c.req.valid("json").code,
        );
        return c.json(summary(connection), 200);
      })
      .delete("/v1/connections/:id", (c) => {
        connections.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}

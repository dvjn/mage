// The models an org can use: each of its connections' lists, kept for an hour, merged under refs of
// the form `<host>/<model id>` for a sign-in and `<connection id>/<model id>` for the rest, each
// with who makes it, the defaults new threads start with, chosen from them, and opening a model to
// stream a reply from through its connection, and the model that names threads: the org's choice,
// or a small model of its first connection that has one. A key, cloud credentials or a server is
// added, or changed, only once its host lists models with them; a change keeps the connection's
// refs, as they are named by its id. Each connection's models can be turned off, and
// those it lists for the first time are turned on or not as the connection says; a model turned off
// is in no picker and does not reply.

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { OrgSettings, OrgSettingStore } from "@/server/orgs/service.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import { connectionLabel } from "@/shared/connections.ts";
import { type HostId, HOSTS, hostOf, isHost } from "@/shared/hosts.ts";
import { type MakerId, makerOf } from "@/shared/makers.ts";
import { type ModelPair, replyCandidates } from "@/shared/models.ts";
import type { ShownModel } from "@/shared/threads/list.ts";
import type { Effort } from "@/shared/threads/thread.ts";

import type { Catalog, CatalogModel } from "./catalog.ts";
import {
  type Connection,
  type ConnectionStore,
  ConnectionError,
  type Connections,
  type HostConnectionChange,
  type NewHostConnection,
  type Owner,
} from "./connections.ts";
import {
  ModelError,
  ModelTurnedOff,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
  type ProviderProxy,
} from "./gateway.ts";

export interface ModelChoice {
  enabled: boolean;
  firstSeenAt: Date;
}

export interface ModelChoiceStore {
  // Records the models of the list not seen before, turned on or off as given, and returns every
  // model's choice by id.
  sync(
    connectionId: string,
    modelIds: string[],
    enableNew: boolean,
    now: Date,
  ): Map<string, ModelChoice>;
  // Turns the models given on or off, recording those not seen before as first seen now.
  set(connectionId: string, modelIds: string[], enabled: boolean, now: Date): void;
}

export interface Model extends CatalogModel {
  ref: string;
  connectionId: string;
  host: HostId;
  maker: MakerId | null;
  authKind: Connection["authKind"];
  // How people know the connection it comes through.
  connectionLabel: string;
}

// A connection's model with whether people can pick it and when its list first had it.
export interface ConnectionModel extends Model {
  enabled: boolean;
  firstSeenAt: Date;
}

// Whether a model can reply: it is listed and on, turned off, or gone.
export interface ModelAvailability {
  ref: string;
  name: string;
  status: "ok" | "off" | "unavailable";
}

// The model a thread names, its own or the default it follows, and the one that replies instead
// while that cannot: the space's default, then the org's, then the first model still on; null
// when none can. The effort is the one that goes with the model used: with the first model still
// on, null for its usual effort.
export interface ReplyModel {
  chosen: ModelAvailability;
  used: ModelAvailability | null;
  effort: Effort | null;
}

// What a thread with no model or effort of its own follows.
export interface Defaults {
  model: string | null;
  effort: Effort | null;
}

export interface ModelList {
  models: Model[];
  // Models people turned off, which no picker offers.
  turnedOff: { ref: string; name: string; connectionId: string }[];
  // Connections whose list could not be read this time.
  errors: { connectionId: string; message: string }[];
}

export interface ModelsOptions {
  connections: ConnectionStore;
  // Reads each connection's token, renewed when it is about to expire, and adds connections.
  tokens: Pick<Connections, "withFreshToken" | "add" | "edit">;
  catalogs: Record<HostId, Catalog>;
  settings: OrgSettingStore;
  choices: ModelChoiceStore;
  // Finds the spaces that start threads on a model being turned off.
  spaces: Pick<SpaceStore, "withDefaultModel">;
  // Streams replies for the connections of each host.
  gateways: Record<HostId, ModelGateway>;
  logger: Logger;
  now?: () => Date;
}

// A model ready to stream a reply from, with its context window in tokens when known.
export interface OpenModel {
  contextWindow?: number;
  stream(request: Omit<ModelRequest, "model">, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export type Models = ReturnType<typeof createModels>;

const CACHE_MS = 60 * 60 * 1000;

// A sign-in's models are named by its host, of which an org has one; the rest by the connection.
export function modelRef(connection: Pick<Connection, "id" | "authKind" | "host">, id: string) {
  return `${connection.authKind === "oauth" ? connection.host : connection.id}/${id}`;
}

// The one place that decides what a thread follows where it has no model or effort of its own: its
// space's defaults, then its org's.
export function defaultsOf(
  space: Pick<Space, "defaultModel" | "defaultEffort">,
  org: Pick<OrgSettings, "defaultModel" | "defaultEffort">,
): Defaults {
  return {
    model: space.defaultModel ?? org.defaultModel,
    effort: space.defaultEffort ?? org.defaultEffort,
  };
}

// The model a thread replies with, and its effort: the first of `replyCandidates` that can reply,
// or, when none can, the first of them, to fail saying why; null with none.
export async function pickReplyModel(
  candidates: { ref: string | null; effort: Effort | null }[],
  availabilityOf: (ref: string) => Promise<ModelAvailability>,
): Promise<ReplyModel | null> {
  let first: ReplyModel | null = null;
  const seen = new Set<string>();
  for (const { ref, effort } of candidates) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const found = await availabilityOf(ref);
    first ??= { chosen: found, used: null, effort };
    if (found.status === "ok") return { chosen: first.chosen, used: found, effort };
  }
  return first;
}

export function createModels(options: ModelsOptions) {
  const { connections, tokens, catalogs, settings, choices, spaces, gateways, logger } = options;
  const now = options.now ?? (() => new Date());
  // Each connection's list, by connection, with its org, so one org's lists never drop another's.
  const cache = new Map<string, { orgId: string; at: number; models: CatalogModel[] }>();

  async function listOf(orgId: string, connection: Connection, refresh: boolean) {
    const { id, host } = connection;
    const cached = cache.get(id);
    if (!refresh && cached && now().getTime() - cached.at < CACHE_MS) return cached.models;
    try {
      const models = await tokens.withFreshToken(orgId, id, (token) => catalogs[host].list(token));
      cache.set(id, { orgId, at: now().getTime(), models });
      return models;
    } catch (err) {
      if (err instanceof ConnectionError) throw err;
      logger.warn({ err, host }, "model list failed");
      throw new ConnectionError(502, `Could not read the ${hostOf(host).label} models. Try again.`);
    }
  }

  // The connection's models with each one's choice, new ones recorded as the connection says.
  function withChoices(connection: Connection, models: CatalogModel[]): ConnectionModel[] {
    const chosen = choices.sync(
      connection.id,
      models.map((m) => m.id),
      connection.autoEnableModels,
      now(),
    );
    return models.map((model) => ({
      ...model,
      ref: modelRef(connection, model.id),
      connectionId: connection.id,
      host: connection.host,
      maker: model.maker ?? makerOf(hostOf(connection.host), model.id),
      authKind: connection.authKind,
      connectionLabel: connectionLabel(connection),
      enabled: chosen.get(model.id)?.enabled ?? connection.autoEnableModels,
      firstSeenAt: chosen.get(model.id)?.firstSeenAt ?? now(),
    }));
  }

  function connectionIn(orgId: string, id: string) {
    const connection = connections.find(orgId, id);
    if (!connection) throw new ConnectionError(404, "Connection not found");
    return connection;
  }

  // The connection of the list that a ref's prefix names, or null.
  function namedBy(list: Connection[], prefix: string) {
    return list.find((c) => (c.authKind === "oauth" ? c.host === prefix : c.id === prefix)) ?? null;
  }

  // The connection a ref names, or null.
  function connectionOf(orgId: string, prefix: string) {
    return namedBy(connections.list(orgId), prefix);
  }

  // The one place that decides which models exist for an org.
  async function resolveModels(orgId: string, { refresh = false } = {}): Promise<ModelList> {
    const list = connections.list(orgId);
    const ids = new Set(list.map((c) => c.id));
    for (const [id, cached] of cache) {
      if (cached.orgId === orgId && !ids.has(id)) cache.delete(id);
    }

    const results = await Promise.allSettled(list.map((c) => listOf(orgId, c, refresh)));
    const result: ModelList = { models: [], errors: [], turnedOff: [] };
    results.forEach((settled, index) => {
      const connection = list[index]!;
      const { id: connectionId } = connection;
      if (settled.status === "rejected") {
        const message = settled.reason instanceof Error ? settled.reason.message : "Failed";
        result.errors.push({ connectionId, message });
        return;
      }
      for (const { enabled, firstSeenAt: _seen, ...model } of withChoices(
        connection,
        settled.value,
      )) {
        if (enabled) result.models.push(model);
        else result.turnedOff.push({ ref: model.ref, name: model.name, connectionId });
      }
    });
    return result;
  }

  // Every model of the connection, on or off, and whether new ones are turned on; reads the list
  // again when asked.
  async function connectionModels(orgId: string, id: string, { refresh = false } = {}) {
    const connection = connectionIn(orgId, id);
    const list = await listOf(orgId, connection, refresh);
    const orgDefault = settings.get(orgId).defaultModel;
    return {
      autoEnable: connection.autoEnableModels,
      models: withChoices(connection, list).map((model) => ({
        ...model,
        orgDefault: model.ref === orgDefault,
      })),
    };
  }

  // Whether a ref names a model the org can use: ok, turned off, or gone (its provider or the model
  // itself); a model of a provider whose list cannot be read is taken to be ok. Decided from the
  // same lists as everything else.
  async function availability(orgId: string, ref: string): Promise<ModelAvailability> {
    const { models, errors, turnedOff } = await resolveModels(orgId);
    const found = models.find((model) => model.ref === ref);
    if (found) return { ref, name: found.name, status: "ok" };
    const off = turnedOff.find((model) => model.ref === ref);
    if (off) return { ref, name: off.name, status: "off" };
    const connection = connectionOf(orgId, ref.slice(0, ref.indexOf("/")));
    const unread = !!connection && errors.some((e) => e.connectionId === connection.id);
    return { ref, name: ref.slice(ref.indexOf("/") + 1), status: unread ? "ok" : "unavailable" };
  }

  // The model and effort a thread with `own` replies with; a thread that follows the defaults has
  // neither of its own.
  async function replyModel(
    space: Pick<Space, "orgId" | "defaultModel" | "defaultEffort">,
    own: ModelPair,
  ): Promise<ReplyModel | null> {
    const org = settings.get(space.orgId);
    const picked = await pickReplyModel(
      replyCandidates(
        own,
        { model: space.defaultModel, effort: space.defaultEffort },
        { model: org.defaultModel, effort: org.defaultEffort },
      ),
      (ref) => availability(space.orgId, ref),
    );
    if (picked?.used) return picked;
    // The org default gone too: the first model still on, in the list's order.
    const first = (await resolveModels(space.orgId)).models[0];
    if (!first) return picked;
    const used = { ref: first.ref, name: first.name, status: "ok" as const };
    return { chosen: picked?.chosen ?? used, used, effort: null };
  }

  // Throws unless the ref names a model the org can use right now.
  async function requireModel(orgId: string, ref: string) {
    const { models, errors } = await resolveModels(orgId);
    if (models.some((model) => model.ref === ref)) return;
    const unreadable = errors.length > 0 ? " Some connections could not be read." : "";
    throw new ServiceError(400, `${ref} is not a model this org can use.${unreadable}`);
  }

  // When the provider refuses the token before the reply begins, renews it once and asks again.
  async function* streamFrom(
    gateway: ModelGateway,
    orgId: string,
    connectionId: string,
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const token = (force: boolean) =>
      tokens.withFreshToken(orgId, connectionId, (fresh) => Promise.resolve(fresh), { force });
    let begun = false;
    try {
      for await (const event of gateway.stream(await token(false), request, signal)) {
        begun = true;
        yield event;
      }
    } catch (err) {
      if (begun || !(err instanceof ModelError) || err.kind !== "auth" || signal.aborted) throw err;
      logger.info({ connectionId }, "token refused; renewing it");
      yield* gateway.stream(await token(true), request, signal);
    }
  }

  // The models the host lists with these details, or why it refused them.
  async function checked(
    host: HostId,
    input: Pick<NewHostConnection, "settings" | "secrets">,
    proxy: ProviderProxy | null,
  ) {
    const { apiKey = "", ...secrets } = input.secrets;
    let list: CatalogModel[];
    try {
      list = await catalogs[host].list({
        access: apiKey,
        accountId: null,
        proxy,
        settings: input.settings,
        secrets,
      });
    } catch (err) {
      logger.info({ err, host }, "connection refused");
      const said = err instanceof Error && err.message ? ` (${err.message})` : "";
      throw new ConnectionError(400, `${hostOf(host).label} did not accept these details${said}.`);
    }
    if (list.length === 0) {
      throw new ConnectionError(400, `${hostOf(host).label} lists no models; give their ids.`);
    }
    return list;
  }

  return {
    resolveModels,
    requireModel,

    // Forgets the connection's list, as when where its requests go changed.
    invalidate(connectionId: string) {
      cache.delete(connectionId);
    },

    // Adds the connection once its host, or the proxy given for it, lists models with what it was
    // given, which become the connection's list.
    async add(owner: Owner, input: NewHostConnection): Promise<Connection> {
      const list = await checked(input.host, input, input.proxy ?? null);
      const connection = tokens.add(owner, input);
      cache.set(connection.id, { orgId: owner.orgId, at: now().getTime(), models: list });
      return connection;
    },

    // Changes the connection once its host, through its proxy, lists models with what it now
    // has, which become its list.
    async edit(owner: Owner, id: string, change: HostConnectionChange): Promise<Connection> {
      const { host } = connectionIn(owner.orgId, id);
      const proxy = await tokens.withFreshToken(owner.orgId, id, (token) =>
        Promise.resolve(token.proxy),
      );
      const list = await checked(host, change, proxy);
      const connection = tokens.edit(owner, id, change);
      cache.set(id, { orgId: owner.orgId, at: now().getTime(), models: list });
      return connection;
    },

    // The model a ref names, through the org's connection it names. Rejects with a model error
    // when the ref names no model or the org has no such connection. A model its live list says
    // can think is asked for the effort requested, or medium; others are asked for none.
    async open(orgId: string, ref: string): Promise<OpenModel> {
      const slash = ref.indexOf("/");
      const prefix = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      if (slash < 1 || !model) throw new ModelError("model", `${ref} is not a model ref.`);
      const connection = connectionOf(orgId, prefix);
      if (!connection) {
        const needs = isHost(prefix)
          ? `a ${HOSTS[prefix].label} connection`
          : "a connection that was removed";
        throw new ModelError("auth", `${ref} needs ${needs}. Add one in Model providers.`);
      }
      // A list that cannot be read leaves the model's reasoning unknown.
      const list = await listOf(orgId, connection, false).catch(() => []);
      const listed = withChoices(connection, list).find((m) => m.id === model);
      if (listed && !listed.enabled) throw new ModelTurnedOff(listed.name);
      const gateway = gateways[connection.host];
      return {
        ...(listed?.contextWindow && { contextWindow: listed.contextWindow }),
        stream: ({ effort, ...request }, signal) =>
          streamFrom(
            gateway,
            orgId,
            connection.id,
            { ...request, model, ...(listed?.reasoning && { effort: effort ?? "medium" }) },
            signal,
          ),
      };
    },

    connectionModels,
    availability,
    replyModel,

    // Turns models of the connection on or off, and sets whether new ones are turned on. The org's
    // default model stays on: asked alone, it is refused; among others, it is left on.
    // Threads and spaces keep a model turned off, and ask for another before they go on; spaces
    // that start threads on one are named.
    async setConnectionModels(
      orgId: string,
      id: string,
      change: { autoEnable?: boolean; set?: { ids: string[]; enabled: boolean } },
    ) {
      const connection = connectionIn(orgId, id);
      let affected: { id: string; name: string }[] = [];
      if (change.set) {
        let { ids } = change.set;
        const { enabled } = change.set;
        if (!enabled) {
          const isDefault = (modelId: string) =>
            modelRef(connection, modelId) === settings.get(orgId).defaultModel;
          const kept = ids.find(isDefault);
          if (kept && ids.length === 1) {
            const name =
              (await listOf(orgId, connection, false).catch(() => [])).find((m) => m.id === kept)
                ?.name ?? kept;
            throw new ServiceError(
              409,
              `${name} is the organization's default model. Choose another default first.`,
            );
          }
          ids = ids.filter((modelId) => !isDefault(modelId));
          const refs = ids.map((modelId) => modelRef(connection, modelId));
          affected = spaces.withDefaultModel(orgId, refs).map((s) => ({ id: s.id, name: s.name }));
        }
        choices.set(connection.id, ids, enabled, now());
      }
      if (change.autoEnable !== undefined) {
        connections.setAutoEnableModels(connection.id, change.autoEnable);
      }
      return { ...(await connectionModels(orgId, id)), spacesUsingOff: affected };
    },

    defaultModel(orgId: string): string | null {
      return settings.get(orgId).defaultModel;
    },

    async setDefaultModel(orgId: string, ref: string) {
      await requireModel(orgId, ref);
      settings.setDefaultModel(orgId, ref);
    },

    defaultEffort(orgId: string): Effort | null {
      return settings.get(orgId).defaultEffort;
    },

    // Null goes back to each model's usual effort.
    setDefaultEffort(orgId: string, effort: Effort | null) {
      settings.setDefaultEffort(orgId, effort);
    },

    // The org's models as lists show them, by ref: who makes each, the host and the connection it
    // comes through, null when the org has none such, and the name its last list gave it, else its
    // id. Reads the org's connections once and asks no host.
    shownModels(orgId: string): (ref: string) => ShownModel {
      const list = connections.list(orgId);
      return (ref) => {
        const slash = ref.indexOf("/");
        const prefix = ref.slice(0, slash);
        const id = ref.slice(slash + 1);
        const connection = namedBy(list, prefix);
        const listed = connection && cache.get(connection.id)?.models.find((m) => m.id === id);
        // A sign-in's ref names its host even after it is gone.
        const host = connection?.host ?? null;
        const hinted = host ?? (isHost(prefix) ? prefix : null);
        return {
          ref,
          name: listed?.name ?? id,
          maker: listed?.maker ?? makerOf(hinted && hostOf(hinted), id),
          host,
          connection: connection ? connectionLabel(connection) : null,
        };
      };
    },

    defaults(space: Pick<Space, "orgId" | "defaultModel" | "defaultEffort">): Defaults {
      return defaultsOf(space, settings.get(space.orgId));
    },

    // The org's title model, null when it chooses automatically.
    chosenTitleModel(orgId: string): string | null {
      return settings.get(orgId).titleModel;
    },

    // The title model for the first of the org's connections whose live list has it; null when
    // none does, and each thread is named with its own model.
    async automaticTitleModel(orgId: string): Promise<string | null> {
      const { models } = await resolveModels(orgId);
      for (const connection of connections.list(orgId)) {
        const title = hostOf(connection.host).titleModel;
        const ref = title && modelRef(connection, title);
        if (ref && models.some((model) => model.ref === ref)) return ref;
      }
      return null;
    },

    // Null chooses automatically again.
    async setTitleModel(orgId: string, ref: string | null) {
      if (ref) await requireModel(orgId, ref);
      settings.setTitleModel(orgId, ref);
    },
  };
}

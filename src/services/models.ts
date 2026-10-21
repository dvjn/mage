// The models an org can use: each of its connections' live lists, kept for an hour, merged under
// refs of the form `<auth kind>/<model id>`, the org's default model chosen from them, and opening
// a model to stream a reply from through its connection, and the model that names threads: the
// org's choice, or a small model of its first connection that has one.

import type { Catalog, CatalogModel } from "@/ports/catalog.ts";
import type { ConnectionStore } from "@/ports/connections.ts";
import type { Logger } from "@/ports/logger.ts";
import {
  ModelError,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
} from "@/ports/model-gateway.ts";
import type { OrgSettingStore } from "@/ports/org-settings.ts";
import { type AccountKind, ConnectionError, type Connections } from "@/services/connections.ts";
import { ServiceError } from "@/services/errors.ts";

export interface Model extends CatalogModel {
  ref: string;
  connectionId: string;
  authKind: AccountKind;
}

export interface ModelList {
  models: Model[];
  // Connections whose list could not be read this time.
  errors: { connectionId: string; message: string }[];
}

export interface ModelsOptions {
  connections: ConnectionStore;
  // Reads each connection's token, renewed when it is about to expire.
  tokens: Pick<Connections, "withFreshToken">;
  catalogs: Record<AccountKind, Catalog>;
  settings: OrgSettingStore;
  // Streams replies for the connections of each kind that can reply.
  gateways: Record<AccountKind, ModelGateway>;
  logger: Logger;
  now?: () => Date;
}

// A model ready to stream a reply from.
export interface OpenModel {
  stream(request: Omit<ModelRequest, "model">, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export type Models = ReturnType<typeof createModels>;

const CACHE_MS = 60 * 60 * 1000;

// The model each kind of connection names threads with, when its list has it.
const TITLE_MODELS: Record<AccountKind, string> = {
  codex: "gpt-6-luna",
  claude: "claude-haiku-5-5",
};

const LABELS: Record<AccountKind, string> = { codex: "Codex", claude: "Claude" };

export function modelRef(authKind: AccountKind, id: string) {
  return `${authKind}/${id}`;
}

function isAccountKind(value: string): value is AccountKind {
  return Object.hasOwn(LABELS, value);
}

export function createModels(options: ModelsOptions) {
  const { connections, tokens, catalogs, settings, gateways, logger } = options;
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, { at: number; models: CatalogModel[] }>();

  async function listOf(orgId: string, id: string, kind: AccountKind, refresh: boolean) {
    const cached = cache.get(id);
    if (!refresh && cached && now().getTime() - cached.at < CACHE_MS) return cached.models;
    try {
      const models = await tokens.withFreshToken(orgId, id, (token) => catalogs[kind].list(token));
      cache.set(id, { at: now().getTime(), models });
      return models;
    } catch (err) {
      if (err instanceof ConnectionError) throw err;
      logger.warn({ err, kind }, "model list failed");
      throw new Error(`Could not read the ${LABELS[kind]} models. Try again.`);
    }
  }

  // The one place that decides which models exist for an org.
  async function resolveModels(orgId: string, { refresh = false } = {}): Promise<ModelList> {
    const list = connections.list(orgId);
    const ids = new Set(list.map((c) => c.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);

    const results = await Promise.allSettled(
      list.map((c) => listOf(orgId, c.id, c.authKind, refresh)),
    );
    const result: ModelList = { models: [], errors: [] };
    results.forEach((settled, index) => {
      const { id: connectionId, authKind } = list[index]!;
      if (settled.status === "rejected") {
        const message = settled.reason instanceof Error ? settled.reason.message : "Failed";
        result.errors.push({ connectionId, message });
        return;
      }
      for (const model of settled.value) {
        result.models.push({ ...model, ref: modelRef(authKind, model.id), connectionId, authKind });
      }
    });
    return result;
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

  return {
    resolveModels,
    requireModel,

    // The model a ref names, through the org's connection of its kind. Rejects with a model error
    // when the ref names no model or the org has no such connection. A model its live list says
    // can think is asked for the effort requested, or medium; others are asked for none.
    async open(orgId: string, ref: string): Promise<OpenModel> {
      const slash = ref.indexOf("/");
      const kind = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      if (slash < 1 || !model || !isAccountKind(kind)) {
        throw new ModelError("model", `${ref} is not a model ref.`);
      }
      const connection = connections.list(orgId).find((c) => c.authKind === kind);
      if (!connection) {
        throw new ModelError(
          "auth",
          `${ref} needs a ${LABELS[kind]} connection. Connect one in Settings.`,
        );
      }
      // A list that cannot be read leaves the model's reasoning unknown.
      const list = await listOf(orgId, connection.id, kind, false).catch(() => []);
      const listed = list.find((m) => m.id === model);
      const gateway = gateways[kind];
      return {
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

    defaultModel(orgId: string): string | null {
      return settings.get(orgId).defaultModel;
    },

    async setDefaultModel(orgId: string, ref: string) {
      await requireModel(orgId, ref);
      settings.setDefaultModel(orgId, ref);
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
        const ref = modelRef(connection.authKind, TITLE_MODELS[connection.authKind]);
        if (models.some((model) => model.ref === ref)) return ref;
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

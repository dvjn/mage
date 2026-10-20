// The models an org can use: each of its connections' live lists, kept for an hour, merged under
// refs of the form `<auth kind>/<model id>`, and the org's default model chosen from them.

import type { Catalog, CatalogModel } from "@/ports/catalog.ts";
import type { ConnectionStore } from "@/ports/connections.ts";
import type { Logger } from "@/ports/logger.ts";
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
  logger: Logger;
  now?: () => Date;
}

export type Models = ReturnType<typeof createModels>;

const CACHE_MS = 60 * 60 * 1000;

const LABELS: Record<AccountKind, string> = { codex: "Codex", claude: "Claude" };

export function modelRef(authKind: AccountKind, id: string) {
  return `${authKind}/${id}`;
}

export function createModels(options: ModelsOptions) {
  const { connections, tokens, catalogs, settings, logger } = options;
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

  return {
    resolveModels,
    requireModel,

    defaultModel(orgId: string): string | null {
      return settings.get(orgId).defaultModel;
    },

    async setDefaultModel(orgId: string, ref: string) {
      await requireModel(orgId, ref);
      settings.setDefaultModel(orgId, ref);
    },
  };
}

// What Mage knows about hosts' models from the vendored model data: the models a host with no list
// serves, and the context window and thinking of models whose host's list leaves them out.

import data from "./data/models.json" with { type: "json" };
import type { HostId } from "@/shared/hosts.ts";
import type { ModelPricing } from "@/shared/model-pricing.ts";

import type { CatalogModel } from "./catalog.ts";

type Known = Partial<
  Record<
    HostId,
    Record<string, { contextWindow?: number; reasoning?: boolean; pricing?: ModelPricing }>
  >
>;

const known: Known = data;

export function pricingOf(host: HostId, id: string): ModelPricing | undefined {
  return known[host]?.[id]?.pricing;
}

// The host's models in the vendored data, named by their ids.
export function knownModels(host: HostId): CatalogModel[] {
  return Object.entries(known[host] ?? {}).map(([id, model]) => ({ id, name: id, ...model }));
}

// The model with what the vendored data adds where its list said nothing.
export function described(host: HostId, model: CatalogModel): CatalogModel {
  const extra = known[host]?.[model.id];
  if (!extra) return model;
  return {
    ...model,
    ...(!model.pricing && extra.pricing && { pricing: extra.pricing }),
    ...(model.contextWindow === undefined &&
      extra.contextWindow && {
        contextWindow: extra.contextWindow,
      }),
    ...(model.reasoning === undefined && extra.reasoning && { reasoning: true }),
  };
}

// The listed models, then the ids people typed that the list does not have, each described.
export function withTyped(host: HostId, listed: CatalogModel[], typed: string[]): CatalogModel[] {
  const ids = new Set(listed.map((model) => model.id));
  return [...listed, ...typed.filter((id) => !ids.has(id)).map((id) => ({ id, name: id }))].map(
    (model) => described(host, model),
  );
}

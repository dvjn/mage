// The models a provider account can use, read live from the provider.

import type { ProviderProxy } from "@/ports/model-gateway.ts";

export interface CatalogModel {
  id: string;
  name: string;
  // Input tokens the model takes, when the provider says.
  contextWindow?: number;
  // Whether the model can think before answering, when the provider says.
  reasoning?: boolean;
}

export interface CatalogToken {
  access: string;
  accountId: string | null;
  proxy?: ProviderProxy | null;
}

export interface Catalog {
  // Throws when the provider does not answer with a list.
  list(token: CatalogToken, signal?: AbortSignal): Promise<CatalogModel[]>;
}

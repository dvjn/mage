// The models a connection can use, read live from its host where it has a list, else from what
// Mage knows the host serves and the ids people typed.

import type { ModelToken } from "@/ports/model-gateway.ts";
import type { MakerId } from "@/shared/makers.ts";

export interface CatalogModel {
  id: string;
  name: string;
  // Input tokens the model takes, when the provider says.
  contextWindow?: number;
  // Whether the model can think before answering, when the provider says.
  reasoning?: boolean;
  // Who makes it, when the host says.
  maker?: MakerId | null;
}

export type CatalogToken = ModelToken;

export interface Catalog {
  // Throws when the provider does not answer with a list.
  list(token: CatalogToken, signal?: AbortSignal): Promise<CatalogModel[]>;
}

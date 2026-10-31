// Each host's model list and replies, by the API the host registry says it is reached through.

import {
  createBedrockCatalog,
  createBedrockGateway,
  createRoleCredentials,
} from "@/server/models/hosts/amazon-bedrock.ts";
import {
  createAnthropicKeyCatalog,
  createAnthropicKeyGateway,
} from "@/server/models/hosts/anthropic-api.ts";
import {
  createAzureCatalog,
  createAzureGateway,
  createEntraTokens,
} from "@/server/models/hosts/azure.ts";
import { createGeminiCatalog, createGeminiGateway } from "@/server/models/hosts/google-gemini.ts";
import { createVertexCatalog, createVertexGateway } from "@/server/models/hosts/google-vertex.ts";
import { createCodexCatalog, createCodexGateway } from "@/server/models/hosts/openai-codex.ts";
import {
  createOpenAIKeyCatalog,
  createOpenAIKeyGateway,
} from "@/server/models/hosts/openai-api.ts";
import {
  createCompatibleCatalog,
  createCompatibleGateway,
} from "@/server/models/hosts/openai-compatible.ts";
import { HOST_IDS, type HostId, hostOf } from "@/shared/hosts.ts";

import type { Catalog } from "./catalog.ts";
import type { ModelGateway } from "./gateway.ts";

export function createHostAdapters(fetchFn: typeof fetch = fetch) {
  const catalogs = {} as Record<HostId, Catalog>;
  const gateways = {} as Record<HostId, ModelGateway>;
  for (const host of HOST_IDS) {
    switch (hostOf(host).shape) {
      case "anthropic":
        catalogs[host] = createAnthropicKeyCatalog(fetchFn);
        gateways[host] = createAnthropicKeyGateway(fetchFn);
        break;
      case "openai":
        catalogs[host] = createOpenAIKeyCatalog(fetchFn);
        gateways[host] = createOpenAIKeyGateway(fetchFn);
        break;
      case "codex":
        catalogs[host] = createCodexCatalog(fetchFn);
        gateways[host] = createCodexGateway(fetchFn);
        break;
      case "openai-compatible":
        catalogs[host] = createCompatibleCatalog(host, fetchFn);
        gateways[host] = createCompatibleGateway(host, fetchFn);
        break;
      case "google":
        catalogs[host] = createGeminiCatalog(fetchFn);
        gateways[host] = createGeminiGateway(fetchFn);
        break;
      case "bedrock": {
        const roles = createRoleCredentials(fetchFn);
        catalogs[host] = createBedrockCatalog(fetchFn, roles);
        gateways[host] = createBedrockGateway(fetchFn, roles);
        break;
      }
      case "vertex":
        catalogs[host] = createVertexCatalog(fetchFn);
        gateways[host] = createVertexGateway(fetchFn);
        break;
      case "azure": {
        const tokens = createEntraTokens(fetchFn);
        catalogs[host] = createAzureCatalog(fetchFn, tokens);
        gateways[host] = createAzureGateway(fetchFn, tokens);
        break;
      }
    }
  }
  return { catalogs, gateways };
}

// Each host's model list and replies, by the API the host registry says it is reached through.

import {
  createBedrockCatalog,
  createBedrockGateway,
  createRoleCredentials,
} from "@/adapters/amazon-bedrock.ts";
import { createAnthropicKeyCatalog, createAnthropicKeyGateway } from "@/adapters/anthropic-api.ts";
import { createAzureCatalog, createAzureGateway, createEntraTokens } from "@/adapters/azure.ts";
import { createGeminiCatalog, createGeminiGateway } from "@/adapters/google-gemini.ts";
import { createVertexCatalog, createVertexGateway } from "@/adapters/google-vertex.ts";
import { createCodexCatalog, createCodexGateway } from "@/adapters/openai-codex.ts";
import { createOpenAIKeyCatalog, createOpenAIKeyGateway } from "@/adapters/openai-api.ts";
import { createCompatibleCatalog, createCompatibleGateway } from "@/adapters/openai-compatible.ts";
import type { Catalog } from "@/ports/catalog.ts";
import type { ModelGateway } from "@/ports/model-gateway.ts";
import { HOST_IDS, type HostId, hostOf } from "@/shared/hosts.ts";

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

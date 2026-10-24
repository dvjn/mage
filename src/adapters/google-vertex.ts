// Lists and replies with the models of Vertex AI. With a service account key, Gemini, Claude, Grok
// and the open models served as a service, in the connection's project and location; with an API
// key, express mode's Gemini models. Vertex has no list of the models a project may use, so the list
// is what Mage knows Vertex serves and the ids people typed; a service account is checked by getting
// a token with it. Replies stream with the AI SDK's Vertex providers, each model with the one for its
// maker. A connection's proxy takes the place of Vertex's address for replies, with its headers.

import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createVertexMaas } from "@ai-sdk/google-vertex/maas";
import { createGoogleVertexXai } from "@ai-sdk/google-vertex/xai";
import { importPKCS8, SignJWT } from "jose";
import * as z from "zod";

import { anthropicErrors } from "@/adapters/anthropic-api.ts";
import { streamReply } from "@/adapters/ai-sdk-stream.ts";
import { googleErrors } from "@/adapters/google-gemini.ts";
import { knownModels, withTyped } from "@/adapters/model-data.ts";
import type { Catalog } from "@/ports/catalog.ts";
import type { ModelGateway, ModelToken } from "@/ports/model-gateway.ts";
import { listOf } from "@/shared/hosts.ts";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const serviceAccountSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
  token_uri: z.url().optional(),
});

export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

// The connection's service account key, project and location; null for an express mode key.
export function vertexAccount(token: Pick<ModelToken, "settings" | "secrets">) {
  const json = token.secrets?.serviceAccount;
  if (!json) return null;
  const parsed = serviceAccountSchema.safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new Error("the service account key has no client email or private key");
  const account = parsed.data;
  const project = token.settings?.project || account.project_id;
  if (!project) throw new Error("the service account key names no project; give one");
  return { account, project, location: token.settings?.location || "global" };
}

// A token for the service account, by OAuth's JWT bearer grant, which proves the key works.
export async function serviceAccountToken(account: ServiceAccount, fetchFn: typeof fetch = fetch) {
  const audience = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(await importPKCS8(account.private_key, "RS256"));
  const res = await fetchFn(audience, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`the service account was refused with status ${res.status}`);
}

// Express mode serves Gemini only.
const GEMINI = /^(gemini|gemma)/;

export function createVertexCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return {
    async list(token) {
      const vertex = vertexAccount(token);
      if (vertex) await serviceAccountToken(vertex.account, fetchFn);
      const known = knownModels("vertex").filter((model) => vertex || GEMINI.test(model.id));
      return withTyped("vertex", known, listOf(token.settings?.models));
    },
  };
}

// The model through the Vertex provider for its maker: Claude through Anthropic's, Grok through
// xAI's, Gemini through Google's, and the rest as open models served as a service.
function modelOf(token: ModelToken, modelId: string, fetchFn: typeof fetch) {
  const vertex = vertexAccount(token);
  const common = {
    ...(token.proxy?.baseUrl && { baseURL: token.proxy.baseUrl }),
    headers: { ...token.proxy?.headers },
    fetch: fetchFn,
  };
  if (!vertex) {
    // Without a key the provider falls back to one from the environment.
    if (!token.access) throw new Error("the connection has no API key");
    return {
      model: createVertex({ apiKey: token.access, ...common })(modelId),
      errors: googleErrors,
    };
  }
  const options = {
    project: vertex.project,
    location: vertex.location,
    googleAuthOptions: { credentials: vertex.account, scopes: [SCOPE] },
    ...common,
  };
  if (modelId.startsWith("claude")) {
    return { model: createVertexAnthropic(options)(modelId), errors: anthropicErrors };
  }
  if (modelId.startsWith("xai/")) {
    return { model: createGoogleVertexXai(options)(modelId), errors: googleErrors };
  }
  if (GEMINI.test(modelId)) return { model: createVertex(options)(modelId), errors: googleErrors };
  return { model: createVertexMaas(options)(modelId), errors: googleErrors };
}

// Replies through Vertex AI, the instructions as the system prompt. A model that can think does so
// at the effort asked for.
export function createVertexGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      const { model, errors } = modelOf(token, request.model, fetchFn);
      yield* streamReply(model, request, signal, {
        system: request.instructions,
        ...(request.effort && { reasoning: request.effort }),
        errors,
      });
    },
  };
}

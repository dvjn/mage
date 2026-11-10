// Lists and replies with the models of Vertex AI. With a service account key, Gemini, Claude, Grok
// and the open models served as a service, in the connection's project and location; with an API
// key, express mode's Gemini models. Service accounts list Model Garden's publisher models live;
// express mode uses the vendored Gemini list. Neither proves a project's access to every model.
// The vendored data adds context windows and thinking; typed ids extend either list.
// Replies stream with the AI SDK's Vertex providers, each model with the one for its
// maker. A connection's proxy takes the place of Vertex's address for replies, with its headers.

import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createVertexMaas } from "@ai-sdk/google-vertex/maas";
import { createGoogleVertexXai } from "@ai-sdk/google-vertex/xai";
import { importPKCS8, SignJWT } from "jose";
import * as z from "zod";

import { knownModels, withTyped } from "@/server/models/model-data.ts";
import type { Catalog, CatalogModel } from "@/server/models/catalog.ts";
import type { ModelGateway, ModelToken } from "@/server/models/gateway.ts";
import { listOf } from "@/shared/hosts.ts";

import { anthropicErrors, anthropicReply } from "./anthropic-api.ts";
import { streamReply } from "./ai-sdk-stream.ts";
import { googleErrors } from "./google-gemini.ts";

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
export async function serviceAccountToken(
  account: ServiceAccount,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
) {
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
    signal,
  });
  if (!res.ok) throw new Error(`the service account was refused with status ${res.status}`);
  const body = z.object({ access_token: z.string().min(1) }).safeParse(await res.json());
  if (!body.success) throw new Error("the service account response has no access token");
  return body.data.access_token;
}

// Express mode serves Gemini only.
const GEMINI = /^(gemini|gemma)/;

const publisherModelsSchema = z.object({
  publisherModels: z
    .array(
      z.object({
        name: z.string().min(1),
        publisherModelTemplate: z.string().optional(),
        launchStage: z.string().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().nullish(),
});

// The publishers routed by modelOf. Model Garden also lists models that need deployment and
// non-chat models; only Gemini, Claude and the partner models served as a service belong here.
const PUBLISHERS = [
  "google",
  "anthropic",
  "mistralai",
  "meta",
  "deepseek-ai",
  "openai",
  "xai",
  "zai-org",
];

function publisherModel(
  publisher: string,
  model: z.infer<typeof publisherModelsSchema>["publisherModels"][number],
): CatalogModel | null {
  const prefix = `publishers/${publisher}/models/`;
  if (!model.name.startsWith(prefix)) return null;
  const name = model.name.slice(prefix.length);
  if (!name || name.includes("/")) return null;
  if (model.launchStage === "EXPERIMENTAL" || model.launchStage === "PRIVATE_PREVIEW") return null;
  if (publisher === "google" && name.startsWith("gemini-")) {
    if (/(?:^|-)(?:embedding|image|tts|live)(?:-|$)/.test(name)) return null;
    return { id: name, name };
  }
  if (publisher === "anthropic" && name.startsWith("claude-")) return { id: name, name };
  // MaaS ids carry their publisher, even when Model Garden's resource name is unqualified.
  const maas = name.includes("-maas");
  const partner =
    (publisher === "mistralai" &&
      /^(mistral|codestral|ministral|pixtral|magistral|devstral)/.test(name)) ||
    (publisher === "xai" && name.startsWith("grok-"));
  if (!maas && !(partner && model.publisherModelTemplate)) return null;
  if (publisher === "google" && !name.startsWith("gemma-")) return null;
  const id = `${publisher}/${name}`;
  return { id, name: id };
}

export function createVertexCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return {
    async list(token, signal) {
      const vertex = vertexAccount(token);
      if (!vertex) {
        return withTyped(
          "vertex",
          knownModels("vertex").filter((model) => GEMINI.test(model.id)),
          listOf(token.settings?.models),
        );
      }
      const access = await serviceAccountToken(vertex.account, fetchFn, signal);
      // Model Garden is regional even when inference uses the global endpoint.
      const region = vertex.location === "global" ? "us-central1" : vertex.location;
      const base = `https://${region}-aiplatform.googleapis.com/v1beta1/publishers`;
      const lists = await Promise.all(
        PUBLISHERS.map(async (publisher) => {
          const models: CatalogModel[] = [];
          let next: string | null | undefined;
          do {
            const query = new URLSearchParams({
              pageSize: "100",
              view: "PUBLISHER_MODEL_VIEW_FULL",
              listAllVersions: "true",
              ...(next && { pageToken: next }),
            });
            const res = await fetchFn(`${base}/${publisher}/models?${query.toString()}`, {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${access}`,
                "x-goog-user-project": vertex.project,
              },
              signal,
            });
            // A publisher may not have a catalog in this region.
            if (res.status === 404 && !next) break;
            if (!res.ok)
              throw new Error(`model list for ${publisher} failed with status ${res.status}`);
            const body = publisherModelsSchema.safeParse(await res.json().catch(() => null));
            if (!body.success) throw new Error("model list response is not a list");
            for (const entry of body.data.publisherModels) {
              const model = publisherModel(publisher, entry);
              if (model) models.push(model);
            }
            next = body.data.nextPageToken;
          } while (next);
          return models;
        }),
      );
      const models = [...new Map(lists.flat().map((model) => [model.id, model])).values()];
      return withTyped("vertex", models, listOf(token.settings?.models));
    },
  };
}

// The model through the Vertex provider for its maker: Claude through Anthropic's, Grok through
// xAI's, Gemini through Google's, and the rest as open models served as a service. Claude caches a
// prompt only up to the breakpoints it is marked with, and takes the thread's changes
// mid-conversation as on Anthropic's API; Gemini caches by itself.
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
    return {
      model: createVertexAnthropic(options)(modelId),
      errors: anthropicErrors,
      claude: true,
    };
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
      const { model, errors, claude } = modelOf(token, request.model, fetchFn);
      if (claude) {
        yield* anthropicReply(model, request, signal, {
          system: request.instructions,
          errors,
          platform: "vertex",
        });
        return;
      }
      yield* streamReply(model, request, signal, {
        system: request.instructions,
        ...(request.effort && { reasoning: request.effort }),
        errors,
      });
    },
  };
}

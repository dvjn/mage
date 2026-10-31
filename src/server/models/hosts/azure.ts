// Lists and replies with the deployments of an Azure OpenAI or Microsoft Foundry resource. Azure
// lists models rather than a resource's deployments, so the list is the deployment names people
// typed, and the resource's model list only checks the key or the app. A connection reaches it with
// the resource's key or a Microsoft Entra app's client secret, whose tokens are kept until shortly
// before they expire. Replies stream with the AI SDK's Azure provider, through the Responses API for
// OpenAI's models and Chat Completions for the rest, and Claude deployments through the resource's
// Anthropic endpoint. A connection's proxy takes the place of the resource's address, with its
// headers added.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import * as z from "zod";

import { withTyped } from "@/server/models/model-data.ts";
import type { Catalog } from "@/server/models/catalog.ts";
import type { ModelGateway, ModelToken } from "@/server/models/gateway.ts";
import { hostOf, listOf } from "@/shared/hosts.ts";
import { makerOf } from "@/shared/makers.ts";

import { anthropicErrors } from "./anthropic-api.ts";
import { streamReply } from "./ai-sdk-stream.ts";
import { openaiErrors } from "./openai-api.ts";

const SCOPE = "https://cognitiveservices.azure.com/.default";
// Tokens are renewed this long before they expire.
const RENEW_MS = 5 * 60 * 1000;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number() });

// Gets Entra tokens for apps by their client secret, keeping each until shortly before it expires.
export function createEntraTokens(fetchFn: typeof fetch = fetch, now = () => Date.now()) {
  const kept = new Map<string, { until: number; token: string }>();
  return async function tokenFor(app: { tenantId: string; clientId: string; secret: string }) {
    const key = `${app.tenantId}\n${app.clientId}\n${app.secret}`;
    const found = kept.get(key);
    if (found && found.until > now()) return found.token;
    const res = await fetchFn(
      `https://login.microsoftonline.com/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: app.clientId,
          client_secret: app.secret,
          scope: SCOPE,
        }),
      },
    );
    if (!res.ok) throw new Error(`Microsoft Entra refused the app with status ${res.status}`);
    const body = tokenSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new Error("Microsoft Entra gave no token");
    kept.set(key, {
      until: now() + body.data.expires_in * 1000 - RENEW_MS,
      token: body.data.access_token,
    });
    return body.data.access_token;
  };
}

type Tokens = ReturnType<typeof createEntraTokens>;

// The resource's address, and how requests prove themselves: its key, or an Entra token.
async function accessOf(token: ModelToken, tokens: Tokens) {
  const settings = token.settings ?? {};
  const endpoint = (token.proxy?.baseUrl ?? settings.endpoint ?? "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("the connection has no endpoint");
  if (token.access) return { endpoint, apiKey: token.access };
  const secret = token.secrets?.clientSecret;
  if (!settings.tenantId || !settings.clientId || !secret) {
    throw new Error("the connection has no key or app");
  }
  return {
    endpoint,
    bearer: await tokens({ tenantId: settings.tenantId, clientId: settings.clientId, secret }),
  };
}

export function createAzureCatalog(fetchFn: typeof fetch = fetch, entra?: Tokens): Catalog {
  const tokens = entra ?? createEntraTokens(fetchFn);
  return {
    async list(token, signal) {
      const access = await accessOf(token, tokens);
      const res = await fetchFn(`${access.endpoint}/openai/v1/models`, {
        headers: {
          Accept: "application/json",
          ...(access.apiKey
            ? { "api-key": access.apiKey }
            : { Authorization: `Bearer ${access.bearer}` }),
          ...token.proxy?.headers,
        },
        signal,
      });
      // Only a refusal says the key or app is wrong; a Foundry resource may list nothing here.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`model list failed with status ${res.status}`);
      }
      return withTyped("azure", [], listOf(token.settings?.models));
    },
  };
}

// Replies through the resource, the instructions as the system prompt. A model that can think does
// so at the effort asked for.
export function createAzureGateway(fetchFn: typeof fetch = fetch, entra?: Tokens): ModelGateway {
  const tokens = entra ?? createEntraTokens(fetchFn);
  return {
    async *stream(token, request, signal) {
      const access = await accessOf(token, tokens);
      const headers = { ...token.proxy?.headers };
      const reasoning = request.effort && { reasoning: request.effort };
      const maker = makerOf(hostOf("azure"), request.model);
      if (maker === "anthropic") {
        const provider = createAnthropic({
          baseURL: `${access.endpoint}/anthropic/v1`,
          ...(access.apiKey ? { apiKey: access.apiKey } : { authToken: access.bearer }),
          headers,
          fetch: fetchFn,
        });
        yield* streamReply(provider.messages(request.model), request, signal, {
          system: request.instructions,
          ...reasoning,
          errors: anthropicErrors,
        });
        return;
      }
      const provider = createAzure({
        baseURL: `${access.endpoint}/openai`,
        ...(access.apiKey
          ? { apiKey: access.apiKey }
          : { tokenProvider: () => tokens(appOf(token)) }),
        headers,
        fetch: fetchFn,
      });
      yield* streamReply(
        maker === "openai" ? provider.responses(request.model) : provider.chat(request.model),
        request,
        signal,
        { system: request.instructions, ...reasoning, errors: openaiErrors },
      );
    },
  };
}

function appOf(token: ModelToken) {
  return {
    tenantId: token.settings?.tenantId ?? "",
    clientId: token.settings?.clientId ?? "",
    secret: token.secrets?.clientSecret ?? "",
  };
}

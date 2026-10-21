// Signs in to a Claude account with Claude Code's OAuth client: a browser authorization that ends
// on a page showing a code the user pastes back, and token refresh. Lists the models the account
// can use from the Anthropic API, and streams replies from it with the AI SDK's Anthropic provider.
// A connection's proxy takes the place of the API for both, with its headers added.

import { createHash, randomBytes } from "node:crypto";

import { createAnthropic } from "@ai-sdk/anthropic";
import * as z from "zod";

import { type ProviderErrors, streamReply } from "@/adapters/ai-sdk-stream.ts";
import type { Catalog } from "@/ports/catalog.ts";
import type { ModelGateway } from "@/ports/model-gateway.ts";
import type { BrowserOAuth, OAuthTokens } from "@/ports/oauth.ts";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Shows the code and state to copy instead of redirecting to a local server.
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const API_URL = "https://api.anthropic.com/v1";
// Marks the request as using an OAuth token and names Mage as the client.
const OAUTH_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
  "user-agent": "mage",
};

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      max_input_tokens: z.number().int().positive().nullish(),
      capabilities: z
        .object({ thinking: z.object({ supported: z.boolean() }).nullish() })
        .nullish(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
  account: z
    .object({ uuid: z.string().optional(), email_address: z.string().optional() })
    .optional(),
});

function randomValue() {
  return randomBytes(32).toString("base64url");
}

export function createClaudeOAuth(fetchFn: typeof fetch = fetch): BrowserOAuth {
  async function postToken(body: Record<string, string>, signal?: AbortSignal) {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
      signal,
    });
    if (!res.ok) throw new Error(`token ${body.grant_type} failed with status ${res.status}`);
    const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error(`token ${body.grant_type} response is incomplete`);
    const { data } = parsed;
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expiresIn: data.expires_in,
      accountId: data.account?.uuid ?? null,
      email: data.account?.email_address ?? null,
      plan: null,
    } satisfies OAuthTokens;
  }

  return {
    authorize() {
      const state = randomValue();
      const codeVerifier = randomValue();
      const params = new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      });
      // Spaces as %20 rather than +.
      const query = params.toString().replaceAll("+", "%20");
      return { state, codeVerifier, authorizeUrl: `${AUTHORIZE_URL}?${query}` };
    },

    exchange({ code, codeVerifier, state }, signal) {
      return postToken(
        {
          grant_type: "authorization_code",
          code,
          state,
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier,
        },
        signal,
      );
    },

    refresh(refreshToken) {
      return postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    },
  };
}

export function createClaudeCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return {
    async list(token, signal) {
      const models: z.infer<typeof modelsSchema>["data"] = [];
      let after: string | null | undefined;
      do {
        const query = new URLSearchParams({ limit: "1000", ...(after && { after_id: after }) });
        const res = await fetchFn(`${token.proxy?.baseUrl ?? API_URL}/models?${query.toString()}`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token.access}`,
            ...OAUTH_HEADERS,
            ...token.proxy?.headers,
          },
          signal,
        });
        if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
        const body = modelsSchema.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new Error("model list response is not a list");
        models.push(...body.data.data);
        after = body.data.has_more ? body.data.last_id : null;
      } while (after);
      return models.map((model) => ({
        id: model.id,
        name: model.display_name,
        ...(model.max_input_tokens && { contextWindow: model.max_input_tokens }),
        ...(model.capabilities?.thinking && { reasoning: model.capabilities.thinking.supported }),
      }));
    },
  };
}

// A rate limit reset as epoch seconds or an RFC 3339 time.
function instant(value: string | undefined) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? new Date(seconds * 1000) : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

// The Anthropic API explains its limits in `anthropic-ratelimit-*` headers: for a Claude account,
// the unified status and reset of the account's windows (five hours, seven days) and of extra
// usage, and why extra usage is off; for others, per-minute request and token limits.
export const claudeErrors: ProviderErrors = {
  explains: (name) => name.startsWith("anthropic-ratelimit-") || name === "request-id",
  resetsAt(headers) {
    const unified = instant(headers["anthropic-ratelimit-unified-reset"]);
    if (unified) return unified;
    const windows = Object.keys(headers)
      .filter((name) => /^anthropic-ratelimit-unified-.+-status$/.test(name))
      .filter((name) => headers[name] === "rejected")
      .map((name) => instant(headers[name.replace(/-status$/, "-reset")]))
      .filter((at): at is Date => at !== null)
      .toSorted((a, b) => a.getTime() - b.getTime());
    if (windows[0]) return windows[0];
    const minute = ["requests", "tokens", "input-tokens", "output-tokens"]
      .filter((limit) => headers[`anthropic-ratelimit-${limit}-remaining`] === "0")
      .map((limit) => instant(headers[`anthropic-ratelimit-${limit}-reset`]))
      .filter((at): at is Date => at !== null)
      .toSorted((a, b) => b.getTime() - a.getTime());
    return minute[0] ?? null;
  },
};

// Replies through the Anthropic Messages API with the account's OAuth token as a bearer token, the
// instructions as the system prompt. A model that can think does so at the effort asked for, and
// streams its thinking.
export function createClaudeGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      // Without a token the provider falls back to an API key from the environment.
      if (!token.access) throw new Error("the connection has no access token");
      const provider = createAnthropic({
        baseURL: token.proxy?.baseUrl ?? API_URL,
        authToken: token.access,
        headers: { ...OAUTH_HEADERS, ...token.proxy?.headers },
        fetch: fetchFn,
      });
      yield* streamReply(provider.messages(request.model), request, signal, {
        system: request.instructions,
        // Adaptive thinking at that effort, or a thinking budget for models without it.
        ...(request.effort && { reasoning: request.effort }),
        errors: claudeErrors,
      });
    },
  };
}

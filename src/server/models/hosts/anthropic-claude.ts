// Signs in to a Claude account with Claude Code's OAuth client: an authorization at Claude that
// ends on a page showing a code the person pastes back, and token refresh. Lists the models the
// account can use from the Anthropic API, and streams replies from it as the API key host does,
// with the account's token and the identity Claude Code sends. A connection's proxy takes the place
// of the API for both, with its headers added.

import { createHash, randomBytes } from "node:crypto";

import { createAnthropic } from "@ai-sdk/anthropic";
import * as z from "zod";

import type { Catalog } from "@/server/models/catalog.ts";
import type { ModelGateway } from "@/server/models/gateway.ts";
import type { CodeOAuth, OAuthTokens } from "@/server/models/oauth.ts";

import type { ProviderErrors } from "./ai-sdk-stream.ts";
import {
  API_URL,
  anthropicCatalog,
  anthropicErrors,
  anthropicReply,
  instant,
} from "./anthropic-api.ts";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's page for signing in without a local server: it shows the code and state to copy.
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
// The Claude Code release whose identity requests carry.
const CLAUDE_CODE_VERSION = "2.1.308";
// What the API takes an account's token with: the OAuth and Claude Code betas, and Claude Code's
// client headers.
const CLAUDE_HEADERS = {
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
  "x-app": "cli",
};
// The system prompt's first block, on its own, for requests with an account's token.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

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

export function createClaudeOAuth(fetchFn: typeof fetch = fetch): CodeOAuth {
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
      return { state, codeVerifier, authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}` };
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

function authHeaders(access: string) {
  return { Authorization: `Bearer ${access}`, ...CLAUDE_HEADERS };
}

export function createClaudeCatalog(fetchFn: typeof fetch = fetch): Catalog {
  return anthropicCatalog(fetchFn, authHeaders);
}

// For a Claude account the API also names the unified status and reset of the account's windows
// and of extra usage in `anthropic-ratelimit-unified-*` headers.
export const claudeErrors: ProviderErrors = {
  explains: (name) => anthropicErrors.explains(name),
  resetsAt(headers, body, now) {
    const unified = instant(headers["anthropic-ratelimit-unified-reset"]);
    if (unified) return unified;
    const windows = Object.keys(headers)
      .filter((name) => /^anthropic-ratelimit-unified-.+-status$/.test(name))
      .filter((name) => headers[name] === "rejected")
      .map((name) => instant(headers[name.replace(/-status$/, "-reset")]))
      .filter((at): at is Date => at !== null)
      .toSorted((a, b) => a.getTime() - b.getTime());
    return windows[0] ?? anthropicErrors.resetsAt?.(headers, body, now) ?? null;
  },
};

// Replies through the Anthropic Messages API with the account's token as a bearer token, the
// identity first in the system prompt and the instructions after it.
export function createClaudeGateway(fetchFn: typeof fetch = fetch): ModelGateway {
  return {
    async *stream(token, request, signal) {
      // Without a token the provider falls back to an API key from the environment.
      if (!token.access) throw new Error("the connection has no access token");
      const provider = createAnthropic({
        baseURL: token.proxy?.baseUrl ?? API_URL,
        authToken: token.access,
        headers: { ...CLAUDE_HEADERS, ...token.proxy?.headers },
        fetch: fetchFn,
      });
      yield* anthropicReply(provider.messages(request.model), request, signal, {
        system: [
          { role: "system", content: IDENTITY },
          { role: "system", content: request.instructions },
        ],
        errors: claudeErrors,
        platform: "anthropic",
      });
    },
  };
}

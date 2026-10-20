// Signs in to a Claude account with Claude Code's OAuth client: a browser authorization that ends
// on a page showing a code the user pastes back, and token refresh.

import { createHash, randomBytes } from "node:crypto";

import * as z from "zod";

import type { BrowserOAuth, OAuthTokens } from "@/ports/oauth.ts";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Shows the code and state to copy instead of redirecting to a local server.
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

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

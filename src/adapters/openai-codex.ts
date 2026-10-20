// Signs in to a ChatGPT account with the Codex CLI's OAuth client: a device code, or a browser
// authorization whose callback the user pastes back, and token refresh.

import { createHash, randomBytes } from "node:crypto";

import { decodeJwt } from "jose";
import * as z from "zod";

import type { BrowserOAuth, DeviceOAuth, OAuthTokens } from "@/ports/oauth.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const SCOPES = "openid profile email offline_access";
const ORIGINATOR = "mage";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
  id_token: z.string().optional(),
});

const userCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.coerce.number().nonnegative(),
});

const deviceApprovalSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

const deviceErrorSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional(),
});

const authClaimSchema = z.object({
  chatgpt_account_id: z.string().min(1).optional(),
  chatgpt_plan_type: z.string().min(1).optional(),
});

const claimsSchema = z.object({
  email: z.string().optional(),
  [AUTH_CLAIM]: authClaimSchema.optional(),
  [PROFILE_CLAIM]: z.object({ email: z.string().optional() }).optional(),
});

// Reads claims without checking the signature: OpenAI has just issued the token to us over TLS.
function claimsOf(token: string | undefined) {
  if (!token) return {};
  try {
    const parsed = claimsSchema.safeParse(decodeJwt(token));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function tokensFrom(body: z.infer<typeof tokenResponseSchema>): OAuthTokens {
  const access = claimsOf(body.access_token);
  const id = claimsOf(body.id_token);
  const accountId = access[AUTH_CLAIM]?.chatgpt_account_id;
  if (!accountId) throw new Error("access token has no ChatGPT account id");
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresIn: body.expires_in,
    accountId,
    email: id.email ?? access[PROFILE_CLAIM]?.email ?? null,
    plan: id[AUTH_CLAIM]?.chatgpt_plan_type ?? access[AUTH_CLAIM]?.chatgpt_plan_type ?? null,
  };
}

function randomValue() {
  return randomBytes(32).toString("base64url");
}

export function createCodexOAuth(fetchFn: typeof fetch = fetch): BrowserOAuth & DeviceOAuth {
  async function postForm(params: Record<string, string>, signal?: AbortSignal) {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
      signal,
    });
    if (!res.ok) throw new Error(`token ${params.grant_type} failed with status ${res.status}`);
    const body = tokenResponseSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new Error(`token ${params.grant_type} response is incomplete`);
    return tokensFrom(body.data);
  }

  function postJson(url: string, body: object, signal?: AbortSignal) {
    return fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  return {
    authorize() {
      const state = randomValue();
      const codeVerifier = randomValue();
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: ORIGINATOR,
      });
      // Spaces as %20 rather than +.
      const query = params.toString().replaceAll("+", "%20");
      return { state, codeVerifier, authorizeUrl: `${AUTHORIZE_URL}?${query}` };
    },

    exchange({ code, codeVerifier }, signal) {
      return postForm(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: REDIRECT_URI,
        },
        signal,
      );
    },

    refresh(refreshToken) {
      return postForm({ grant_type: "refresh_token", refresh_token: refreshToken });
    },

    async startDevice(signal) {
      const res = await postJson(DEVICE_USER_CODE_URL, { client_id: CLIENT_ID }, signal);
      if (!res.ok) throw new Error(`device code request failed with status ${res.status}`);
      const body = userCodeSchema.safeParse(await res.json().catch(() => null));
      if (!body.success) throw new Error("device code response is incomplete");
      return {
        deviceAuthId: body.data.device_auth_id,
        userCode: body.data.user_code,
        verificationUrl: DEVICE_VERIFICATION_URL,
        intervalSeconds: body.data.interval,
      };
    },

    async pollDevice(device, signal) {
      const res = await postJson(
        DEVICE_TOKEN_URL,
        { device_auth_id: device.deviceAuthId, user_code: device.userCode },
        signal,
      );
      if (res.ok) {
        const body = deviceApprovalSchema.safeParse(await res.json().catch(() => null));
        if (!body.success) throw new Error("device approval response is incomplete");
        return {
          status: "approved",
          code: body.data.authorization_code,
          codeVerifier: body.data.code_verifier,
        };
      }
      // Not approved yet.
      if (res.status === 403 || res.status === 404) return { status: "pending" };
      const body = deviceErrorSchema.safeParse(await res.json().catch(() => null));
      const error = body.success ? body.data.error : undefined;
      const code = typeof error === "object" ? error.code : error;
      if (code === "deviceauth_authorization_pending") return { status: "pending" };
      if (code === "slow_down") return { status: "slow_down" };
      throw new Error(`device sign-in failed with status ${res.status}${code ? `: ${code}` : ""}`);
    },

    exchangeDevice({ code, codeVerifier }, signal) {
      return postForm(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        },
        signal,
      );
    },
  };
}

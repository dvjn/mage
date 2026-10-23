// A stand-in OpenID Connect provider for the browser journeys. It serves discovery, its signing key,
// a sign-in form where the journey types who signs in, the code exchange (checking the client, the
// redirect and PKCE) and the user's claims. Each code works once, so journeys running side by side
// never see each other's people.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const port = Number(process.env.PORT ?? "4794");
const issuer = `http://localhost:${port}`;
const clientId = process.env.CLIENT_ID ?? "";
const clientSecret = process.env.CLIENT_SECRET ?? "";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const keyId = randomUUID();
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" }] };

interface Claims {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Grant {
  claims: Claims;
  nonce?: string;
  redirectUri: string;
  codeChallenge: string;
}

const grants = new Map<string, Grant>();
const accessTokens = new Map<string, Claims>();

// The same subject for the same email, as an identity provider keeps it.
function subjectOf(email: string) {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 24);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function formOf(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Asks who signs in, carrying the authorization request along.
function signInPage(res: ServerResponse, params: URLSearchParams) {
  const carried = ["redirect_uri", "state", "nonce", "code_challenge"]
    .map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name) ?? "")}">`)
    .join("");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<title>Test IdP</title>
<h1>Test IdP</h1>
<form method="post" action="/authorize">
  ${carried}
  <label>Email <input name="email" type="email" required></label>
  <label>Name <input name="name" required></label>
  <button type="submit">Sign in</button>
</form>`);
}

async function authorize(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET") {
    const params = url.searchParams;
    if (params.get("client_id") !== clientId || params.get("response_type") !== "code") {
      return json(res, 400, { error: "invalid_request" });
    }
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      return json(res, 400, { error: "invalid_request", error_description: "PKCE is required" });
    }
    return signInPage(res, params);
  }
  const form = await formOf(req);
  const email = form.get("email") ?? "";
  const code = randomBytes(24).toString("base64url");
  const nonce = form.get("nonce");
  grants.set(code, {
    claims: { sub: subjectOf(email), email, email_verified: true, name: form.get("name") ?? "" },
    ...(nonce && { nonce }),
    redirectUri: form.get("redirect_uri") ?? "",
    codeChallenge: form.get("code_challenge") ?? "",
  });
  const back = new URL(form.get("redirect_uri") ?? "");
  back.searchParams.set("code", code);
  back.searchParams.set("state", form.get("state") ?? "");
  res.writeHead(302, { Location: back.toString() });
  res.end();
}

// The client's credentials, from Basic auth or the form.
function clientOf(req: IncomingMessage, form: URLSearchParams) {
  const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
  if (basic) {
    const [id = "", secret = ""] = Buffer.from(basic, "base64").toString().split(":");
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
}

async function token(req: IncomingMessage, res: ServerResponse) {
  const form = await formOf(req);
  const client = clientOf(req, form);
  if (client.id !== clientId || client.secret !== clientSecret) {
    return json(res, 401, { error: "invalid_client" });
  }
  const code = form.get("code") ?? "";
  const grant = grants.get(code);
  grants.delete(code);
  const challenge = createHash("sha256")
    .update(form.get("code_verifier") ?? "")
    .digest("base64url");
  if (
    !grant ||
    form.get("grant_type") !== "authorization_code" ||
    form.get("redirect_uri") !== grant.redirectUri ||
    challenge !== grant.codeChallenge
  ) {
    return json(res, 400, { error: "invalid_grant" });
  }
  const accessToken = randomBytes(24).toString("base64url");
  accessTokens.set(accessToken, grant.claims);
  const idToken = await new SignJWT({ ...grant.claims, ...(grant.nonce && { nonce: grant.nonce }) })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 300,
    id_token: idToken,
    scope: "openid email profile",
  });
}

function userinfo(req: IncomingMessage, res: ServerResponse) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const claims = accessTokens.get(bearer);
  if (!claims) return json(res, 401, { error: "invalid_token" });
  json(res, 200, claims);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const respond = async () => {
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "email", "profile"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      case "/jwks":
        return json(res, 200, jwks);
      case "/authorize":
        return authorize(req, res, url);
      case "/token":
        return req.method === "POST" ? token(req, res) : json(res, 405, {});
      case "/userinfo":
        return userinfo(req, res);
      default:
        return json(res, 404, { error: "not_found" });
    }
  };
  respond().catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "server_error" });
  });
});

server.listen(port, () => console.log(`stand-in OIDC issuer on ${issuer}`));

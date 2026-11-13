// A stand-in OpenID Connect provider that signs in whoever is picked, with no password. Its sign-in
// page lists the people it is given; picking one, or naming them in `login_as`, signs them in with
// the authorization code flow and PKCE. Told to take anyone, it signs in whatever email `login_as`
// names, as `name`, so browser journeys running side by side each sign in someone of their own.
// The same email always has the same subject. It serves discovery, its signing key, the code
// exchange (checking the client, the redirect and PKCE) and the user's claims. Each code works once.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface Person {
  email: string;
  name: string;
}

export interface IdentityOptions {
  // Where the browser and Mage reach it.
  issuer: string;
  // The page's title.
  title?: string;
  // Each client by its id and secret, and the redirect addresses it takes, as a pattern.
  clients: { id: string; secret: string; redirect: string }[];
  people?: Person[];
  // Whether it signs in an email it was not given.
  anyone?: boolean;
}

interface Claims {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Grant {
  clientId: string;
  claims: Claims;
  nonce: string | null;
  redirectUri: string;
  codeChallenge: string;
  expires: number;
}

// The same subject for the same email, as an identity provider keeps it.
export function subjectOf(email: string) {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 24);
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function chooser(title: string, choices: { name: string; email: string; href: string }[]) {
  const links = choices
    .map(
      (choice) =>
        `<a href="${escape(choice.href)}">${escape(choice.name)}<small>${escape(choice.email)}</small></a>`,
    )
    .join("\n  ");
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { width: min(22rem, 100% - 2rem); }
  h1 { font-size: 1.1rem; font-weight: 600; }
  a { display: block; padding: .75rem 1rem; margin: .5rem 0; border: 1px solid #8884; border-radius: .75rem; color: inherit; text-decoration: none; }
  a:hover { background: #8881; }
  small { display: block; opacity: .65; }
</style>
<main>
  <h1>Sign in as</h1>
  ${links}
</main>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function identityStandIn(options: IdentityOptions) {
  const issuer = options.issuer.replace(/\/+$/, "");
  const title = options.title ?? "Sign in";
  const people = options.people ?? [];
  const clients = new Map(
    options.clients.map((client) => [
      client.id,
      { ...client, redirect: new RegExp(client.redirect) },
    ]),
  );
  // A new key each start; Mage fetches the keys again when it sees an unknown key ID.
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keyId = randomUUID();
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" }],
  };
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Claims>();

  function personOf(email: string, name: string | null): Person | null {
    const known = people.find((person) => person.email.toLowerCase() === email.toLowerCase());
    if (known) return known;
    return options.anyone && email ? { email, name: name ?? email } : null;
  }

  function authorize(url: URL) {
    const params = url.searchParams;
    const client = clients.get(params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client || !client.redirect.test(redirectUri)) {
      return json(400, {
        error: "invalid_request",
        error_description: "Unknown client or redirect",
      });
    }
    if (params.get("response_type") !== "code") {
      return json(400, { error: "unsupported_response_type" });
    }
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      return json(400, { error: "invalid_request", error_description: "PKCE is required" });
    }
    const email = params.get("login_as");
    if (!email) {
      return chooser(
        title,
        people.map((person) => {
          const pick = new URLSearchParams(params);
          pick.set("login_as", person.email);
          return { ...person, href: `${url.pathname}?${pick.toString()}` };
        }),
      );
    }
    const person = personOf(email, params.get("name"));
    if (!person)
      return json(400, { error: "access_denied", error_description: `No one is ${email}` });
    const code = randomBytes(24).toString("base64url");
    grants.set(code, {
      clientId: client.id,
      claims: {
        sub: subjectOf(person.email),
        email: person.email,
        email_verified: true,
        name: person.name,
      },
      nonce: params.get("nonce"),
      redirectUri,
      codeChallenge: params.get("code_challenge") ?? "",
      expires: Date.now() + 60_000,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state") ?? "");
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  // The client's credentials, from Basic auth or the form.
  function clientOf(req: Request, form: URLSearchParams) {
    const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
    if (basic) {
      const [id = "", secret = ""] = Buffer.from(basic, "base64").toString().split(":");
      return { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
    }
    return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
  }

  async function token(req: Request) {
    const form = new URLSearchParams(await req.text());
    const given = clientOf(req, form);
    const client = clients.get(given.id);
    if (!client || client.secret !== given.secret) return json(401, { error: "invalid_client" });
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    grants.delete(code);
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !grant ||
      grant.expires < Date.now() ||
      grant.clientId !== client.id ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("redirect_uri") !== grant.redirectUri ||
      challenge !== grant.codeChallenge
    ) {
      return json(400, { error: "invalid_grant" });
    }
    const accessToken = randomBytes(24).toString("base64url");
    accessTokens.set(accessToken, grant.claims);
    const idToken = await new SignJWT({
      ...grant.claims,
      ...(grant.nonce && { nonce: grant.nonce }),
    })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(issuer)
      .setAudience(client.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return json(200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
      scope: "openid email profile",
    });
  }

  function userinfo(req: Request) {
    const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const claims = accessTokens.get(bearer);
    return claims ? json(200, claims) : json(401, { error: "invalid_token" });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json(200, {
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
        return json(200, jwks);
      case "/authorize":
        return req.method === "GET" ? authorize(url) : json(405, {});
      case "/token":
        return req.method === "POST" ? token(req) : json(405, {});
      case "/userinfo":
        return userinfo(req);
      default:
        return json(404, { error: "not_found" });
    }
  };
}

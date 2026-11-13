import { createHash } from "node:crypto";

import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { describe, expect, it } from "vite-plus/test";

import { identityStandIn, subjectOf } from "./identity.ts";

const ISSUER = "http://idp.test";
const REDIRECT = "http://mage.test/api/auth/callback/oidc";
const VERIFIER = "a-code-verifier-long-enough-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

async function standIn(anyone = false) {
  const handle = await identityStandIn({
    issuer: ISSUER,
    clients: [{ id: "mage", secret: "shh", redirect: "^http://[^/]+/api/auth/callback/oidc$" }],
    people: [{ email: "admin@example.com", name: "Admin" }],
    anyone,
  });
  return (path: string, init?: RequestInit) => handle(new Request(`${ISSUER}${path}`, init));
}

function authorizing(more: Record<string, string> = {}) {
  return `/authorize?${new URLSearchParams({
    client_id: "mage",
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "s1",
    nonce: "n1",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...more,
  }).toString()}`;
}

async function exchange(send: Awaited<ReturnType<typeof standIn>>, location: string) {
  const code = new URL(location).searchParams.get("code") ?? "";
  return send("/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from("mage:shh").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }).toString(),
  });
}

describe("the stand-in identity provider", () => {
  it("lists its people, each a link that signs them in", async () => {
    const send = await standIn();
    const page = await (await send(authorizing())).text();
    expect(page).toContain("Sign in as");
    expect(page).toContain("admin@example.com");
    expect(page).toContain("login_as=admin%40example.com");
  });

  it("signs in the person picked, with a token for their subject", async () => {
    const send = await standIn();
    const picked = await send(authorizing({ login_as: "admin@example.com" }));
    expect(picked.status).toBe(302);
    const location = picked.headers.get("location") ?? "";
    expect(location).toMatch(/^http:\/\/mage\.test\/api\/auth\/callback\/oidc\?code=.+&state=s1$/);

    const tokens = (await (await exchange(send, location)).json()) as { id_token: string };
    const jwks = (await (await send("/jwks")).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: ISSUER,
      audience: "mage",
    });
    expect(payload).toMatchObject({
      sub: subjectOf("admin@example.com"),
      email: "admin@example.com",
      name: "Admin",
      nonce: "n1",
    });
  });

  it("takes each code once, and only with its verifier", async () => {
    const send = await standIn();
    const location =
      (await send(authorizing({ login_as: "admin@example.com" }))).headers.get("location") ?? "";
    expect((await exchange(send, location)).status).toBe(200);
    expect((await exchange(send, location)).status).toBe(400);
  });

  it("refuses someone it was not given, unless it takes anyone", async () => {
    const strict = await standIn();
    expect((await strict(authorizing({ login_as: "zoe@example.com" }))).status).toBe(400);
    const open = await standIn(true);
    const location =
      (await open(authorizing({ login_as: "zoe@example.com", name: "Zoe" }))).headers.get(
        "location",
      ) ?? "";
    const tokens = (await (await exchange(open, location)).json()) as { id_token: string };
    const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ email: "zoe@example.com", name: "Zoe" });
  });

  it("refuses a redirect its client does not take, and a request without PKCE", async () => {
    const send = await standIn();
    expect((await send(authorizing({ redirect_uri: "http://evil.test/cb" }))).status).toBe(400);
    expect((await send(authorizing({ code_challenge_method: "plain" }))).status).toBe(400);
  });
});

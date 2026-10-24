import { describe, expect, it } from "vite-plus/test";

import { type AuthOptions, createAuth, createIdentity, OIDC_PROVIDER } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { Groups } from "@/services/groups.ts";
import type { ToolDecisions } from "@/services/tools.ts";
import type { Orgs } from "@/services/orgs.ts";
import type { Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { Threads } from "@/services/threads.ts";
import type { SignInOptions } from "@/shared/sign-in.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;
const unusedSpaces = {} as Spaces;
const unusedFolders = {} as Folders;
const unusedThreads = {} as Threads;
const unusedGuests = {} as Guests;

const baseUrl = "http://localhost:4783";

const oidc = { issuer: "https://id.example.com", clientId: "mage", clientSecret: "s3cret" };

function setup(options: Pick<AuthOptions, "oidc"> = {}, db = openDatabase(":memory:")) {
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [], ...options });
  const signInOptions: SignInOptions = { oidc: options.oidc ? { name: "SSO" } : null };
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections: unusedConnections,
    models: unusedModels,
    spaces: unusedSpaces,
    folders: unusedFolders,
    threads: unusedThreads,
    guests: unusedGuests,
    orgs: {} as Orgs,
    groups: {} as Groups,
    tools: {} as ToolDecisions,
    logger,
    signInOptions,
    pingDatabase: () => Promise.resolve(true),
  });

  function post(path: string, body: object) {
    return app.request(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify(body),
    });
  }
  return {
    app,
    auth,
    signUp: (email: string) =>
      post("/sign-up/email", { name: "Ada Lovelace", email, password: "correct horse battery" }),
    signIn: (email: string, password = "correct horse battery") =>
      post("/sign-in/email", { email, password }),
  };
}

describe("/api/auth", () => {
  it("is mounted and issues a mage session cookie", async () => {
    const { signUp } = setup();

    const res = await signUp("ada@example.com");

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join()).toMatch(/^mage\.session_token=/);
  });
});

describe("with an identity provider", () => {
  it("refuses password sign-in, to accounts made before it too, and password sign-up", async () => {
    const db = openDatabase(":memory:");
    expect((await setup({}, db).signUp("ada@example.com")).status).toBe(200);
    const { signIn, signUp } = setup({ oidc }, db);
    expect((await signIn("ada@example.com")).status).toBe(400);
    expect((await signUp("grace@example.com")).status).toBe(400);
  });

  it("trusts the provider's email to join the account that has it", () => {
    const { auth } = setup({ oidc });
    expect(auth.options.account?.accountLinking).toMatchObject({
      trustedProviders: [OIDC_PROVIDER],
      requireLocalEmailVerified: false,
    });
  });
});

describe("GET /api/sign-in-options", () => {
  it("names the identity provider, signed out", async () => {
    const { app } = setup({ oidc });
    const res = await app.request("/api/sign-in-options");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ oidc: { name: "SSO" } });
  });
});

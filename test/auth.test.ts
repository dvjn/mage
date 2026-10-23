import { describe, expect, it } from "vite-plus/test";

import { type AuthOptions, createAuth, createIdentity } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { Groups } from "@/services/groups.ts";
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

function setup(
  options: Pick<AuthOptions, "passwordSignIn" | "operatorEmails"> = {},
  db = openDatabase(":memory:"),
) {
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [], ...options });
  const signInOptions: SignInOptions = {
    password: options.passwordSignIn ?? "everyone",
    oidc: null,
  };
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

describe("password sign-in for the operators alone", () => {
  // Accounts made while everyone could sign up.
  async function withAccounts() {
    const db = openDatabase(":memory:");
    const open = setup({}, db);
    for (const email of ["Grace@Example.com", "ada@example.com"]) {
      expect((await open.signUp(email)).status).toBe(200);
    }
    return setup({ passwordSignIn: "operator", operatorEmails: ["grace@example.com"] }, db);
  }

  it("lets an operator in with their password", async () => {
    const { signIn } = await withAccounts();
    expect((await signIn("grace@example.com")).status).toBe(200);
  });

  it("refuses anyone else as a wrong password would", async () => {
    const { signIn } = await withAccounts();
    const refused = await signIn("ada@example.com");
    const wrong = await signIn("grace@example.com", "not the password");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(await wrong.json());
  });

  it("refuses password sign-up, an operator's too", async () => {
    const { signUp } = setup({ passwordSignIn: "operator", operatorEmails: ["grace@example.com"] });
    expect((await signUp("grace@example.com")).status).toBe(400);
  });
});

describe("GET /api/sign-in-options", () => {
  it("says who may sign in with a password, signed out", async () => {
    const { app } = setup({ passwordSignIn: "operator" });
    const res = await app.request("/api/sign-in-options");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ password: "operator", oidc: null });
  });
});

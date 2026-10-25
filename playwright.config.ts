// Browser journeys against the production build with a fresh database and the stand-in model, which
// production refuses. It is served twice on the one database: with passwords, and signing in only
// through a stand-in OpenID Connect provider, as an instance that later turned one on. The identity
// provider and directory journeys run against the second; they provision people and groups over
// SCIM themselves, as a directory would. A stand-in OpenAI-compatible server lists models for the
// journeys that connect one, and a stand-in MCP server those that add one.

import { rmSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import { databasePath, dataDir } from "./e2e/database.ts";
import { JOURNEY_SCIM_TOKEN } from "./e2e/scim-client.ts";
import { issuer, mcpServer, modelServer, passwordServer, ssoServer } from "./e2e/servers.ts";

// The journeys that sign in through the identity provider.
const ssoJourneys = ["**/oidc.spec.ts", "**/scim.spec.ts"];
const oidcClient = { id: "mage", secret: "mage-browser-journeys-oidc-secret" };

const serverEnv = {
  NODE_ENV: "test",
  MODEL_GATEWAY: "fake",
  AUTH_SECRET: "mage-browser-journeys-secret-0123456789",
  CREDENTIAL_KEY: "WFnQPvVJ7j8limmjR6tFVpYWlTRqy8Rf8i6UJnaIaQg=",
  DATABASE_PATH: databasePath,
};

// Workers load this file too; only the runner, before the servers start, clears the data.
if (!process.env.TEST_WORKER_INDEX) {
  rmSync(dataDir, { recursive: true, force: true });
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: passwordServer,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: ssoJourneys },
    {
      name: "sso",
      use: { ...devices["Desktop Chrome"], baseURL: ssoServer },
      testMatch: ssoJourneys,
    },
  ],
  webServer: [
    {
      command: "node e2e/model-server.ts",
      url: `${modelServer}/v1/models`,
      reuseExistingServer: false,
      env: { PORT: new URL(modelServer).port },
    },
    {
      command: "node e2e/mcp-server.ts",
      url: `${mcpServer}/.well-known/oauth-authorization-server`,
      reuseExistingServer: false,
      env: { PORT: new URL(mcpServer).port },
    },
    {
      command: "node e2e/oidc-issuer.ts",
      url: `${issuer}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      env: {
        PORT: new URL(issuer).port,
        CLIENT_ID: oidcClient.id,
        CLIENT_SECRET: oidcClient.secret,
      },
    },
    {
      command: "pnpm build && node --enable-source-maps dist/server/main.js",
      url: `${passwordServer}/api/health`,
      reuseExistingServer: false,
      env: { ...serverEnv, PORT: new URL(passwordServer).port, BASE_URL: passwordServer },
    },
    // Starts once the build above is done, on the database the server above made.
    {
      command: "node --enable-source-maps dist/server/main.js",
      url: `${ssoServer}/api/health`,
      reuseExistingServer: false,
      env: {
        ...serverEnv,
        PORT: new URL(ssoServer).port,
        BASE_URL: ssoServer,
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: oidcClient.id,
        OIDC_CLIENT_SECRET: oidcClient.secret,
        OIDC_NAME: "Test IdP",
        SCIM_TOKEN: JOURNEY_SCIM_TOKEN,
      },
    },
  ],
});

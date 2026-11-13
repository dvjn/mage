// Browser journeys against the production build with a fresh database and the stand-in model, which
// production refuses. It is served three times on the one database: with passwords; signing in only
// through the stand-in identity provider, as an instance that later turned one on; and with its
// real model providers, for the journeys that reach the stand-in model over their wire protocols.
// The identity provider and directory journeys run against the second; they provision people and
// groups over SCIM themselves, as a directory would. The stand-ins the journeys reach, from the
// mock's e2e config, are an identity provider, a model provider, an MCP server and a git host.

import { rmSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import { databasePath, dataDir } from "./e2e/database.ts";
import { JOURNEY_SCIM_TOKEN } from "./mock/directory.ts";
import { artifactOrigin, issuer, passwordServer, ssoServer, wireServer } from "./e2e/servers.ts";

// The journeys that sign in through the identity provider.
const ssoJourneys = ["**/oidc.spec.ts", "**/scim.spec.ts"];
// The journeys that reach the stand-in model through Mage's real providers.
const wireJourneys = ["**/model-wire.spec.ts"];
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
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [...ssoJourneys, ...wireJourneys],
    },
    {
      name: "sso",
      use: { ...devices["Desktop Chrome"], baseURL: ssoServer },
      testMatch: ssoJourneys,
    },
    {
      name: "wire",
      use: { ...devices["Desktop Chrome"], baseURL: wireServer },
      testMatch: wireJourneys,
    },
  ],
  webServer: [
    {
      command: "node mock/main.ts mock/e2e.yaml",
      url: `${issuer}/_mock/health`,
      reuseExistingServer: false,
      env: { OIDC_CLIENT_ID: oidcClient.id, OIDC_CLIENT_SECRET: oidcClient.secret },
    },
    {
      command: "pnpm build && node --enable-source-maps dist/server/main.js",
      url: `${passwordServer}/api/health`,
      reuseExistingServer: false,
      env: {
        ...serverEnv,
        PORT: new URL(passwordServer).port,
        BASE_URL: passwordServer,
        ARTIFACT_ORIGIN: artifactOrigin,
      },
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
    {
      command: "node --enable-source-maps dist/server/main.js",
      url: `${wireServer}/api/health`,
      reuseExistingServer: false,
      env: {
        ...serverEnv,
        MODEL_GATEWAY: "providers",
        PORT: new URL(wireServer).port,
        BASE_URL: wireServer,
      },
    },
  ],
});

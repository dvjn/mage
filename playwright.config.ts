// Browser journeys against the production build, served on its own port with a fresh database.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = 4793;
const baseURL = `http://localhost:${port}`;
const dataDir = path.join(tmpdir(), "mage-e2e");

// Workers load this file too; only the runner, before the server starts, clears the data.
if (!process.env.TEST_WORKER_INDEX) {
  rmSync(dataDir, { recursive: true, force: true });
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && node --enable-source-maps dist/server/main.js",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      BASE_URL: baseURL,
      AUTH_SECRET: "mage-browser-journeys-secret-0123456789",
      CREDENTIAL_KEY: "WFnQPvVJ7j8limmjR6tFVpYWlTRqy8Rf8i6UJnaIaQg=",
      DATABASE_PATH: path.join(dataDir, "mage.db"),
    },
  },
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { Groups } from "@/services/groups.ts";
import type { Instructions } from "@/services/instructions.ts";
import type { McpServers } from "@/services/mcp-servers.ts";
import type { Skills } from "@/services/skills.ts";
import type { ToolPolicies } from "@/services/tool-policies.ts";
import type { ToolDecisions } from "@/services/tools.ts";
import type { Orgs } from "@/services/orgs.ts";
import type { Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { Threads } from "@/services/threads.ts";

const webRoot = mkdtempSync(path.join(tmpdir(), "mage-web-"));
mkdirSync(path.join(webRoot, "assets"));
writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Mage</title>");
writeFileSync(path.join(webRoot, "assets/app.js"), "export {};");
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const app = createApp({
  handleAuth: () => Promise.resolve(new Response(null, { status: 404 })),
  identity: {
    resolve: () => Promise.resolve(null),
    profile: () => Promise.reject(new Error("signed out")),
  },
  connections: {} as Connections,
  models: {} as Models,
  spaces: {} as Spaces,
  folders: {} as Folders,
  threads: {} as Threads,
  guests: {} as Guests,
  orgs: {} as Orgs,
  groups: {} as Groups,
  tools: {} as ToolDecisions,
  toolPolicies: {} as ToolPolicies,
  mcp: {} as McpServers,
  instructions: {} as Instructions,
  skills: {} as Skills,
  logger: createLogger({ write() {} }),
  signInOptions: { oidc: null },
  pingDatabase: () => Promise.resolve(true),
  webRoot,
});

describe("web client", () => {
  it("serves index.html for a client route", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Mage</title>");
  });

  it("serves an existing asset", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export {};");
  });

  it("does not answer a missing asset with index.html", async () => {
    const res = await app.request("/assets/missing.js");
    expect(res.status).toBe(404);
  });
});

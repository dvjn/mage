import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import type { Folders } from "@/server/folders/service.ts";
import type { Guests } from "@/server/guests/service.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import type { Connections } from "@/server/models/connections.ts";
import type { Models } from "@/server/models/service.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import type { Skills } from "@/server/skills/service.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import type { Threads } from "@/server/threads/service.ts";

import { createApp } from "./app.ts";

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

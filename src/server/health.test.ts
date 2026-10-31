import { describe, expect, it } from "vite-plus/test";

import type { ToolPolicies } from "@/server/agent/tool-policies.ts";
import type { ToolDecisions } from "@/server/agent/tools.ts";
import { openDatabase, pingDatabase } from "@/server/db/db.ts";
import type { Folders } from "@/server/folders/service.ts";
import type { Guests } from "@/server/guests/service.ts";
import type { Instructions } from "@/server/instructions/service.ts";
import { createLogger } from "@/server/kernel/logger.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import type { Connections } from "@/server/models/connections.ts";
import type { Models } from "@/server/models/service.ts";
import type { Groups } from "@/server/orgs/groups.ts";
import type { Identity } from "@/server/orgs/identity.ts";
import type { Orgs } from "@/server/orgs/service.ts";
import type { Skills } from "@/server/skills/service.ts";
import type { Spaces } from "@/server/spaces/service.ts";
import type { Threads } from "@/server/threads/service.ts";

import { createApp } from "./app.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;
const unusedSpaces = {} as Spaces;
const unusedFolders = {} as Folders;
const unusedThreads = {} as Threads;
const unusedGuests = {} as Guests;

const handleAuth = () => Promise.resolve(new Response(null, { status: 404 }));
const logger = createLogger({ write() {} });
const identity: Identity = {
  resolve: () => Promise.resolve(null),
  profile: () => Promise.reject(new Error("signed out")),
};

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const db = openDatabase(":memory:");
    const res = await createApp({
      handleAuth,
      identity,
      connections: unusedConnections,
      models: unusedModels,
      spaces: unusedSpaces,
      folders: unusedFolders,
      threads: unusedThreads,
      guests: unusedGuests,
      orgs: {} as Orgs,
      groups: {} as Groups,
      tools: {} as ToolDecisions,
      toolPolicies: {} as ToolPolicies,
      mcp: {} as McpServers,
      instructions: {} as Instructions,
      skills: {} as Skills,
      logger,
      signInOptions: { oidc: null },
      pingDatabase: () => pingDatabase(db),
    }).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: true });
  });

  it("reports unavailable when the database does not answer", async () => {
    const res = await createApp({
      handleAuth,
      identity,
      connections: unusedConnections,
      models: unusedModels,
      spaces: unusedSpaces,
      folders: unusedFolders,
      threads: unusedThreads,
      guests: unusedGuests,
      orgs: {} as Orgs,
      groups: {} as Groups,
      tools: {} as ToolDecisions,
      toolPolicies: {} as ToolPolicies,
      mcp: {} as McpServers,
      instructions: {} as Instructions,
      skills: {} as Skills,
      logger,
      signInOptions: { oidc: null },
      pingDatabase: () => Promise.resolve(false),
    }).request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: false });
  });
});

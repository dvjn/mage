import { describe, expect, it } from "vite-plus/test";

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
const identity: Identity = {
  resolve: () => Promise.resolve(null),
  profile: () => Promise.reject(new Error("signed out")),
};

describe("request logging", () => {
  it("logs each request with its request id", async () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const app = createApp({
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
      pingDatabase: () => Promise.resolve(true),
    });

    const res = await app.request("/api/health");

    const reqId = res.headers.get("X-Request-Id");
    expect(reqId).toBeTruthy();
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        msg: "request",
        reqId,
        method: "GET",
        path: "/api/health",
        status: 200,
      }),
    ]);
  });
});

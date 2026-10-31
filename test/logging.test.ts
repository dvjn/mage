import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Identity } from "@/ports/identity.ts";
import type { Connections } from "@/services/connections.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { Groups } from "@/services/groups.ts";
import type { Instructions } from "@/services/instructions.ts";
import type { McpServers } from "@/services/mcp-servers.ts";
import type { ToolPolicies } from "@/services/tool-policies.ts";
import type { ToolDecisions } from "@/services/tools.ts";
import type { Orgs } from "@/services/orgs.ts";
import type { Models } from "@/services/models.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { Threads } from "@/services/threads.ts";

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

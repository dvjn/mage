import { describe, expect, it } from "vite-plus/test";

import { openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Identity } from "@/ports/identity.ts";
import type { Connections } from "@/services/connections.ts";
import type { Folders } from "@/services/folders.ts";
import type { Guests } from "@/services/guests.ts";
import type { Groups } from "@/services/groups.ts";
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
      logger,
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
      logger,
      pingDatabase: () => Promise.resolve(false),
    }).request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: false });
  });
});

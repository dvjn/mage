// MCP servers kept in the mcp_server table, with ULID ids and their settings and tools as JSON, and
// their secrets as JSON sealed by the cipher in the mcp_credential table, bound to the server and
// whose they are.

import { and, asc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";

import type {
  McpCredentialStore,
  McpHolder,
  McpSecrets,
  McpServer,
  McpServerStore,
  McpSettings,
} from "@/ports/mcp.ts";
import type { ToolDefinition } from "@/shared/tools.ts";

import type { Cipher } from "./cipher.ts";
import type { Db } from "./db.ts";
import { mcpCredential, mcpServer } from "./schema.ts";

const columns = {
  id: mcpServer.id,
  orgId: mcpServer.organizationId,
  spaceId: mcpServer.spaceId,
  name: mcpServer.name,
  url: mcpServer.url,
  authKind: mcpServer.authKind,
  settings: mcpServer.settings,
  transport: mcpServer.transport,
  protocolVersion: mcpServer.protocolVersion,
  status: mcpServer.status,
  error: mcpServer.error,
  serverInfo: mcpServer.serverInfo,
  tools: mcpServer.tools,
  toolsReadAt: mcpServer.toolsReadAt,
  createdBy: mcpServer.createdBy,
  createdAt: mcpServer.createdAt,
};

type Row = Omit<McpServer, "settings" | "tools"> & {
  settings: Record<string, unknown>;
  tools: unknown[];
};

function serverOf(row: Row): McpServer {
  return { ...row, settings: row.settings as McpSettings, tools: row.tools as ToolDefinition[] };
}

export function createMcpServerStore(db: Db): McpServerStore {
  return {
    create(input) {
      const { orgId, settings, ...rest } = input;
      return serverOf(
        db
          .insert(mcpServer)
          .values({
            id: ulid(),
            organizationId: orgId,
            settings: settings as Record<string, unknown>,
            status: "ok",
            tools: [],
            ...rest,
          })
          .returning(columns)
          .get(),
      );
    },

    find(id) {
      const row = db.select(columns).from(mcpServer).where(eq(mcpServer.id, id)).get();
      return row ? serverOf(row) : null;
    },

    inOrg(orgId) {
      return db
        .select(columns)
        .from(mcpServer)
        .where(and(eq(mcpServer.organizationId, orgId), isNull(mcpServer.spaceId)))
        .orderBy(asc(mcpServer.id))
        .all()
        .map(serverOf);
    },

    inSpace(spaceId) {
      return db
        .select(columns)
        .from(mcpServer)
        .where(eq(mcpServer.spaceId, spaceId))
        .orderBy(asc(mcpServer.id))
        .all()
        .map(serverOf);
    },

    update(id, changes) {
      const { settings, tools, ...rest } = changes;
      db.update(mcpServer)
        .set({
          ...rest,
          ...(settings && { settings: settings as Record<string, unknown> }),
          ...(tools && { tools }),
        })
        .where(eq(mcpServer.id, id))
        .run();
    },

    delete(id) {
      db.delete(mcpServer).where(eq(mcpServer.id, id)).run();
    },
  };
}

function holderKey(holder: McpHolder) {
  return { holderKind: holder.kind, holderId: holder.kind === "user" ? holder.userId : "" };
}

// What a sealed value is bound to: the server and whose it is.
function contextOf(serverId: string, holder: McpHolder) {
  const { holderKind, holderId } = holderKey(holder);
  return `mcp:${serverId}:${holderKind}:${holderId}`;
}

export function createMcpCredentialStore(db: Db, cipher: Cipher): McpCredentialStore {
  function where(serverId: string, holder: McpHolder) {
    const { holderKind, holderId } = holderKey(holder);
    return and(
      eq(mcpCredential.serverId, serverId),
      eq(mcpCredential.holderKind, holderKind),
      eq(mcpCredential.holderId, holderId),
    );
  }

  return {
    get(serverId, holder) {
      const row = db
        .select({ keyVersion: mcpCredential.keyVersion, data: mcpCredential.sealed })
        .from(mcpCredential)
        .where(where(serverId, holder))
        .get();
      if (!row) return null;
      return JSON.parse(cipher.open(row, contextOf(serverId, holder)).toString()) as McpSecrets;
    },

    put(serverId, holder, secrets) {
      const { keyVersion, data } = cipher.seal(
        Buffer.from(JSON.stringify(secrets)),
        contextOf(serverId, holder),
      );
      db.insert(mcpCredential)
        .values({ serverId, ...holderKey(holder), keyVersion, sealed: data })
        .onConflictDoUpdate({
          target: [mcpCredential.serverId, mcpCredential.holderKind, mcpCredential.holderId],
          set: { keyVersion, sealed: data, updatedAt: new Date() },
        })
        .run();
    },

    delete(serverId, holder) {
      db.delete(mcpCredential).where(where(serverId, holder)).run();
    },
  };
}

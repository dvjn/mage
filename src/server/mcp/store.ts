import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { ToolDefinition } from "@/shared/tools.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";
import { leasesOn } from "@/server/sync/lease.ts";

import type { McpPrompt } from "./client.ts";
import type {
  McpCredentialStore,
  McpHolder,
  McpSecrets,
  McpServer,
  McpServerStore,
  McpSettings,
} from "./service.ts";
import { mcpCredential, mcpServer, spaceMcpServerSetting } from "./schema.ts";

const columns = {
  id: mcpServer.id,
  orgId: mcpServer.organizationId,
  spaceId: mcpServer.spaceId,
  name: mcpServer.name,
  slug: mcpServer.slug,
  url: mcpServer.url,
  enabled: mcpServer.enabled,
  authKind: mcpServer.authKind,
  credentials: mcpServer.credentials,
  settings: mcpServer.settings,
  transport: mcpServer.transport,
  protocolVersion: mcpServer.protocolVersion,
  status: mcpServer.status,
  error: mcpServer.error,
  serverInfo: mcpServer.serverInfo,
  instructions: mcpServer.instructions,
  instructionsCut: mcpServer.instructionsCut,
  resources: mcpServer.resources,
  tools: mcpServer.tools,
  prompts: mcpServer.prompts,
  toolsReadAt: mcpServer.toolsReadAt,
  createdBy: mcpServer.createdBy,
  createdAt: mcpServer.createdAt,
};

type Row = Omit<McpServer, "settings" | "tools" | "prompts" | "slug"> & {
  slug: string | null;
  settings: Record<string, unknown>;
  tools: unknown[];
  prompts: unknown[];
};

function serverOf(row: Row): McpServer {
  return {
    ...row,
    slug: row.slug ?? "",
    settings: row.settings as McpSettings,
    tools: row.tools as ToolDefinition[],
    prompts: row.prompts as McpPrompt[],
  };
}

export function createMcpServerStore(db: Db): McpServerStore {
  return {
    async create(input) {
      const { orgId, settings, ...rest } = input;
      return serverOf(
        (
          await db
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
        )[0]!,
      );
    },

    async find(id) {
      const row = (
        await db.select(columns).from(mcpServer).where(eq(mcpServer.id, id)).limit(1)
      )[0];
      return row ? serverOf(row) : null;
    },

    async inOrg(orgId) {
      return (
        await db
          .select(columns)
          .from(mcpServer)
          .where(and(eq(mcpServer.organizationId, orgId), isNull(mcpServer.spaceId)))
          .orderBy(asc(mcpServer.id))
      ).map(serverOf);
    },

    async inSpace(spaceId) {
      return (
        await db
          .select(columns)
          .from(mcpServer)
          .where(eq(mcpServer.spaceId, spaceId))
          .orderBy(asc(mcpServer.id))
      ).map(serverOf);
    },

    async everyInOrg(orgId) {
      return (
        await db
          .select(columns)
          .from(mcpServer)
          .where(eq(mcpServer.organizationId, orgId))
          .orderBy(asc(mcpServer.id))
      ).map(serverOf);
    },

    async update(id, changes) {
      const { settings, tools, ...rest } = changes;
      await db
        .update(mcpServer)
        .set({
          ...rest,
          ...(settings && { settings: settings as Record<string, unknown> }),
          ...(tools && { tools }),
        })
        .where(eq(mcpServer.id, id));
    },

    async delete(id) {
      await db.delete(mcpServer).where(eq(mcpServer.id, id));
    },

    async inSpaceSettings(spaceId) {
      const rows = await db
        .select({
          serverId: spaceMcpServerSetting.serverId,
          enabled: spaceMcpServerSetting.enabled,
        })
        .from(spaceMcpServerSetting)
        .where(eq(spaceMcpServerSetting.spaceId, spaceId));
      return new Map(rows.map((row) => [row.serverId, row.enabled]));
    },

    async setInSpace(spaceId, serverId, enabled) {
      await db
        .insert(spaceMcpServerSetting)
        .values({ spaceId, serverId, enabled })
        .onConflictDoUpdate({
          target: [spaceMcpServerSetting.spaceId, spaceMcpServerSetting.serverId],
          set: { enabled },
        });
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

const leases = leasesOn(mcpCredential);

export function createMcpCredentialStore(db: Db, cipher: Cipher): McpCredentialStore {
  function where(serverId: string, holder: McpHolder) {
    const { holderKind, holderId } = holderKey(holder);
    return and(
      eq(mcpCredential.serverId, serverId),
      eq(mcpCredential.holderKind, holderKind),
      eq(mcpCredential.holderId, holderId),
    );
  }

  function sealed(serverId: string, holder: McpHolder, secrets: McpSecrets) {
    return cipher.seal(Buffer.from(JSON.stringify(secrets)), contextOf(serverId, holder));
  }

  return {
    async get(serverId, holder) {
      const row = (
        await db
          .select({ keyVersion: mcpCredential.keyVersion, data: mcpCredential.sealed })
          .from(mcpCredential)
          .where(where(serverId, holder))
          .limit(1)
      )[0];
      if (!row) return null;
      return JSON.parse(cipher.open(row, contextOf(serverId, holder)).toString()) as McpSecrets;
    },

    async put(serverId, holder, secrets) {
      const { keyVersion, data } = sealed(serverId, holder, secrets);
      await db
        .insert(mcpCredential)
        .values({ serverId, ...holderKey(holder), keyVersion, sealed: data })
        .onConflictDoUpdate({
          target: [mcpCredential.serverId, mcpCredential.holderKind, mcpCredential.holderId],
          set: { keyVersion, sealed: data, status: "ok", updatedAt: new Date() },
        });
    },

    async delete(serverId, holder) {
      await db.delete(mcpCredential).where(where(serverId, holder));
    },

    async lease(serverId, holder, owner, ms) {
      const [row] = await db
        .update(mcpCredential)
        // Taking the lease changes nothing people see about the secrets.
        .set({ ...leases.take(owner, ms), updatedAt: sql`${mcpCredential.updatedAt}` })
        .where(and(where(serverId, holder), leases.expired()))
        .returning({ epoch: mcpCredential.leaseEpoch });
      return row ? { owner, epoch: row.epoch } : null;
    },

    async putHeld(serverId, holder, lease, secrets) {
      const { keyVersion, data } = sealed(serverId, holder, secrets);
      const rows = await db
        .update(mcpCredential)
        .set({ keyVersion, sealed: data, status: "ok", ...leases.release(), updatedAt: new Date() })
        .where(and(where(serverId, holder), leases.held(lease)))
        .returning({ serverId: mcpCredential.serverId });
      return rows.length > 0;
    },

    async putIf(serverId, holder, holds, secrets) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ keyVersion: mcpCredential.keyVersion, data: mcpCredential.sealed })
          .from(mcpCredential)
          .where(where(serverId, holder))
          .for("update");
        if (!row) return false;
        const stored = JSON.parse(
          cipher.open(row, contextOf(serverId, holder)).toString(),
        ) as McpSecrets;
        if (!holds(stored)) return false;
        const { keyVersion, data } = sealed(serverId, holder, { ...stored, ...secrets });
        await tx
          .update(mcpCredential)
          .set({ keyVersion, sealed: data, status: "ok", updatedAt: new Date() })
          .where(where(serverId, holder));
        return true;
      });
    },

    async release(serverId, holder, lease) {
      await db
        .update(mcpCredential)
        .set({ ...leases.release(), updatedAt: sql`${mcpCredential.updatedAt}` })
        .where(and(where(serverId, holder), leases.held(lease)));
    },

    async deletePeople(serverId) {
      await db
        .delete(mcpCredential)
        .where(and(eq(mcpCredential.serverId, serverId), eq(mcpCredential.holderKind, "user")));
    },

    async status(serverId, holder) {
      return (
        (
          await db
            .select({ status: mcpCredential.status })
            .from(mcpCredential)
            .where(where(serverId, holder))
            .limit(1)
        )[0]?.status ?? null
      );
    },

    async setStatus(serverId, holder, status) {
      await db.update(mcpCredential).set({ status }).where(where(serverId, holder));
    },

    async ofUser(userId) {
      return await db
        .select({
          serverId: mcpCredential.serverId,
          status: mcpCredential.status,
          updatedAt: mcpCredential.updatedAt,
        })
        .from(mcpCredential)
        .where(and(eq(mcpCredential.holderKind, "user"), eq(mcpCredential.holderId, userId)))
        .orderBy(asc(mcpCredential.serverId));
    },
  };
}

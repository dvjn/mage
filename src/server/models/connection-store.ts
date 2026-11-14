import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { HostId } from "@/shared/hosts.ts";
import type { Db } from "@/server/db/db.ts";

import type { Connection, ConnectionStore } from "./connections.ts";
import { connection } from "./schema.ts";

const columns = {
  id: connection.id,
  orgId: connection.organizationId,
  createdBy: connection.createdBy,
  host: connection.host,
  authKind: connection.authKind,
  account: connection.account,
  label: connection.label,
  settings: connection.settings,
  autoEnableModels: connection.autoEnableModels,
  createdAt: connection.createdAt,
};

type Row = Omit<Connection, "host" | "settings"> & {
  host: string;
  settings: Record<string, string> | null;
};

// The host is checked when the connection is made, so a row's is one the registry names.
function connectionOf(row: Row): Connection {
  return { ...row, host: row.host as HostId, settings: row.settings ?? {} };
}

export function createConnectionStore(db: Db): ConnectionStore {
  return {
    async create(input) {
      const { orgId, label = null, settings = {}, ...rest } = input;
      return connectionOf(
        (
          await db
            .insert(connection)
            .values({ id: ulid(), organizationId: orgId, label, settings, ...rest })
            .returning(columns)
        )[0]!,
      );
    },

    async list(orgId) {
      return (
        await db
          .select(columns)
          .from(connection)
          .where(eq(connection.organizationId, orgId))
          .orderBy(connection.id)
      ).map(connectionOf);
    },

    async find(orgId, id): Promise<Connection | null> {
      const row = (
        await db
          .select(columns)
          .from(connection)
          .where(and(eq(connection.id, id), eq(connection.organizationId, orgId)))
          .limit(1)
      )[0];
      return row ? connectionOf(row) : null;
    },

    async update(id, changes) {
      await db.update(connection).set(changes).where(eq(connection.id, id));
    },

    async setAutoEnableModels(id, on) {
      await db.update(connection).set({ autoEnableModels: on }).where(eq(connection.id, id));
    },

    async delete(id) {
      await db.delete(connection).where(eq(connection.id, id));
    },
  };
}

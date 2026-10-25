// Connections kept in the connection table, with ULID ids and their settings as JSON.

import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Connection, ConnectionStore } from "@/ports/connections.ts";
import type { HostId } from "@/shared/hosts.ts";

import type { Db } from "./db.ts";
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
    create(input) {
      const { orgId, label = null, settings = {}, ...rest } = input;
      return connectionOf(
        db
          .insert(connection)
          .values({ id: ulid(), organizationId: orgId, label, settings, ...rest })
          .returning(columns)
          .get(),
      );
    },

    list(orgId) {
      return db
        .select(columns)
        .from(connection)
        .where(eq(connection.organizationId, orgId))
        .orderBy(connection.id)
        .all()
        .map(connectionOf);
    },

    find(orgId, id): Connection | null {
      const row = db
        .select(columns)
        .from(connection)
        .where(and(eq(connection.id, id), eq(connection.organizationId, orgId)))
        .get();
      return row ? connectionOf(row) : null;
    },

    update(id, changes) {
      db.update(connection).set(changes).where(eq(connection.id, id)).run();
    },

    setAutoEnableModels(id, on) {
      db.update(connection).set({ autoEnableModels: on }).where(eq(connection.id, id)).run();
    },

    delete(id) {
      db.delete(connection).where(eq(connection.id, id)).run();
    },
  };
}

// Connections kept in the connection table, with ULID ids.

import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Connection, ConnectionStore } from "@/ports/connections.ts";

import type { Db } from "./db.ts";
import { connection } from "./schema.ts";

const columns = {
  id: connection.id,
  orgId: connection.organizationId,
  createdBy: connection.createdBy,
  provider: connection.provider,
  authKind: connection.authKind,
  account: connection.account,
  label: connection.label,
  autoEnableModels: connection.autoEnableModels,
  createdAt: connection.createdAt,
};

export function createConnectionStore(db: Db): ConnectionStore {
  return {
    create(input) {
      const { orgId, label = null, ...rest } = input;
      return db
        .insert(connection)
        .values({ id: ulid(), organizationId: orgId, label, ...rest })
        .returning(columns)
        .get();
    },

    list(orgId) {
      return db
        .select(columns)
        .from(connection)
        .where(eq(connection.organizationId, orgId))
        .orderBy(connection.id)
        .all();
    },

    find(orgId, id): Connection | null {
      return (
        db
          .select(columns)
          .from(connection)
          .where(and(eq(connection.id, id), eq(connection.organizationId, orgId)))
          .get() ?? null
      );
    },

    setLabel(id, label) {
      db.update(connection).set({ label }).where(eq(connection.id, id)).run();
    },

    setAutoEnableModels(id, on) {
      db.update(connection).set({ autoEnableModels: on }).where(eq(connection.id, id)).run();
    },

    delete(id) {
      db.delete(connection).where(eq(connection.id, id)).run();
    },
  };
}

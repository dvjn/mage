// Credentials as JSON sealed by the cipher in the credential table, bound to their connection.

import { and, eq, sql } from "drizzle-orm";

import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";
import { leasesOn } from "@/server/sync/lease.ts";

import type { Credential, CredentialStore } from "./connections.ts";
import { credential } from "./schema.ts";

const leases = leasesOn(credential);

export function createCredentialStore(db: Db, cipher: Cipher): CredentialStore {
  function sealed(connectionId: string, value: Credential) {
    const { keyVersion, data } = cipher.seal(Buffer.from(JSON.stringify(value)), connectionId);
    return { keyVersion, sealed: data };
  }

  return {
    async put(connectionId, value) {
      const row = sealed(connectionId, value);
      await db
        .insert(credential)
        .values({ connectionId, ...row })
        .onConflictDoUpdate({
          target: credential.connectionId,
          set: { ...row, updatedAt: new Date() },
        });
    },

    async get(connectionId) {
      const row = (
        await db
          .select({ keyVersion: credential.keyVersion, data: credential.sealed })
          .from(credential)
          .where(eq(credential.connectionId, connectionId))
          .limit(1)
      )[0];
      if (!row) return null;
      return JSON.parse(cipher.open(row, connectionId).toString()) as Credential;
    },

    async delete(connectionId) {
      await db.delete(credential).where(eq(credential.connectionId, connectionId));
    },

    async lease(connectionId, owner, ms) {
      const [row] = await db
        .update(credential)
        // Taking the lease changes nothing people see about the credential.
        .set({ ...leases.take(owner, ms), updatedAt: sql`${credential.updatedAt}` })
        .where(and(eq(credential.connectionId, connectionId), leases.expired()))
        .returning({ epoch: credential.leaseEpoch });
      return row ? { owner, epoch: row.epoch } : null;
    },

    async putHeld(connectionId, lease, value) {
      const rows = await db
        .update(credential)
        .set({ ...sealed(connectionId, value), ...leases.release(), updatedAt: new Date() })
        .where(and(eq(credential.connectionId, connectionId), leases.held(lease)))
        .returning({ connectionId: credential.connectionId });
      return rows.length > 0;
    },

    async putIf(connectionId, holds, value) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ keyVersion: credential.keyVersion, data: credential.sealed })
          .from(credential)
          .where(eq(credential.connectionId, connectionId))
          .for("update");
        if (!row) return false;
        const stored = JSON.parse(cipher.open(row, connectionId).toString()) as Credential;
        if (!holds(stored)) return false;
        await tx
          .update(credential)
          .set({ ...sealed(connectionId, value), updatedAt: new Date() })
          .where(eq(credential.connectionId, connectionId));
        return true;
      });
    },

    async release(connectionId, lease) {
      await db
        .update(credential)
        .set({ ...leases.release(), updatedAt: sql`${credential.updatedAt}` })
        .where(and(eq(credential.connectionId, connectionId), leases.held(lease)));
    },
  };
}

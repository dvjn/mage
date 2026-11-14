// Credentials as JSON sealed by the cipher in the credential table, bound to their connection.

import { eq } from "drizzle-orm";

import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Db } from "@/server/db/db.ts";

import type { Credential, CredentialStore } from "./connections.ts";
import { credential } from "./schema.ts";

export function createCredentialStore(db: Db, cipher: Cipher): CredentialStore {
  return {
    async put(connectionId, value) {
      const { keyVersion, data } = cipher.seal(Buffer.from(JSON.stringify(value)), connectionId);
      await db
        .insert(credential)
        .values({ connectionId, keyVersion, sealed: data })
        .onConflictDoUpdate({
          target: credential.connectionId,
          set: { keyVersion, sealed: data, updatedAt: new Date() },
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
  };
}

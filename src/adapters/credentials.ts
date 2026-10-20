// Credentials as JSON sealed by the cipher in the credential table, bound to their connection.

import { eq } from "drizzle-orm";

import type { Credential, CredentialStore } from "@/ports/credentials.ts";

import type { Cipher } from "./cipher.ts";
import type { Db } from "./db.ts";
import { credential } from "./schema.ts";

export function createCredentialStore(db: Db, cipher: Cipher): CredentialStore {
  return {
    put(connectionId, value) {
      const { keyVersion, data } = cipher.seal(Buffer.from(JSON.stringify(value)), connectionId);
      db.insert(credential)
        .values({ connectionId, keyVersion, sealed: data })
        .onConflictDoUpdate({
          target: credential.connectionId,
          set: { keyVersion, sealed: data, updatedAt: new Date() },
        })
        .run();
    },

    get(connectionId) {
      const row = db
        .select({ keyVersion: credential.keyVersion, data: credential.sealed })
        .from(credential)
        .where(eq(credential.connectionId, connectionId))
        .get();
      if (!row) return null;
      return JSON.parse(cipher.open(row, connectionId).toString()) as Credential;
    },

    delete(connectionId) {
      db.delete(credential).where(eq(credential.connectionId, connectionId)).run();
    },
  };
}

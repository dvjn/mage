import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createCipher } from "@/server/kernel/cipher.ts";
import { openStoreDatabase } from "@/server/testing/database.ts";
import * as schema from "@/server/schema.ts";

import { createConnectionStore } from "./connection-store.ts";
import { createCredentialStore } from "./credential-store.ts";

const key = Buffer.alloc(32, 7);

describe("cipher", () => {
  const cipher = createCipher({ version: 1, key });
  const plaintext = Buffer.from("refresh-token");

  it("opens what it sealed in the same context", () => {
    const sealed = cipher.seal(plaintext, "conn-1");
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.data.includes(plaintext)).toBe(false);
    expect(cipher.open(sealed, "conn-1")).toEqual(plaintext);
  });

  it("refuses tampered data", () => {
    const sealed = cipher.seal(plaintext, "conn-1");
    const data = Buffer.from(sealed.data);
    data[data.length - 1] = (data.at(-1) ?? 0) ^ 1;
    expect(() => cipher.open({ ...sealed, data }, "conn-1")).toThrow();
  });

  it("refuses data sealed for another context", () => {
    const sealed = cipher.seal(plaintext, "conn-1");
    expect(() => cipher.open(sealed, "conn-2")).toThrow();
  });

  it("refuses an unknown key version", () => {
    const sealed = cipher.seal(plaintext, "conn-1");
    expect(() => cipher.open({ ...sealed, keyVersion: 2 }, "conn-1")).toThrow(/version 2/);
  });

  it("refuses data sealed under another key", () => {
    const sealed = createCipher({ version: 1, key: Buffer.alloc(32, 8) }).seal(plaintext, "c");
    expect(() => cipher.open(sealed, "c")).toThrow();
  });
});

describe("credential store", () => {
  async function setup() {
    const db = openStoreDatabase();
    await db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
    await db
      .insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "personal", createdAt: new Date() });
    const connection = await createConnectionStore(db).create({
      orgId: "acme",
      createdBy: "ada",
      host: "codex",
      authKind: "oauth",
      account: "ada@example.com",
    });
    const store = createCredentialStore(db, createCipher({ version: 1, key }));
    return { db, store, id: connection.id };
  }

  it("stores a credential sealed and reads it back", async () => {
    const { db, store, id } = await setup();
    await store.put(id, { refresh_token: "secret-refresh-token" });

    const row = (await db.select().from(schema.credential).limit(1))[0];
    expect(row?.keyVersion).toBe(1);
    expect(row?.sealed.toString("latin1")).not.toContain("secret-refresh-token");
    expect(await store.get(id)).toEqual({ refresh_token: "secret-refresh-token" });
  });

  it("refuses a stored credential that was tampered with", async () => {
    const { db, store, id } = await setup();
    await store.put(id, { refresh_token: "secret-refresh-token" });
    const row = (await db.select().from(schema.credential).limit(1))[0];
    const sealed = Buffer.from(row?.sealed ?? []);
    sealed[20] = (sealed[20] ?? 0) ^ 1;
    await db
      .update(schema.credential)
      .set({ sealed })
      .where(eq(schema.credential.connectionId, id));

    await expect(store.get(id)).rejects.toThrow();
  });

  it("deletes a credential", async () => {
    const { store, id } = await setup();
    await store.put(id, { refresh_token: "secret-refresh-token" });

    await store.delete(id);

    expect(await store.get(id)).toBeNull();
  });
});

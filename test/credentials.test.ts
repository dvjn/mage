import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createCipher } from "@/adapters/cipher.ts";
import { createConnectionStore } from "@/adapters/connections.ts";
import { createCredentialStore } from "@/adapters/credentials.ts";
import { openDatabase } from "@/adapters/db.ts";
import * as schema from "@/adapters/schema.ts";

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
  function setup() {
    const db = openDatabase(":memory:");
    db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" }).run();
    db.insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", kind: "personal", createdAt: new Date() })
      .run();
    const connection = createConnectionStore(db).create({
      orgId: "acme",
      createdBy: "ada",
      provider: "openai",
      authKind: "codex",
      account: "ada@example.com",
    });
    const store = createCredentialStore(db, createCipher({ version: 1, key }));
    return { db, store, id: connection.id };
  }

  it("stores a credential sealed and reads it back", () => {
    const { db, store, id } = setup();
    store.put(id, { refresh_token: "secret-refresh-token" });

    const row = db.select().from(schema.credential).get();
    expect(row?.keyVersion).toBe(1);
    expect(row?.sealed.toString("latin1")).not.toContain("secret-refresh-token");
    expect(store.get(id)).toEqual({ refresh_token: "secret-refresh-token" });
  });

  it("refuses a stored credential that was tampered with", () => {
    const { db, store, id } = setup();
    store.put(id, { refresh_token: "secret-refresh-token" });
    const row = db.select().from(schema.credential).get();
    const sealed = Buffer.from(row?.sealed ?? []);
    sealed[20] = (sealed[20] ?? 0) ^ 1;
    db.update(schema.credential)
      .set({ sealed })
      .where(eq(schema.credential.connectionId, id))
      .run();

    expect(() => store.get(id)).toThrow();
  });

  it("deletes a credential", () => {
    const { store, id } = setup();
    store.put(id, { refresh_token: "secret-refresh-token" });

    store.delete(id);

    expect(store.get(id)).toBeNull();
  });
});

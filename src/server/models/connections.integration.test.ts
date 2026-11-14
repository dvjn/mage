import { describe, expect, it } from "vite-plus/test";

import { openStoreDatabase } from "@/server/testing/database.ts";
import * as schema from "@/server/schema.ts";

import { createConnectionStore } from "./connection-store.ts";

async function setup() {
  const db = openStoreDatabase();
  const createdAt = new Date();
  await db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  await db.insert(schema.organization).values([
    { id: "acme", name: "Acme", slug: "acme", kind: "personal", createdAt },
    { id: "other", name: "Other", slug: "other", kind: "personal", createdAt },
  ]);
  return createConnectionStore(db);
}

const codex = {
  createdBy: "ada",
  host: "codex",
  authKind: "oauth",
  account: "a@example.com",
} as const;

describe("connection store", () => {
  it("lists the org's connections only", async () => {
    const store = await setup();
    const own = await store.create({ ...codex, orgId: "acme" });
    await store.create({ ...codex, orgId: "other" });

    expect(await store.list("acme")).toEqual([own]);
  });

  it("finds a connection only in its own org", async () => {
    const store = await setup();
    const own = await store.create({ ...codex, orgId: "acme" });

    expect(await store.find("acme", own.id)).toEqual(own);
    expect(await store.find("other", own.id)).toBeNull();
  });

  it("holds one connection of a kind per org", async () => {
    const store = await setup();
    await store.create({ ...codex, orgId: "acme" });

    await expect(store.create({ ...codex, orgId: "acme" })).rejects.toThrow();
  });

  it("deletes a connection", async () => {
    const store = await setup();
    const own = await store.create({ ...codex, orgId: "acme" });

    await store.delete(own.id);

    expect(await store.list("acme")).toEqual([]);
  });
});

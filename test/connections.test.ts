import { describe, expect, it } from "vite-plus/test";

import { createConnectionStore } from "@/adapters/connections.ts";
import { openDatabase } from "@/adapters/db.ts";
import * as schema from "@/adapters/schema.ts";

function setup() {
  const db = openDatabase(":memory:");
  const createdAt = new Date();
  db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" }).run();
  db.insert(schema.organization)
    .values([
      { id: "acme", name: "Acme", slug: "acme", kind: "personal", createdAt },
      { id: "other", name: "Other", slug: "other", kind: "personal", createdAt },
    ])
    .run();
  return createConnectionStore(db);
}

const codex = {
  createdBy: "ada",
  provider: "openai",
  authKind: "codex",
  account: "a@example.com",
} as const;

describe("connection store", () => {
  it("lists the org's connections only", () => {
    const store = setup();
    const own = store.create({ ...codex, orgId: "acme" });
    store.create({ ...codex, orgId: "other" });

    expect(store.list("acme")).toEqual([own]);
  });

  it("finds a connection only in its own org", () => {
    const store = setup();
    const own = store.create({ ...codex, orgId: "acme" });

    expect(store.find("acme", own.id)).toEqual(own);
    expect(store.find("other", own.id)).toBeNull();
  });

  it("holds one connection of a kind per org", () => {
    const store = setup();
    store.create({ ...codex, orgId: "acme" });

    expect(() => store.create({ ...codex, orgId: "acme" })).toThrow();
  });

  it("deletes a connection", () => {
    const store = setup();
    const own = store.create({ ...codex, orgId: "acme" });

    store.delete(own.id);

    expect(store.list("acme")).toEqual([]);
  });
});

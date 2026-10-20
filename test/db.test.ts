import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { openDatabase } from "@/adapters/db.ts";

describe("openDatabase", () => {
  it("applies migrations", () => {
    const db = openDatabase(":memory:");
    const table = db.get(
      sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
    );
    expect(table).toEqual({ name: "__drizzle_migrations" });
  });
});

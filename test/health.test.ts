import { describe, expect, it } from "vite-plus/test";

import { openDatabase, pingDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";

const logger = createLogger({ write() {} });

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const db = openDatabase(":memory:");
    const res = await createApp({ logger, pingDatabase: () => pingDatabase(db) }).request(
      "/api/health",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: true });
  });

  it("reports unavailable when the database does not answer", async () => {
    const res = await createApp({ logger, pingDatabase: () => Promise.resolve(false) }).request(
      "/api/health",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: false });
  });
});

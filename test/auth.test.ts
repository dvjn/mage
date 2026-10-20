import { describe, expect, it } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";

const baseUrl = "http://localhost:4783";

describe("/api/auth", () => {
  it("is mounted and issues a mage session cookie", async () => {
    const db = openDatabase(":memory:");
    const logger = createLogger({ write() {} });
    const secret = "test-secret-that-is-long-enough-1234567890";
    const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
    const app = createApp({
      handleAuth: auth.handler,
      identity: createIdentity(auth, db),
      logger,
      pingDatabase: () => Promise.resolve(true),
    });

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct horse battery",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join()).toMatch(/^mage\.session_token=/);
  });
});

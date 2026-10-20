import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";
import type { Identity } from "@/ports/identity.ts";

const handleAuth = () => Promise.resolve(new Response(null, { status: 404 }));
const identity: Identity = {
  resolve: () => Promise.resolve(null),
  profile: () => Promise.reject(new Error("signed out")),
};

describe("request logging", () => {
  it("logs each request with its request id", async () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const app = createApp({
      handleAuth,
      identity,
      logger,
      pingDatabase: () => Promise.resolve(true),
    });

    const res = await app.request("/api/health");

    const reqId = res.headers.get("X-Request-Id");
    expect(reqId).toBeTruthy();
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        msg: "request",
        reqId,
        method: "GET",
        path: "/api/health",
        status: 200,
      }),
    ]);
  });
});

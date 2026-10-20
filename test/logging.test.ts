import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";

describe("request logging", () => {
  it("logs each request with its request id", async () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const app = createApp({ logger, pingDatabase: () => Promise.resolve(true) });

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

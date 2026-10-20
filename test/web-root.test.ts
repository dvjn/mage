import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { createLogger } from "@/adapters/logger.ts";
import { createApp } from "@/http/app.ts";

const webRoot = mkdtempSync(path.join(tmpdir(), "mage-web-"));
mkdirSync(path.join(webRoot, "assets"));
writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Mage</title>");
writeFileSync(path.join(webRoot, "assets/app.js"), "export {};");
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const app = createApp({
  logger: createLogger({ write() {} }),
  pingDatabase: () => Promise.resolve(true),
  webRoot,
});

describe("web client", () => {
  it("serves index.html for a client route", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Mage</title>");
  });

  it("serves an existing asset", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export {};");
  });

  it("does not answer a missing asset with index.html", async () => {
    const res = await app.request("/assets/missing.js");
    expect(res.status).toBe(404);
  });
});

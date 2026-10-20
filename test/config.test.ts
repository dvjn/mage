import { describe, expect, it } from "vite-plus/test";

import { loadConfig } from "@/config.ts";

const valid = { BASE_URL: "http://localhost:4783" };

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    expect(loadConfig(valid)).toMatchObject({ baseUrl: "http://localhost:4783", port: 4783 });
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...valid, PORT: "abc" })).toThrow(/PORT/);
  });

  it("requires BASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/BASE_URL/);
  });

  it("rejects a BASE_URL that is not an http(s) URL", () => {
    expect(() => loadConfig({ BASE_URL: "localhost:4783" })).toThrow(/BASE_URL/);
  });
});

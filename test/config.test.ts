import { describe, expect, it } from "vite-plus/test";

import { loadConfig } from "@/config.ts";

const valid = {
  BASE_URL: "http://localhost:4783",
  AUTH_SECRET: "test-secret-that-is-long-enough-1234567890",
};
const developmentSecret = "mage-development-secret-do-not-use-in-production";

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

  it("requires AUTH_SECRET", () => {
    expect(() => loadConfig({ BASE_URL: "http://localhost:4783" })).toThrow(/AUTH_SECRET/);
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...valid, AUTH_SECRET: "x".repeat(31) })).toThrow(/AUTH_SECRET/);
  });

  it("accepts the development AUTH_SECRET outside production only", () => {
    expect(loadConfig({ ...valid, AUTH_SECRET: developmentSecret }).authSecret).toBe(
      developmentSecret,
    );
    expect(() =>
      loadConfig({ ...valid, AUTH_SECRET: developmentSecret, NODE_ENV: "production" }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("reads AUTH_TRUSTED_ORIGINS as a list of origins", () => {
    expect(
      loadConfig({
        ...valid,
        AUTH_TRUSTED_ORIGINS: "https://a.example/path, http://b.example:8080",
      }).authTrustedOrigins,
    ).toEqual(["https://a.example", "http://b.example:8080"]);
    expect(loadConfig(valid).authTrustedOrigins).toEqual([]);
    expect(() => loadConfig({ ...valid, AUTH_TRUSTED_ORIGINS: "a.example" })).toThrow(
      /AUTH_TRUSTED_ORIGINS/,
    );
  });

  it("rejects auth library variables that would bypass this config", () => {
    expect(() =>
      loadConfig({ ...valid, BETTER_AUTH_TRUSTED_ORIGINS: "https://evil.example" }),
    ).toThrow(/BETTER_AUTH_TRUSTED_ORIGINS/);
  });
});

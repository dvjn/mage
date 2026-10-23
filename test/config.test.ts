import { describe, expect, it } from "vite-plus/test";

import { loadConfig } from "@/config.ts";

const valid = {
  BASE_URL: "http://localhost:4783",
  AUTH_SECRET: "test-secret-that-is-long-enough-1234567890",
  CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const developmentSecret = "mage-development-secret-do-not-use-in-production";
const developmentKey = "bWFnZS1kZXZlbG9wbWVudC1vbmx5LWNyZWRlbnRpYWw=";

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    expect(loadConfig(valid)).toMatchObject({ baseUrl: "http://localhost:4783", port: 4783 });
  });

  it("uses the stand-in model only when asked, and never in production", () => {
    expect(loadConfig(valid).fakeModels).toBe(false);
    expect(loadConfig({ ...valid, MODEL_GATEWAY: "fake" }).fakeModels).toBe(true);
    expect(() => loadConfig({ ...valid, MODEL_GATEWAY: "other" })).toThrow(/MODEL_GATEWAY/);
    expect(() => loadConfig({ ...valid, MODEL_GATEWAY: "fake", NODE_ENV: "production" })).toThrow(
      /MODEL_GATEWAY/,
    );
  });

  it("lets everyone create team orgs unless only the operators may", () => {
    expect(loadConfig(valid)).toMatchObject({ teamOrgs: "everyone", operatorEmails: [] });
    expect(
      loadConfig({ ...valid, TEAM_ORGS: "operator", OPERATOR_EMAILS: " Ada@Example.com, ,b@x.io" }),
    ).toMatchObject({ teamOrgs: "operator", operatorEmails: ["ada@example.com", "b@x.io"] });
    expect(() => loadConfig({ ...valid, TEAM_ORGS: "admins" })).toThrow(/TEAM_ORGS/);
  });

  it("lets everyone sign in with a password unless only the operators may", () => {
    expect(loadConfig(valid).passwordSignIn).toBe("everyone");
    expect(loadConfig({ ...valid, PASSWORD_SIGN_IN: "operator" }).passwordSignIn).toBe("operator");
    expect(() => loadConfig({ ...valid, PASSWORD_SIGN_IN: "admins" })).toThrow(/PASSWORD_SIGN_IN/);
    expect(() => loadConfig({ ...valid, PASSWORD_SIGN_IN: "off" })).toThrow(/PASSWORD_SIGN_IN/);
  });

  it("reads an OpenID Connect provider from all three of its variables, or none", () => {
    const oidc = {
      OIDC_ISSUER: "https://id.example.com/application/o/mage/",
      OIDC_CLIENT_ID: "mage",
      OIDC_CLIENT_SECRET: "s3cret",
    };
    expect(loadConfig(valid).oidc).toBeNull();
    expect(loadConfig({ ...valid, ...oidc }).oidc).toEqual({
      issuer: "https://id.example.com/application/o/mage/",
      clientId: "mage",
      clientSecret: "s3cret",
      name: "SSO",
    });
    expect(loadConfig({ ...valid, ...oidc, OIDC_NAME: "Authentik" }).oidc?.name).toBe("Authentik");
    expect(() => loadConfig({ ...valid, ...oidc, OIDC_CLIENT_SECRET: "" })).toThrow(/together/);
    expect(() => loadConfig({ ...valid, OIDC_CLIENT_ID: "mage" })).toThrow(/together/);
    expect(() => loadConfig({ ...valid, ...oidc, OIDC_ISSUER: "id.example.com" })).toThrow(
      /OIDC_ISSUER/,
    );
    expect(loadConfig({ ...valid, ...oidc, PASSWORD_SIGN_IN: "off" }).passwordSignIn).toBe("off");
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...valid, PORT: "abc" })).toThrow(/PORT/);
  });

  it("defaults LOG_FORMAT to json and rejects unknown formats", () => {
    expect(loadConfig(valid).logFormat).toBe("json");
    expect(loadConfig({ ...valid, LOG_FORMAT: "pretty" }).logFormat).toBe("pretty");
    expect(() => loadConfig({ ...valid, LOG_FORMAT: "text" })).toThrow(/LOG_FORMAT/);
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

  it("reads CREDENTIAL_KEY as 32 bytes", () => {
    expect(loadConfig(valid).credentialKey).toEqual(Buffer.alloc(32, 7));
  });

  it("requires CREDENTIAL_KEY", () => {
    expect(() => loadConfig({ ...valid, CREDENTIAL_KEY: undefined })).toThrow(/CREDENTIAL_KEY/);
  });

  it("rejects a CREDENTIAL_KEY that is not 32 bytes", () => {
    const short = Buffer.alloc(31, 7).toString("base64");
    expect(() => loadConfig({ ...valid, CREDENTIAL_KEY: short })).toThrow(/CREDENTIAL_KEY/);
  });

  it("accepts the development CREDENTIAL_KEY outside production only", () => {
    expect(() => loadConfig({ ...valid, CREDENTIAL_KEY: developmentKey })).not.toThrow();
    expect(() =>
      loadConfig({ ...valid, CREDENTIAL_KEY: developmentKey, NODE_ENV: "production" }),
    ).toThrow(/CREDENTIAL_KEY/);
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

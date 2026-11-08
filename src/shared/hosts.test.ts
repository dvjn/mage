import { describe, expect, it } from "vite-plus/test";

import data from "@/server/models/data/models.json" with { type: "json" };
import { connectionLabel } from "@/shared/connections.ts";
import { HOST_IDS, hostOf, listOf, splitValues } from "@/shared/hosts.ts";
import { MAKER_IDS, MAKERS } from "@/shared/makers.ts";
import { MARKS } from "@/web/icons/marks.ts";

describe("the host registry", () => {
  it.each(HOST_IDS)("gives %s ways to connect whose fields are each named once", (host) => {
    const { methods } = hostOf(host);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods.map((method) => method.id)).size).toBe(methods.length);
    for (const method of methods) {
      const names = method.fields.map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
      for (const field of method.fields) {
        if (field.kind === "choice") expect(field.options?.length).toBeGreaterThan(0);
        if (field.initial && field.options) expect(field.options).toContain(field.initial);
      }
    }
  });

  it("signs in only to Claude and ChatGPT", () => {
    const signIns = HOST_IDS.filter((host) =>
      hostOf(host).methods.some((method) => method.authKind === "oauth"),
    );
    expect(signIns).toEqual(["claude", "codex"]);
  });

  it("has an address for every host whose address is not a field", () => {
    for (const host of HOST_IDS) {
      const { baseUrl, shape, methods } = hostOf(host);
      const given = methods.every((method) =>
        method.fields.some((field) => field.name === "baseUrl" || field.name === "endpoint"),
      );
      if (
        ["openai-compatible", "anthropic", "claude", "openai", "google", "codex"].includes(shape)
      ) {
        expect(baseUrl || given, host).toBeTruthy();
      }
    }
  });

  it("has a vendored mark for every maker and host that names one", () => {
    for (const maker of MAKER_IDS) expect(MARKS[MAKERS[maker].mark], maker).toBeDefined();
    for (const host of HOST_IDS) {
      const { mark } = hostOf(host);
      if (mark) expect(MARKS[mark], host).toBeDefined();
    }
  });

  it("knows models for every host with no list, and only for hosts it has", () => {
    for (const host of Object.keys(data)) expect(HOST_IDS).toContain(host);
    expect(Object.keys(data.perplexity).every((id) => id.startsWith("sonar"))).toBe(true);
    expect(Object.keys(data.vertex).length).toBeGreaterThan(0);
    expect(data.anthropic).toBeDefined();
  });
});

describe("what people fill in to connect", () => {
  it("keeps secrets apart from the settings, with the way it connects", () => {
    const split = splitValues("bedrock", "assume_role", {
      region: "eu-west-1",
      roleArn: " arn:aws:iam::1:role/mage ",
      externalId: "",
      accessKeyId: "AKIA1234",
      secretAccessKey: "s3cret",
    });
    expect(split).toEqual({
      ok: true,
      method: expect.objectContaining({ id: "assume_role", authKind: "cloud" }),
      settings: { method: "assume_role", region: "eu-west-1", roleArn: "arn:aws:iam::1:role/mage" },
      secrets: { accessKeyId: "AKIA1234", secretAccessKey: "s3cret" },
    });
  });

  it("keeps a service account's JSON as a secret, and a server's address without its slash", () => {
    expect(
      splitValues("vertex", "service_account", { serviceAccount: '{"a":1}', location: "global" }),
    ).toMatchObject({ ok: true, secrets: { serviceAccount: '{"a":1}' } });
    expect(splitValues("custom", "endpoint", { baseUrl: "http://llm.local/v1/" })).toMatchObject({
      ok: true,
      settings: { baseUrl: "http://llm.local/v1" },
      secrets: {},
    });
  });

  it.each([
    ["bedrock", "access_keys", { region: "us-east-1", accessKeyId: "A" }, "secret access key"],
    [
      "bedrock",
      "access_keys",
      { region: "mars-1", accessKeyId: "A", secretAccessKey: "B" },
      "region",
    ],
    ["anthropic", "api_key", { apiKey: "sk ant" }, "no spaces"],
    ["custom", "endpoint", { baseUrl: "ftp://x" }, "http or https"],
    ["vertex", "service_account", { serviceAccount: "{", location: "global" }, "not JSON"],
    ["anthropic", "access_keys", { apiKey: "k" }, "no way to connect"],
  ] as const)("refuses %s %s with what is wrong", (host, method, values, said) => {
    const split = splitValues(host, method, values);
    expect(split.ok).toBe(false);
    expect(!split.ok && split.error).toContain(said);
  });

  it("reads typed ids one per line or comma, each once", () => {
    expect(listOf("a, b\n\nc\na")).toEqual(["a", "b", "c"]);
    expect(listOf(undefined)).toEqual([]);
  });
});

describe("how people know a connection", () => {
  it.each([
    [{ host: "codex", authKind: "oauth", label: null }, "ChatGPT"],
    [{ host: "anthropic", authKind: "api_key", label: null }, "Anthropic API key"],
    [{ host: "anthropic", authKind: "api_key", label: "Work" }, "Anthropic · Work"],
    [{ host: "bedrock", authKind: "cloud", label: null }, "Amazon Bedrock"],
    [{ host: "custom", authKind: "endpoint", label: "Lab box" }, "OpenAI-compatible · Lab box"],
  ] as const)("calls %o %s", (connection, label) => {
    expect(connectionLabel(connection)).toBe(label);
  });
});

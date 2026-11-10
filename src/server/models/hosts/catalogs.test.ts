import { generateKeyPairSync } from "node:crypto";

import { decodeJwt } from "jose";
import { describe, expect, it } from "vite-plus/test";

import type { CatalogToken } from "@/server/models/catalog.ts";

import { createBedrockCatalog, createRoleCredentials } from "./amazon-bedrock.ts";
import { createAzureCatalog, createEntraTokens } from "./azure.ts";
import { createGeminiCatalog } from "./google-gemini.ts";
import { createVertexCatalog } from "./google-vertex.ts";
import { chatModels, createCompatibleCatalog } from "./openai-compatible.ts";

type Answer = { status?: number; body?: unknown };

// A fetch that answers each URL from the table, by its start, recording what it was asked; others
// are not found.
function fakeFetch(answers: Record<string, Answer | ((request: Request) => Answer)>) {
  const requests: Request[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const found = Object.entries(answers).find(([url]) => request.url.startsWith(url))?.[1];
    const answer = typeof found === "function" ? found(request) : found;
    if (!answer) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(Response.json(answer.body ?? {}, { status: answer.status ?? 200 }));
  };
  return { fetchFn: fetchFn as typeof fetch, requests };
}

const token = (more: Partial<CatalogToken> = {}): CatalogToken => ({
  access: "",
  accountId: null,
  ...more,
});

describe("an OpenAI-compatible host's list", () => {
  it("reads the host's list with the key, keeping the models that chat with what they say", async () => {
    const { fetchFn, requests } = fakeFetch({
      "https://api.groq.com/openai/v1/models": {
        body: {
          data: [
            { id: "llama-3.3-70b-versatile", owned_by: "Meta", context_window: 131072 },
            { id: "whisper-large-v3", owned_by: "OpenAI" },
            { id: "openai/gpt-oss-120b", owned_by: "OpenAI" },
            { id: "meta-llama/llama-guard-4-12b" },
          ],
        },
      },
    });
    const models = await createCompatibleCatalog("groq", fetchFn).list(token({ access: "gsk_1" }));
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer gsk_1");
    expect(models).toEqual([
      {
        id: "llama-3.3-70b-versatile",
        name: "llama-3.3-70b-versatile",
        contextWindow: 131072,
        maker: "meta",
      },
      // The vendored data adds what the list leaves out.
      {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        maker: "openai",
        contextWindow: expect.any(Number),
        reasoning: true,
      },
    ]);
  });

  it("reads the shapes other hosts answer with", () => {
    // OpenRouter: names, context and whether it can think.
    expect(
      chatModels({
        data: [
          {
            id: "anthropic/claude-sonnet-5",
            name: "Anthropic: Claude Sonnet 5",
            context_length: 1000000,
            supported_parameters: ["tools", "reasoning"],
            architecture: { output_modalities: ["text"] },
          },
          { id: "openai/gpt-image-2", architecture: { output_modalities: ["image"] } },
        ],
      }),
    ).toEqual([
      {
        id: "anthropic/claude-sonnet-5",
        name: "Anthropic: Claude Sonnet 5",
        contextWindow: 1000000,
        reasoning: true,
      },
    ]);
    // Together: a bare list with kinds.
    expect(
      chatModels([
        { id: "meta-llama/Llama-4", display_name: "Llama 4", type: "chat", context_length: 8192 },
        { id: "BAAI/bge", type: "embedding" },
      ]),
    ).toEqual([{ id: "meta-llama/Llama-4", name: "Llama 4", contextWindow: 8192 }]);
    // Cohere: models by name; Mistral: what it can do.
    expect(chatModels({ models: [{ name: "command-a-03-2025", context_length: 256000 }] })).toEqual(
      [{ id: "command-a-03-2025", name: "command-a-03-2025", contextWindow: 256000 }],
    );
    expect(
      chatModels({
        data: [
          {
            id: "mistral-large",
            capabilities: { completion_chat: true },
            max_context_length: 131072,
          },
          { id: "mistral-ocr-latest", capabilities: { completion_chat: false } },
        ],
      }),
    ).toEqual([{ id: "mistral-large", name: "mistral-large", contextWindow: 131072 }]);
    expect(() => chatModels({ nope: [] })).toThrow(/not a list/);
  });

  it("goes to a server's own address, with the ids typed, and with no key when it has none", async () => {
    const { fetchFn, requests } = fakeFetch({
      "http://llm.local:8000/v1/models": { body: { data: [{ id: "qwen3-8b" }] } },
    });
    const models = await createCompatibleCatalog("vllm", fetchFn).list(
      token({ settings: { baseUrl: "http://llm.local:8000/v1", models: "my-tune\nqwen3-8b" } }),
    );
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(models.map((model) => model.id)).toEqual(["qwen3-8b", "my-tune"]);
  });

  it("uses what Mage knows a host serves when its list is missing, and fails otherwise", async () => {
    const { fetchFn } = fakeFetch({});
    const known = await createCompatibleCatalog("perplexity", fetchFn).list(token({ access: "k" }));
    expect(known.map((model) => model.id)).toContain("sonar");
    const fallback = await createCompatibleCatalog("ollama", fetchFn).list(
      token({ settings: { baseUrl: "http://localhost:11434/v1" } }),
    );
    expect(fallback.length).toBeGreaterThan(0);
    await expect(
      createCompatibleCatalog("custom", fetchFn).list(
        token({ settings: { baseUrl: "http://x/v1" } }),
      ),
    ).rejects.toThrow(/404/);
    const refused = fakeFetch({ "https://api.x.ai/v1/models": { status: 401 } });
    await expect(
      createCompatibleCatalog("xai", refused.fetchFn).list(token({ access: "xai-1" })),
    ).rejects.toThrow(/401/);
  });

  it("puts the connection's settings into a host's address, and goes through its proxy", async () => {
    const { fetchFn, requests } = fakeFetch({});
    await createCompatibleCatalog("cloudflare", fetchFn).list(
      token({ access: "cf", settings: { accountId: "abc 1" } }),
    );
    expect(requests[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc%201/ai/v1/models",
    );
    await createCompatibleCatalog("groq", fetchFn)
      .list(
        token({
          access: "k",
          proxy: { baseUrl: "https://proxy.example/v1", headers: { "x-team": "a" } },
        }),
      )
      .catch(() => []);
    expect(requests[1]?.url).toBe("https://proxy.example/v1/models");
    expect(requests[1]?.headers.get("x-team")).toBe("a");
  });
});

describe("the Gemini API's list", () => {
  it("keeps the Gemini and Gemma models that generate content, page by page", async () => {
    const { fetchFn, requests } = fakeFetch({
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=2": {
        body: {
          models: [
            { name: "models/gemma-4-27b-it", supportedGenerationMethods: ["generateContent"] },
          ],
        },
      },
      "https://generativelanguage.googleapis.com/v1beta/models": {
        body: {
          models: [
            {
              name: "models/gemini-3.8-flash",
              displayName: "Gemini 3.8 Flash",
              inputTokenLimit: 1048576,
              supportedGenerationMethods: ["generateContent", "countTokens"],
              thinking: true,
            },
            { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
          ],
          nextPageToken: "2",
        },
      },
    });
    const models = await createGeminiCatalog(fetchFn).list(token({ access: "AIza1" }));
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("AIza1");
    expect(models.map((model) => [model.id, model.name, model.reasoning])).toEqual([
      ["gemini-3.8-flash", "Gemini 3.8 Flash", true],
      ["gemma-4-27b-it", "gemma-4-27b-it", undefined],
    ]);
  });
});

describe("Amazon Bedrock's list", () => {
  const foundation = {
    modelSummaries: [
      {
        modelId: "meta.llama3-70b-instruct-v1:0",
        modelName: "Llama 3 70B Instruct",
        providerName: "Meta",
        inferenceTypesSupported: ["ON_DEMAND"],
        responseStreamingSupported: true,
      },
      {
        modelId: "anthropic.claude-opus-5-5",
        modelName: "Claude Opus 5.5",
        providerName: "Anthropic",
        inferenceTypesSupported: ["INFERENCE_PROFILE"],
      },
      {
        modelId: "amazon.titan-old",
        inferenceTypesSupported: ["ON_DEMAND"],
        modelLifecycle: { status: "LEGACY" },
      },
    ],
  };
  const profiles = {
    inferenceProfileSummaries: [
      {
        inferenceProfileId: "us.anthropic.claude-opus-5-5",
        inferenceProfileName: "US Claude Opus 5.5",
        status: "ACTIVE",
      },
    ],
  };
  const bedrock = "https://bedrock.eu-west-1.amazonaws.com";

  it("lists on-demand models and inference profiles in the region with a Bedrock API key", async () => {
    const { fetchFn, requests } = fakeFetch({
      [`${bedrock}/foundation-models`]: { body: foundation },
      [`${bedrock}/inference-profiles`]: { body: profiles },
    });
    const models = await createBedrockCatalog(fetchFn).list(
      token({ access: "ABSK1", settings: { region: "eu-west-1" } }),
    );
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer ABSK1",
      "Bearer ABSK1",
    ]);
    expect(models.map((model) => [model.id, model.name, model.maker])).toEqual([
      ["meta.llama3-70b-instruct-v1:0", "Llama 3 70B Instruct", "meta"],
      ["us.anthropic.claude-opus-5-5", "US Claude Opus 5.5", undefined],
    ]);
  });

  it("signs with access keys, or with a role's credentials it assumes once", async () => {
    const sts: Request[] = [];
    const { fetchFn, requests } = fakeFetch({
      "https://sts.eu-west-1.amazonaws.com/": (request) => {
        sts.push(request);
        return {
          body: {
            AssumeRoleResponse: {
              AssumeRoleResult: {
                Credentials: {
                  AccessKeyId: "ASIAROLE",
                  SecretAccessKey: "role-secret",
                  SessionToken: "role-session",
                },
              },
            },
          },
        };
      },
      [`${bedrock}/foundation-models`]: { body: foundation },
      [`${bedrock}/inference-profiles`]: { body: profiles },
    });
    const keys = { accessKeyId: "AKIAUSER", secretAccessKey: "user-secret" };
    const catalog = createBedrockCatalog(fetchFn, createRoleCredentials(fetchFn));
    await catalog.list(token({ settings: { region: "eu-west-1" }, secrets: keys }));
    expect(requests[0]?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAUSER\/\d+\/eu-west-1\/bedrock\/aws4_request/,
    );

    const role = { region: "eu-west-1", roleArn: "arn:aws:iam::1:role/mage", externalId: "x1" };
    await catalog.list(token({ settings: role, secrets: keys }));
    await catalog.list(token({ settings: role, secrets: keys }));
    expect(sts).toHaveLength(1);
    expect(await sts[0]?.text()).toContain("RoleArn=arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fmage");
    expect(sts[0]?.headers.get("authorization")).toContain("Credential=AKIAUSER/");
    const listed = requests.filter((request) => request.url.startsWith(bedrock)).at(-1);
    expect(listed?.headers.get("authorization")).toContain("Credential=ASIAROLE/");
    expect(listed?.headers.get("x-amz-security-token")).toBe("role-session");
  });

  it("fails when Bedrock refuses", async () => {
    const { fetchFn } = fakeFetch({ [`${bedrock}/foundation-models`]: { status: 403 } });
    await expect(
      createBedrockCatalog(fetchFn).list(token({ access: "k", settings: { region: "eu-west-1" } })),
    ).rejects.toThrow(/403/);
  });
});

describe("Vertex AI's list", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = JSON.stringify({
    type: "service_account",
    client_email: "mage@acme.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    project_id: "acme",
  });

  it("lists publishers live with the service account, paging and keeping inference ids and metadata", async () => {
    const base = "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers";
    const { fetchFn, requests } = fakeFetch({
      "https://oauth2.googleapis.com/token": { body: { access_token: "ya29", expires_in: 3600 } },
      [`${base}/google/models`]: (request) => ({
        body: new URL(request.url).searchParams.has("pageToken")
          ? {
              publisherModels: [
                { name: "publishers/google/models/gemini-brand-new" },
                { name: "publishers/google/models/gemini-3.8-flash" },
              ],
            }
          : {
              publisherModels: [
                { name: "publishers/google/models/gemini-3.8-flash" },
                { name: "publishers/google/models/imagen-4" },
                { name: "publishers/google/models/gemini-embedding-001" },
                { name: "publishers/google/models/gemini-flash-image" },
                { name: "publishers/google/models/gemini-pro-tts" },
                { name: "publishers/google/models/gemini-live" },
                { name: "publishers/google/models/gemma-4" },
                { name: "publishers/google/models/gemini-private", launchStage: "PRIVATE_PREVIEW" },
              ],
              nextPageToken: "page + 2",
            },
      }),
      [`${base}/anthropic/models`]: {
        body: {
          publisherModels: [{ name: "publishers/anthropic/models/claude-brand-new@20261110" }],
        },
      },
      [`${base}/meta/models`]: {
        body: {
          publisherModels: [
            { name: "publishers/meta/models/llama-4-scout-17b-16e-instruct-maas" },
            {
              name: "publishers/meta/models/llama-self-deploy",
              publisherModelTemplate:
                "projects/{project}/locations/{location}/publishers/meta/models/llama-self-deploy",
            },
          ],
        },
      },
      [`${base}/xai/models`]: {
        body: {
          publisherModels: [
            {
              name: "publishers/xai/models/grok-4.7",
              publisherModelTemplate:
                "projects/{project}/locations/{location}/publishers/xai/models/grok-4.7",
            },
          ],
        },
      },
    });
    const controller = new AbortController();
    const models = await createVertexCatalog(fetchFn).list(
      token({
        settings: { location: "global", models: "my-model" },
        secrets: { serviceAccount: account },
      }),
      controller.signal,
    );
    const assertion = new URLSearchParams(await requests[0]!.text()).get("assertion")!;
    expect(decodeJwt(assertion)).toMatchObject({
      iss: "mage@acme.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
    });
    const ids = models.map((model) => model.id);
    expect(ids).toEqual([
      "gemini-3.8-flash",
      "gemini-brand-new",
      "claude-brand-new@20261110",
      "meta/llama-4-scout-17b-16e-instruct-maas",
      "xai/grok-4.7",
      "my-model",
    ]);
    expect(models[0]?.contextWindow).toBeGreaterThan(0);
    const listed = requests.filter((request) => request.url.startsWith(base));
    expect(listed.every((request) => request.headers.get("authorization") === "Bearer ya29")).toBe(
      true,
    );
    expect(listed.every((request) => request.headers.get("x-goog-user-project") === "acme")).toBe(
      true,
    );
    expect(
      listed.some((request) => new URL(request.url).searchParams.get("pageToken") === "page + 2"),
    ).toBe(true);
    expect(listed[0]?.signal.aborted).toBe(false);
    controller.abort();
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
  });

  it("uses the connection's region and explicit project, and reports listing failures", async () => {
    const base = "https://europe-west4-aiplatform.googleapis.com/v1beta1/publishers";
    for (const answer of [{ status: 403 }, { body: { publisherModels: [{ name: 1 }] } }]) {
      const { fetchFn, requests } = fakeFetch({
        "https://oauth2.googleapis.com/token": { body: { access_token: "ya29" } },
        [`${base}/google/models`]: answer,
      });
      await expect(
        createVertexCatalog(fetchFn).list(
          token({
            settings: { location: "europe-west4", project: "other-project" },
            secrets: { serviceAccount: account },
          }),
        ),
      ).rejects.toThrow(answer.status ? /403/ : /not a list/);
      expect(requests[1]?.headers.get("x-goog-user-project")).toBe("other-project");
    }
  });

  it("refuses a successful token response without a token", async () => {
    const { fetchFn } = fakeFetch({ "https://oauth2.googleapis.com/token": { body: {} } });
    await expect(
      createVertexCatalog(fetchFn).list(
        token({
          secrets: { serviceAccount: account },
        }),
      ),
    ).rejects.toThrow(/no access token/);
  });

  it("refuses a service account Google refuses, and gives Gemini alone in express mode", async () => {
    const { fetchFn } = fakeFetch({ "https://oauth2.googleapis.com/token": { status: 400 } });
    await expect(
      createVertexCatalog(fetchFn).list(token({ secrets: { serviceAccount: account } })),
    ).rejects.toThrow(/refused/);
    const express = await createVertexCatalog(fetchFn).list(token({ access: "AQ.1" }));
    expect(express.length).toBeGreaterThan(0);
    expect(express.every((model) => /^(gemini|gemma)/.test(model.id))).toBe(true);
  });
});

describe("an Azure resource's list", () => {
  const endpoint = "https://acme.openai.azure.com";

  it("is the deployments typed, once the resource takes the key", async () => {
    const { fetchFn, requests } = fakeFetch({
      [`${endpoint}/openai/v1/models`]: { body: { data: [] } },
    });
    const models = await createAzureCatalog(fetchFn).list(
      token({ access: "az-key", settings: { endpoint, models: "gpt-6-sol, claude-prod" } }),
    );
    expect(requests[0]?.headers.get("api-key")).toBe("az-key");
    expect(models.map((model) => model.id)).toEqual(["gpt-6-sol", "claude-prod"]);
    const refused = fakeFetch({ [`${endpoint}/openai/v1/models`]: { status: 401 } });
    await expect(
      createAzureCatalog(refused.fetchFn).list(token({ access: "bad", settings: { endpoint } })),
    ).rejects.toThrow(/401/);
  });

  it("gets an Entra token for an app once, and lists with it", async () => {
    const { fetchFn, requests } = fakeFetch({
      "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token": {
        body: { access_token: "entra-token", expires_in: 3600 },
      },
      [`${endpoint}/openai/v1/models`]: { body: { data: [] } },
    });
    const catalog = createAzureCatalog(fetchFn, createEntraTokens(fetchFn));
    const app = token({
      settings: { endpoint, tenantId: "tenant-1", clientId: "client-1", models: "gpt-6-sol" },
      secrets: { clientSecret: "shh" },
    });
    await catalog.list(app);
    await catalog.list(app);
    const tokens = requests.filter((request) => request.url.includes("login.microsoftonline"));
    expect(tokens).toHaveLength(1);
    expect(await tokens[0]?.text()).toContain(
      "scope=https%3A%2F%2Fcognitiveservices.azure.com%2F.default",
    );
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer entra-token");
  });
});

// Lists the models a Bedrock connection can chat with, from Bedrock's foundation models and its
// inference profiles in the connection's region, and streams replies with the AI SDK's Bedrock
// providers: Claude's from InvokeModel, which takes Anthropic's Messages API, and the others' from
// the Converse API. A connection reaches Bedrock with a Bedrock API key, AWS access keys, or access
// keys that assume a role, whose credentials are kept until shortly before they expire. A
// connection's proxy takes the place of the runtime API for replies, with its headers added; lists
// always come from Bedrock in the region.

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { AwsClient } from "aws4fetch";
import * as z from "zod";

import { described } from "@/server/models/model-data.ts";
import type { Catalog, CatalogModel } from "@/server/models/catalog.ts";
import type { ModelGateway, ModelToken } from "@/server/models/gateway.ts";
import { makerNamed } from "@/shared/makers.ts";

import { type ProviderErrors, streamReply } from "./ai-sdk-stream.ts";
import { anthropicReply } from "./anthropic-api.ts";

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// Role credentials are renewed this long before they expire.
const RENEW_MS = 5 * 60 * 1000;
const ROLE_SECONDS = 3600;

const assumedSchema = z.object({
  AssumeRoleResponse: z.object({
    AssumeRoleResult: z.object({
      Credentials: z.object({
        AccessKeyId: z.string(),
        SecretAccessKey: z.string(),
        SessionToken: z.string(),
      }),
    }),
  }),
});

// Assumes roles with access keys through STS, keeping each role's credentials until shortly before
// they expire.
export function createRoleCredentials(fetchFn: typeof fetch = fetch, now = () => Date.now()) {
  const kept = new Map<string, { until: number; credentials: AwsCredentials }>();
  return async function assume(input: {
    region: string;
    roleArn: string;
    externalId?: string | undefined;
    keys: AwsCredentials;
  }): Promise<AwsCredentials> {
    const key = `${input.keys.accessKeyId}\n${input.roleArn}\n${input.externalId ?? ""}`;
    const found = kept.get(key);
    if (found && found.until > now()) return found.credentials;
    const client = new AwsClient({ ...input.keys, service: "sts", region: input.region });
    const signed = await client.sign(`https://sts.${input.region}.amazonaws.com/`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: "AssumeRole",
        Version: "2011-06-15",
        RoleArn: input.roleArn,
        RoleSessionName: "mage",
        DurationSeconds: String(ROLE_SECONDS),
        ...(input.externalId && { ExternalId: input.externalId }),
      }).toString(),
    });
    const res = await fetchFn(signed);
    if (!res.ok) throw new Error(`assuming the role failed with status ${res.status}`);
    const body = assumedSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new Error("assuming the role gave no credentials");
    const { AccessKeyId, SecretAccessKey, SessionToken } =
      body.data.AssumeRoleResponse.AssumeRoleResult.Credentials;
    const credentials = {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken,
    };
    kept.set(key, { until: now() + ROLE_SECONDS * 1000 - RENEW_MS, credentials });
    return credentials;
  };
}

type Assume = ReturnType<typeof createRoleCredentials>;

// How the connection signs its requests: a Bedrock API key as a bearer token, or AWS credentials,
// its own or a role's.
async function signerOf(token: ModelToken, assume: Assume) {
  const settings = token.settings ?? {};
  const secrets = token.secrets ?? {};
  const region = settings.region ?? "us-east-1";
  if (token.access) return { region, apiKey: token.access };
  const keys = {
    accessKeyId: secrets.accessKeyId ?? "",
    secretAccessKey: secrets.secretAccessKey ?? "",
    ...(secrets.sessionToken && { sessionToken: secrets.sessionToken }),
  };
  if (!keys.accessKeyId || !keys.secretAccessKey) throw new Error("the connection has no keys");
  if (!settings.roleArn) return { region, credentials: keys };
  return {
    region,
    credentials: await assume({
      region,
      roleArn: settings.roleArn,
      externalId: settings.externalId,
      keys,
    }),
  };
}

const foundationSchema = z.object({
  modelSummaries: z.array(
    z.object({
      modelId: z.string().min(1),
      modelName: z.string().optional(),
      providerName: z.string().optional(),
      outputModalities: z.array(z.string()).optional(),
      inferenceTypesSupported: z.array(z.string()).optional(),
      responseStreamingSupported: z.boolean().nullish(),
      modelLifecycle: z.object({ status: z.string() }).optional(),
    }),
  ),
});

const profilesSchema = z.object({
  inferenceProfileSummaries: z.array(
    z.object({
      inferenceProfileId: z.string().min(1),
      inferenceProfileName: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  nextToken: z.string().nullish(),
});

export function createBedrockCatalog(fetchFn: typeof fetch = fetch, assume?: Assume): Catalog {
  const roles = assume ?? createRoleCredentials(fetchFn);
  return {
    async list(token, signal) {
      const signer = await signerOf(token, roles);
      const base = `https://bedrock.${signer.region}.amazonaws.com`;
      const client = signer.credentials
        ? new AwsClient({ ...signer.credentials, service: "bedrock", region: signer.region })
        : null;
      async function get(url: string) {
        const init = { headers: { Accept: "application/json", ...token.proxy?.headers }, signal };
        const res = client
          ? await fetchFn(await client.sign(url, init))
          : await fetchFn(url, {
              ...init,
              headers: { ...init.headers, Authorization: `Bearer ${signer.apiKey}` },
            });
        if (!res.ok) throw new Error(`model list failed with status ${res.status}`);
        return res.json().catch(() => null) as Promise<unknown>;
      }

      const foundation = foundationSchema.safeParse(
        await get(`${base}/foundation-models?byOutputModality=TEXT`),
      );
      if (!foundation.success) throw new Error("model list response is not a list");
      const models: CatalogModel[] = foundation.data.modelSummaries
        .filter(
          (model) =>
            model.inferenceTypesSupported?.includes("ON_DEMAND") &&
            model.responseStreamingSupported !== false &&
            model.modelLifecycle?.status !== "LEGACY",
        )
        .map((model) => {
          const maker = makerNamed(model.providerName?.split(" ")[0]);
          return {
            id: model.modelId,
            name: model.modelName ?? model.modelId,
            ...(maker && { maker }),
          };
        });

      // Models served only through an inference profile, across a geography's regions.
      let next: string | null | undefined;
      do {
        const query = new URLSearchParams({ maxResults: "1000", ...(next && { nextToken: next }) });
        const profiles = profilesSchema.safeParse(
          await get(`${base}/inference-profiles?${query.toString()}`),
        );
        if (!profiles.success) throw new Error("inference profile list is not a list");
        for (const profile of profiles.data.inferenceProfileSummaries) {
          if (profile.status && profile.status !== "ACTIVE") continue;
          models.push({
            id: profile.inferenceProfileId,
            name: profile.inferenceProfileName ?? profile.inferenceProfileId,
          });
        }
        next = profiles.data.nextToken;
      } while (next);
      return models.map((model) => described("bedrock", model));
    },
  };
}

// Bedrock names each request in `x-amzn-requestid`.
export const bedrockErrors: ProviderErrors = {
  explains: (name) => name === "x-amzn-requestid" || name === "x-amzn-errortype",
};

// Bedrock's ids for Claude name its maker, as do inference profiles of it.
function isClaude(model: string) {
  return model.includes("anthropic.");
}

// Replies through Bedrock, the instructions as the system prompt. A model that can think does so at
// the effort asked for. Claude replies through InvokeModel, cached up to its breakpoints and told
// the thread's changes mid-conversation where it takes them; the other models Mage reaches there
// reply through Converse and cache by themselves, if at all.
export function createBedrockGateway(fetchFn: typeof fetch = fetch, assume?: Assume): ModelGateway {
  const roles = assume ?? createRoleCredentials(fetchFn);
  return {
    async *stream(token, request, signal) {
      const signer = await signerOf(token, roles);
      const settings = {
        region: signer.region,
        ...(signer.apiKey
          ? { apiKey: signer.apiKey }
          : // Given as a provider so the environment's credentials are never used instead.
            { credentialProvider: () => Promise.resolve(signer.credentials!) }),
        ...(token.proxy?.baseUrl && { baseURL: token.proxy.baseUrl }),
        headers: { ...token.proxy?.headers },
        fetch: fetchFn,
      };
      if (isClaude(request.model)) {
        const provider = createAmazonBedrockAnthropic(settings);
        yield* anthropicReply(provider(request.model), request, signal, {
          system: request.instructions,
          errors: bedrockErrors,
          platform: "bedrock",
        });
        return;
      }
      yield* streamReply(createAmazonBedrock(settings)(request.model), request, signal, {
        system: request.instructions,
        ...(request.effort && { reasoning: request.effort }),
        errors: bedrockErrors,
      });
    },
  };
}

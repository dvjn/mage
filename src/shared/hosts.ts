// Who serves models: every host Mage connects to, the ways each one connects and the fields each
// way asks for, how its models are listed and replied with, and the makers it serves. The server
// builds its adapters from it, the web client its add-provider dialog, and the update scripts their
// model data and marks. It imports nothing but zod, so every one of them can load it.

import * as z from "zod";

import type { MakerId } from "./makers.ts";

// How a connection proves itself: a key, a subscription sign-in, cloud credentials, or a server's
// address with an optional key.
export const AUTH_KINDS = ["api_key", "oauth", "cloud", "endpoint"] as const;

export type AuthKind = (typeof AUTH_KINDS)[number];

// The API a host is reached through: Anthropic's Messages with a key or with the Claude sign-in,
// OpenAI's Responses, the ChatGPT sign-in's backend, OpenAI-style Chat Completions, or a cloud's
// own.
export type Shape =
  | "anthropic"
  | "claude"
  | "openai"
  | "codex"
  | "openai-compatible"
  | "google"
  | "bedrock"
  | "vertex"
  | "azure";

export type HostGroup = "popular" | "labs" | "clouds" | "self-hosted";

export const HOST_GROUPS: Record<HostGroup, string> = {
  popular: "Popular",
  labs: "Model labs",
  clouds: "Inference clouds",
  "self-hosted": "Self-hosted and custom",
};

export interface Field {
  name: string;
  label: string;
  // A secret is sealed with the connection and never shown again; the rest are its settings.
  // A list is one entry per line or comma, a json field a pasted file, a choice one of `options`.
  kind: "secret" | "text" | "url" | "choice" | "json" | "list";
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: readonly string[];
  // Filled in to start with.
  initial?: string;
  // A secret that is no password, such as an access key's ID, shown as it is typed.
  shown?: boolean;
}

export interface Method {
  // Unique within the host; kept in the connection's settings.
  id: string;
  authKind: AuthKind;
  title: string;
  description: string;
  fields: Field[];
}

export interface Host {
  label: string;
  group: HostGroup;
  // Its mark, by its name in the vendored icon set; none for the generic server mark.
  mark?: string;
  // What its tile says under its name.
  hint: string;
  shape: Shape;
  // The maker of every model it serves, when it serves one maker's.
  maker?: MakerId;
  // The maker's own API, whose badge stays quiet on that maker's models.
  firstParty?: boolean;
  // Where requests go; a server's own address is a field instead.
  baseUrl?: string;
  // Where its model list is, after the base URL or as a full URL; none when it has no list, and its
  // models come from the vendored model data and the ids people type.
  models?: string;
  // The LiteLLM providers whose entries describe its models in the vendored model data, and, where
  // those name models it no longer serves, the ids it still does.
  litellm?: readonly string[];
  serves?: RegExp;
  // A small model it names threads with, when its list has it.
  titleModel?: string;
  methods: Method[];
}

const apiKey = (placeholder?: string): Field => ({
  name: "apiKey",
  label: "API key",
  kind: "secret",
  required: true,
  ...(placeholder && { placeholder }),
  description:
    "Checked by listing its models where it can be, then kept sealed and never shown again.",
});

const keyMethod = (placeholder?: string, description = "Billed per token."): Method => ({
  id: "api_key",
  authKind: "api_key",
  title: "API key",
  description,
  fields: [apiKey(placeholder)],
});

const typedModels = (description: string, required = false): Field => ({
  name: "models",
  label: "Model ids",
  kind: "list",
  required,
  placeholder: "One per line",
  description,
});

// A server of one's own: its address, and a key when it asks for one.
const endpointMethod = (baseUrl: string): Method => ({
  id: "endpoint",
  authKind: "endpoint",
  title: "Server",
  description: "Its address, and a key if it asks for one.",
  fields: [
    {
      name: "baseUrl",
      label: "Base URL",
      kind: "url",
      required: true,
      initial: baseUrl,
      placeholder: baseUrl || "https://llm.example.com/v1",
      description: "Where its OpenAI-style API is, as reached from the Mage server.",
    },
    {
      name: "apiKey",
      label: "API key",
      kind: "secret",
      placeholder: "Optional",
      description: "Sent as a bearer token; kept sealed and never shown again.",
    },
    typedModels("Added to what its model list says, or used when it has none."),
  ],
});

// An OpenAI-style host with a key, its model list at `/models` unless said otherwise.
function compatible(
  label: string,
  group: HostGroup,
  baseUrl: string,
  more: Partial<Host> & { placeholder?: string } = {},
): Host {
  const { placeholder, ...rest } = more;
  return {
    label,
    group,
    hint: "API key",
    shape: "openai-compatible",
    baseUrl,
    models: "/models",
    methods: [keyMethod(placeholder)],
    ...rest,
  };
}

// A server people run themselves, at an address they give.
function selfHosted(label: string, baseUrl: string, more: Partial<Host> = {}): Host {
  return {
    label,
    group: "self-hosted",
    hint: "Server address",
    shape: "openai-compatible",
    models: "/models",
    methods: [endpointMethod(baseUrl)],
    ...more,
  };
}

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "sa-east-1",
] as const;

const awsRegion: Field = {
  name: "region",
  label: "Region",
  kind: "choice",
  required: true,
  options: AWS_REGIONS,
  initial: "us-east-1",
};

const awsKeys: Field[] = [
  {
    name: "accessKeyId",
    label: "Access key ID",
    kind: "secret",
    required: true,
    placeholder: "AKIA",
  },
  { name: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
];

const vertexLocation: Field = {
  name: "location",
  label: "Location",
  kind: "text",
  required: true,
  initial: "global",
  placeholder: "global",
  description: "global, or a region such as us-east5 for models served in one region only.",
};

export const HOSTS = {
  anthropic: {
    label: "Anthropic",
    group: "popular",
    mark: "anthropic",
    hint: "API key",
    shape: "anthropic",
    maker: "anthropic",
    firstParty: true,
    baseUrl: "https://api.anthropic.com/v1",
    models: "/models",
    litellm: ["anthropic"],
    titleModel: "claude-haiku-5-5",
    methods: [keyMethod("sk-ant-", "Billed per token by Anthropic.")],
  },
  claude: {
    label: "Claude",
    group: "popular",
    mark: "claude",
    hint: "Sign in",
    shape: "claude",
    maker: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: "/models",
    titleModel: "claude-haiku-5-5",
    methods: [
      {
        id: "sign_in",
        authKind: "oauth",
        title: "Sign in with Claude",
        description: "Billed to your Claude plan's extra usage.",
        fields: [],
      },
    ],
  },
  openai: {
    label: "OpenAI",
    group: "popular",
    mark: "openai",
    hint: "API key",
    shape: "openai",
    maker: "openai",
    firstParty: true,
    baseUrl: "https://api.openai.com/v1",
    models: "/models",
    litellm: ["openai"],
    titleModel: "gpt-6-luna",
    methods: [keyMethod("sk-", "Billed per token by OpenAI.")],
  },
  codex: {
    label: "ChatGPT",
    group: "popular",
    mark: "codex",
    hint: "Sign in",
    shape: "codex",
    maker: "openai",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    models: "/models",
    titleModel: "gpt-6-luna",
    methods: [
      {
        id: "sign_in",
        authKind: "oauth",
        title: "Sign in with ChatGPT",
        description: "Uses your ChatGPT plan.",
        fields: [],
      },
    ],
  },
  openrouter: compatible("OpenRouter", "popular", "https://openrouter.ai/api/v1", {
    mark: "openrouter",
    placeholder: "sk-or-",
  }),
  google: {
    label: "Gemini API",
    group: "popular",
    mark: "aistudio",
    hint: "API key",
    shape: "google",
    maker: "google",
    firstParty: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: "/models",
    litellm: ["gemini"],
    titleModel: "gemini-flash-lite-latest",
    methods: [keyMethod("AIza", "A Google AI Studio key, billed per token by Google.")],
  },
  bedrock: {
    label: "Amazon Bedrock",
    group: "popular",
    mark: "bedrock",
    hint: "AWS credentials",
    shape: "bedrock",
    litellm: ["bedrock_converse", "bedrock"],
    methods: [
      {
        id: "api_key",
        authKind: "api_key",
        title: "Bedrock API key",
        description: "A key made in the Bedrock console.",
        fields: [awsRegion, apiKey("ABSK")],
      },
      {
        id: "access_keys",
        authKind: "cloud",
        title: "Access keys",
        description: "An IAM user's or a session's keys.",
        fields: [
          awsRegion,
          ...awsKeys,
          {
            name: "sessionToken",
            label: "Session token",
            kind: "secret",
            placeholder: "Optional",
            description: "For temporary keys; they stop working when the session ends.",
          },
        ],
      },
      {
        id: "assume_role",
        authKind: "cloud",
        title: "Assume a role",
        description: "Keys that assume an IAM role, renewed as they expire.",
        fields: [
          awsRegion,
          {
            name: "roleArn",
            label: "Role ARN",
            kind: "text",
            required: true,
            placeholder: "arn:aws:iam::123456789012:role/mage",
          },
          { name: "externalId", label: "External ID", kind: "text", placeholder: "Optional" },
          ...awsKeys,
        ],
      },
    ],
  },
  vertex: {
    label: "Vertex AI",
    group: "popular",
    mark: "vertexai",
    hint: "Google Cloud credentials",
    shape: "vertex",
    litellm: [
      "vertex_ai",
      "vertex_ai-language-models",
      "vertex_ai-anthropic_models",
      "vertex_ai-ai21_models",
      "vertex_ai-deepseek_models",
      "vertex_ai-llama_models",
      "vertex_ai-minimax_models",
      "vertex_ai-mistral_models",
      "vertex_ai-moonshot_models",
      "vertex_ai-openai_models",
      "vertex_ai-qwen_models",
      "vertex_ai-zai_models",
    ],
    methods: [
      {
        id: "service_account",
        authKind: "cloud",
        title: "Service account",
        description: "Gemini and the partner models enabled in Model Garden.",
        fields: [
          {
            name: "serviceAccount",
            label: "Service account key",
            kind: "json",
            required: true,
            placeholder: '{ "type": "service_account", … }',
            description: "The key file's JSON; kept sealed and never shown again.",
          },
          {
            name: "project",
            label: "Project",
            kind: "text",
            placeholder: "The key's project",
          },
          vertexLocation,
          typedModels("Added to the models listed by Vertex AI's Model Garden."),
        ],
      },
      {
        id: "api_key",
        authKind: "api_key",
        title: "API key",
        description: "Express mode, for Gemini models.",
        fields: [apiKey("AQ."), typedModels("Added to the Gemini models Mage knows.")],
      },
    ],
  },
  azure: {
    label: "Azure OpenAI",
    group: "popular",
    mark: "azure",
    hint: "Deployments",
    shape: "azure",
    litellm: ["azure", "azure_ai"],
    methods: [
      {
        id: "api_key",
        authKind: "api_key",
        title: "API key",
        description: "A key of an Azure OpenAI or Foundry resource.",
        fields: [
          {
            name: "endpoint",
            label: "Endpoint",
            kind: "url",
            required: true,
            placeholder: "https://my-resource.openai.azure.com",
          },
          apiKey(),
          typedModels("Deployment names, as named in the resource.", true),
        ],
      },
      {
        id: "entra",
        authKind: "cloud",
        title: "Microsoft Entra ID",
        description: "An app registration with access to the resource.",
        fields: [
          {
            name: "endpoint",
            label: "Endpoint",
            kind: "url",
            required: true,
            placeholder: "https://my-resource.openai.azure.com",
          },
          { name: "tenantId", label: "Tenant ID", kind: "text", required: true },
          { name: "clientId", label: "Client ID", kind: "text", required: true },
          { name: "clientSecret", label: "Client secret", kind: "secret", required: true },
          typedModels("Deployment names, as named in the resource.", true),
        ],
      },
    ],
  },

  xai: compatible("xAI", "labs", "https://api.x.ai/v1", {
    mark: "xai",
    maker: "xai",
    firstParty: true,
    litellm: ["xai"],
    placeholder: "xai-",
  }),
  mistral: compatible("Mistral", "labs", "https://api.mistral.ai/v1", {
    mark: "mistral",
    maker: "mistral",
    firstParty: true,
    litellm: ["mistral", "codestral"],
  }),
  deepseek: compatible("DeepSeek", "labs", "https://api.deepseek.com", {
    mark: "deepseek",
    maker: "deepseek",
    firstParty: true,
    litellm: ["deepseek"],
    placeholder: "sk-",
  }),
  moonshot: compatible("Moonshot AI", "labs", "https://api.moonshot.ai/v1", {
    mark: "moonshot",
    maker: "moonshot",
    firstParty: true,
    litellm: ["moonshot"],
    placeholder: "sk-",
  }),
  zai: compatible("Z.ai", "labs", "https://api.z.ai/api/paas/v4", {
    mark: "zai",
    maker: "zhipu",
    firstParty: true,
    litellm: ["zai"],
  }),
  alibaba: compatible(
    "Alibaba Model Studio",
    "labs",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    { mark: "alibabacloud", litellm: ["dashscope"], placeholder: "sk-" },
  ),
  cohere: compatible("Cohere", "labs", "https://api.cohere.ai/compatibility/v1", {
    mark: "cohere",
    maker: "cohere",
    firstParty: true,
    models: "https://api.cohere.com/v1/models?endpoint=chat",
    litellm: ["cohere_chat"],
  }),
  perplexity: compatible("Perplexity", "labs", "https://api.perplexity.ai", {
    mark: "perplexity",
    maker: "perplexity",
    firstParty: true,
    models: undefined,
    litellm: ["perplexity"],
    serves: /^sonar/,
    methods: [
      {
        ...keyMethod("pplx-"),
        fields: [apiKey("pplx-"), typedModels("Added to the Sonar models Mage knows.")],
      },
    ],
  }),
  minimax: compatible("MiniMax", "labs", "https://api.minimax.io/v1", {
    mark: "minimax",
    maker: "minimax",
    firstParty: true,
    litellm: ["minimax"],
  }),

  groq: compatible("Groq", "clouds", "https://api.groq.com/openai/v1", {
    mark: "groq",
    litellm: ["groq"],
    placeholder: "gsk_",
  }),
  together: compatible("Together AI", "clouds", "https://api.together.xyz/v1", {
    mark: "together",
    litellm: ["together_ai"],
  }),
  fireworks: compatible("Fireworks", "clouds", "https://api.fireworks.ai/inference/v1", {
    mark: "fireworks",
    litellm: ["fireworks_ai"],
    placeholder: "fw_",
  }),
  cerebras: compatible("Cerebras", "clouds", "https://api.cerebras.ai/v1", {
    mark: "cerebras",
    litellm: ["cerebras"],
    placeholder: "csk-",
  }),
  deepinfra: compatible("DeepInfra", "clouds", "https://api.deepinfra.com/v1/openai", {
    mark: "deepinfra",
    litellm: ["deepinfra"],
  }),
  huggingface: compatible("Hugging Face", "clouds", "https://router.huggingface.co/v1", {
    mark: "huggingface",
    placeholder: "hf_",
  }),
  cloudflare: {
    ...compatible(
      "Cloudflare Workers AI",
      "clouds",
      "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
      { mark: "workersai", litellm: ["cloudflare"] },
    ),
    hint: "API token",
    methods: [
      {
        id: "api_key",
        authKind: "api_key",
        title: "API token",
        description: "A token with Workers AI read access.",
        fields: [
          { name: "accountId", label: "Account ID", kind: "text", required: true },
          { ...apiKey(), label: "API token" },
        ],
      },
    ],
  },
  vercel: compatible("Vercel AI Gateway", "clouds", "https://ai-gateway.vercel.sh/v1", {
    mark: "vercel",
    litellm: ["vercel_ai_gateway"],
  }),
  nvidia: compatible("NVIDIA NIM", "clouds", "https://integrate.api.nvidia.com/v1", {
    mark: "nvidia",
    placeholder: "nvapi-",
  }),
  sambanova: compatible("SambaNova", "clouds", "https://api.sambanova.ai/v1", {
    mark: "sambanova",
    litellm: ["sambanova"],
  }),
  nebius: compatible("Nebius", "clouds", "https://api.studio.nebius.com/v1", {
    mark: "nebius",
    litellm: ["nebius"],
  }),
  novita: compatible("Novita AI", "clouds", "https://api.novita.ai/v3/openai", {
    mark: "novita",
    litellm: ["novita"],
  }),
  hyperbolic: compatible("Hyperbolic", "clouds", "https://api.hyperbolic.xyz/v1", {
    mark: "hyperbolic",
    litellm: ["hyperbolic"],
  }),
  baseten: compatible("Baseten", "clouds", "https://inference.baseten.co/v1", {
    mark: "baseten",
    litellm: ["baseten"],
  }),
  siliconflow: compatible("SiliconFlow", "clouds", "https://api.siliconflow.com/v1", {
    mark: "siliconcloud",
    placeholder: "sk-",
  }),
  github: compatible("GitHub Models", "clouds", "https://models.github.ai/inference", {
    mark: "github",
    hint: "Personal access token",
    models: "https://models.github.ai/catalog/models",
    methods: [
      {
        ...keyMethod("github_pat_", "A token with the models scope."),
        title: "Personal access token",
        fields: [{ ...apiKey("github_pat_"), label: "Token" }],
      },
    ],
  }),

  ollama: selfHosted("Ollama", "http://localhost:11434/v1", {
    mark: "ollama",
    litellm: ["ollama"],
  }),
  lmstudio: selfHosted("LM Studio", "http://localhost:1234/v1", { mark: "lmstudio" }),
  vllm: selfHosted("vLLM", "http://localhost:8000/v1", { mark: "vllm" }),
  litellm: selfHosted("LiteLLM", "http://localhost:4000/v1"),
  custom: selfHosted("OpenAI-compatible", ""),
} satisfies Record<string, Host>;

export type HostId = keyof typeof HOSTS;

export const HOST_IDS = Object.keys(HOSTS) as HostId[];

export const hostIdSchema = z.enum(HOST_IDS as [HostId, ...HostId[]]);

export function isHost(id: string): id is HostId {
  return Object.hasOwn(HOSTS, id);
}

// The host by id, typed as any host.
export function hostOf(id: HostId): Host {
  return HOSTS[id];
}

// The host's way of connecting with this id, or its only one of the auth kind.
export function methodOf(host: HostId, id: string | undefined, authKind?: AuthKind) {
  const { methods } = hostOf(host);
  return (
    methods.find((method) => method.id === id) ??
    methods.find((method) => method.authKind === authKind) ??
    null
  );
}

// The ids people typed in a list field: one per line or comma, each once.
export function listOf(value: string | undefined) {
  return [
    ...new Set(
      (value ?? "")
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

// What people fill in for a way of connecting, checked against its fields: the secrets apart from
// the settings, and the method's id among the settings. Says which field is wrong when one is.
export function splitValues(
  host: HostId,
  methodId: string,
  values: Record<string, string>,
):
  | { ok: true; method: Method; settings: Record<string, string>; secrets: Record<string, string> }
  | { ok: false; error: string } {
  const method = methodOf(host, methodId);
  if (!method || method.id !== methodId) {
    return { ok: false, error: `${hostOf(host).label} has no way to connect called ${methodId}` };
  }
  const settings: Record<string, string> = { method: method.id };
  const secrets: Record<string, string> = {};
  for (const field of method.fields) {
    const value = (values[field.name] ?? "").trim();
    if (!value) {
      if (field.required) return { ok: false, error: `Give the ${field.label.toLowerCase()}` };
      continue;
    }
    if (value.length > (field.kind === "json" || field.kind === "list" ? 20000 : 2000)) {
      return { ok: false, error: `The ${field.label.toLowerCase()} is too long` };
    }
    if (field.kind === "secret" && /\s/.test(value)) {
      return { ok: false, error: `The ${field.label.toLowerCase()} has no spaces` };
    }
    if (field.kind === "url" && !["http:", "https:"].includes(URL.parse(value)?.protocol ?? "")) {
      return { ok: false, error: `The ${field.label.toLowerCase()} must be an http or https URL` };
    }
    if (field.kind === "choice" && !field.options?.includes(value)) {
      return { ok: false, error: `Choose a ${field.label.toLowerCase()}` };
    }
    if (field.kind === "json") {
      try {
        JSON.parse(value);
      } catch {
        return { ok: false, error: `The ${field.label.toLowerCase()} is not JSON` };
      }
    }
    const kept = field.kind === "url" ? value.replace(/\/+$/, "") : value;
    if (field.kind === "secret" || field.kind === "json") secrets[field.name] = kept;
    else settings[field.name] = kept;
  }
  return { ok: true, method, settings, secrets };
}

// A connection to add: the host, the way it connects, its fields' values, an optional label, and
// the proxy its requests go through, if any, given as the proxy body with every value.
export const connectionInputSchema = z.object({
  host: hostIdSchema,
  method: z.string().min(1),
  label: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((label) => label || null),
  values: z.record(z.string(), z.string().max(20000)),
  proxy: z.unknown().optional(),
});

// A change of a connection: another of its host's ways to connect, a new label, and the values
// given; a value left out keeps the stored one, as does a secret left blank.
export const connectionChangeSchema = z.object({
  method: z.string().min(1).optional(),
  label: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .transform((label) => label || null)
    .optional(),
  values: z.record(z.string(), z.string().max(20000)).default({}),
});

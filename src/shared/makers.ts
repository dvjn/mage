// Who makes a model, as opposed to who serves it, and how to tell from what a host says about the
// model or from its id. Shared by the server, the web client and the update scripts, so all of them
// agree; it imports nothing.

export const MAKER_IDS = [
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "xai",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "cohere",
  "amazon",
  "microsoft",
  "nvidia",
  "minimax",
  "perplexity",
  "ai21",
  "ibm",
  "tencent",
  "baidu",
  "bytedance",
  "xiaomi",
  "stepfun",
  "reka",
  "liquid",
  "inception",
  "arcee",
  "nous",
  "ai2",
] as const;

export type MakerId = (typeof MAKER_IDS)[number];

export interface Maker {
  label: string;
  // The mark its models show, by its name in the vendored icon set: the product's where it has one.
  mark: string;
  // How its models' ids start, tried on the id's last segment.
  pattern: RegExp;
  // Other names hosts give it, as the first segment of an id or in their metadata.
  aliases?: string[];
}

export const MAKERS: Record<MakerId, Maker> = {
  anthropic: { label: "Anthropic", mark: "claude", pattern: /^claude/ },
  openai: {
    label: "OpenAI",
    mark: "openai",
    pattern: /^(gpt-|o\d|chatgpt|codex|text-davinci)/,
    aliases: ["azure-openai"],
  },
  google: { label: "Google", mark: "gemini", pattern: /^(gemini|gemma|learnlm)/ },
  meta: {
    label: "Meta",
    mark: "meta",
    pattern: /^(llama|meta-llama|muse)/,
    aliases: ["meta-llama"],
  },
  mistral: {
    label: "Mistral",
    mark: "mistral",
    pattern: /^(mistral|mixtral|codestral|magistral|devstral|ministral|pixtral|voxtral)/,
    aliases: ["mistralai"],
  },
  xai: { label: "xAI", mark: "grok", pattern: /^grok/, aliases: ["x-ai"] },
  deepseek: { label: "DeepSeek", mark: "deepseek", pattern: /^deepseek/, aliases: ["deepseek-ai"] },
  qwen: { label: "Qwen", mark: "qwen", pattern: /^(qwen|qwq|qvq)/, aliases: ["alibaba", "qwen"] },
  moonshot: {
    label: "Moonshot AI",
    mark: "kimi",
    pattern: /^(kimi|moonshot)/,
    aliases: ["moonshotai"],
  },
  zhipu: {
    label: "Z.ai",
    mark: "zai",
    pattern: /^(glm|chatglm)/,
    aliases: ["z-ai", "zai", "zai-org", "thudm"],
  },
  cohere: {
    label: "Cohere",
    mark: "cohere",
    pattern: /^(command|c4ai|aya)/,
    aliases: ["coherelabs"],
  },
  amazon: { label: "Amazon", mark: "nova", pattern: /^(nova|titan)/ },
  microsoft: { label: "Microsoft", mark: "microsoft", pattern: /^(phi-|mai-)/ },
  nvidia: { label: "NVIDIA", mark: "nvidia", pattern: /^(nemotron|nvidia)/ },
  minimax: {
    label: "MiniMax",
    mark: "minimax",
    pattern: /^(minimax|abab)/,
    aliases: ["minimaxai"],
  },
  perplexity: { label: "Perplexity", mark: "perplexity", pattern: /^(sonar|r1-1776)/ },
  ai21: { label: "AI21", mark: "ai21", pattern: /^(jamba|j2-)/, aliases: ["ai21labs"] },
  ibm: { label: "IBM", mark: "ibm", pattern: /^granite/, aliases: ["ibm-granite"] },
  tencent: { label: "Tencent", mark: "hunyuan", pattern: /^(hunyuan|hy-)/ },
  baidu: { label: "Baidu", mark: "wenxin", pattern: /^ernie/ },
  bytedance: {
    label: "ByteDance",
    mark: "doubao",
    pattern: /^(doubao|seed-|ui-tars)/,
    aliases: ["bytedance-seed"],
  },
  xiaomi: { label: "Xiaomi", mark: "xiaomimimo", pattern: /^mimo/, aliases: ["xiaomimimo"] },
  stepfun: { label: "StepFun", mark: "stepfun", pattern: /^step-/, aliases: ["stepfun-ai"] },
  reka: { label: "Reka", mark: "reka", pattern: /^reka/, aliases: ["rekaai"] },
  liquid: { label: "Liquid AI", mark: "liquid", pattern: /^lfm/, aliases: ["liquidai"] },
  inception: { label: "Inception", mark: "inception", pattern: /^mercury/ },
  arcee: { label: "Arcee AI", mark: "arcee", pattern: /^(arcee|afm-)/, aliases: ["arcee-ai"] },
  nous: {
    label: "Nous Research",
    mark: "nousresearch",
    pattern: /^hermes/,
    aliases: ["nousresearch"],
  },
  ai2: { label: "Ai2", mark: "ai2", pattern: /^(olmo|tulu|molmo)/, aliases: ["allenai"] },
};

// Each maker by its id and by the other names hosts give it.
const BY_NAME = new Map<string, MakerId>(
  MAKER_IDS.flatMap((id) => [id, ...(MAKERS[id].aliases ?? [])].map((name) => [name, id])),
);

export function isMaker(name: string): name is MakerId {
  return Object.hasOwn(MAKERS, name);
}

// A maker by any name hosts give it, or null.
export function makerNamed(name: string | null | undefined): MakerId | null {
  return (name && BY_NAME.get(name.toLowerCase())) || null;
}

// A Bedrock model or inference profile id: an optional geography, then the maker, as in
// `us.anthropic.claude-…` or `meta.llama3-…`.
const BEDROCK_ID = /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?([a-z0-9-]+)\.[a-z0-9]/;

// What makes it, from what the host said (its own name for the maker, given as `maker`), else the
// id's first segment where the host gives ids as `maker/model` or Bedrock's `maker.model`, else the
// one maker a host serves, else the id's last segment's pattern; null when none of them says.
export function makerOf(
  host: { maker?: MakerId | null | undefined } | null,
  modelId: string,
  meta?: { maker?: string | null },
): MakerId | null {
  const said = makerNamed(meta?.maker);
  if (said) return said;
  const id = modelId
    .toLowerCase()
    .replace(/^@(cf|hf)\//, "")
    .replace(/^accounts\/[^/]+\/models\//, "");
  const segments = id.split("/");
  if (segments.length > 1) {
    const named = makerNamed(segments[0]);
    if (named) return named;
  }
  const bedrock = segments.length === 1 ? makerNamed(BEDROCK_ID.exec(id)?.[1]) : null;
  if (bedrock) return bedrock;
  if (host?.maker) return host.maker;
  const last = segments.at(-1)!;
  // Open-weight GPT models are OpenAI's wherever they are served.
  if (last.startsWith("gpt-oss")) return "openai";
  return MAKER_IDS.find((maker) => MAKERS[maker].pattern.test(last)) ?? null;
}

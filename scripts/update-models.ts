// Refreshes the vendored model data from LiteLLM's model map: the chat models of the hosts Mage
// connects to, by host and by the id the host knows them by, each with its context window and
// whether it can think. Refuses a result that is empty or lost much of what was there, and records
// where the map came from in the licence beside the data.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HOST_IDS, type HostId, hostOf } from "../src/shared/hosts.ts";

const SOURCE_REPO = "BerriAI/litellm";
const SOURCE_FILE = "model_prices_and_context_window.json";
const DATA = path.join(import.meta.dirname, "../src/server/models/data/models.json");
const LICENSE = path.join(import.meta.dirname, "../src/server/models/data/LICENSE");

// What Mage uses of a model.
export interface ModelData {
  contextWindow?: number;
  reasoning?: true;
}

export type Vendored = Partial<Record<HostId, Record<string, ModelData>>>;

interface Entry {
  litellm_provider?: unknown;
  mode?: unknown;
  max_input_tokens?: unknown;
  supports_reasoning?: unknown;
  deprecation_date?: unknown;
}

// Providers whose ids carry a region or route after their prefix, which their hosts never take.
const ONE_SEGMENT = new Set(["bedrock", "bedrock_converse", "azure", "azure_ai"]);

// The id a host knows an entry by: without LiteLLM's route prefix, or null when the entry is not
// one the host takes.
export function hostModelId(key: string, provider: string) {
  const [first, ...rest] = key.split("/");
  const routed =
    rest.length > 0 && (first === provider || provider.startsWith(first!) || first === "converse");
  const id = routed ? rest.join("/") : key;
  if (!id || id.startsWith("ft:")) return null;
  if (ONE_SEGMENT.has(provider) && id.includes("/")) return null;
  // LiteLLM's price tiers by model size, which no host serves by that name.
  if (/^[a-z]+-ai-(up-to-)?[\d.]+b(-[\d.]+b)?$/.test(id)) return null;
  return id;
}

// The vendored data from LiteLLM's map: each host's chat models still served on `today`.
export function modelData(upstream: unknown, today: string): Vendored {
  if (!upstream || typeof upstream !== "object") throw new Error("The model map is not an object");
  const result: Vendored = {};
  for (const host of HOST_IDS) {
    const { litellm, serves } = hostOf(host);
    if (!litellm) continue;
    const models: Record<string, ModelData> = {};
    for (const [key, value] of Object.entries(upstream as Record<string, Entry>)) {
      // The map's first entry describes the others.
      if (key === "sample_spec") continue;
      if (!value || typeof value !== "object" || value.mode !== "chat") continue;
      const provider = value.litellm_provider;
      if (typeof provider !== "string" || !litellm.includes(provider)) continue;
      if (typeof value.deprecation_date === "string" && value.deprecation_date < today) continue;
      const id = hostModelId(key, provider);
      if (!id || (serves && !serves.test(id))) continue;
      const known = models[id] ?? {};
      const contextWindow = known.contextWindow ?? value.max_input_tokens;
      models[id] = {
        ...(typeof contextWindow === "number" && contextWindow > 0 && { contextWindow }),
        ...((known.reasoning || value.supports_reasoning === true) && { reasoning: true as const }),
      };
    }
    if (Object.keys(models).length > 0) result[host] = models;
  }
  return result;
}

function count(data: Vendored) {
  return Object.values(data).reduce((sum, models) => sum + Object.keys(models).length, 0);
}

// Why the new data must not replace the old: it is empty, a host that had models has none, or it
// has less than four fifths of the models it had; null when it may.
export function refusal(previous: Vendored | null, next: Vendored): string | null {
  if (count(next) === 0) return "Refusing to vendor empty model data.";
  if (!previous) return null;
  const lost = (Object.keys(previous) as HostId[]).filter((host) => !next[host]);
  if (lost.length > 0)
    return `Refusing to vendor model data with no models for ${lost.join(", ")}.`;
  if (count(next) < count(previous) * 0.8) {
    return `Refusing to vendor ${count(next)} models where there were ${count(previous)}.`;
  }
  return null;
}

// JSON with every object's keys in order, so each refresh changes only what changed.
export function sortedJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, inner: unknown) =>
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : 1)))
        : inner,
    2,
  )}\n`;
}

// The licence with the source's commit, digest and the day it was read.
export function stampLicense(license: string, commit: string, sha256: string, retrieved: string) {
  return license
    .replace(/^Upstream commit: .*$/m, `Upstream commit: ${commit}`)
    .replace(/^Upstream sha256: .*$/m, `Upstream sha256: ${sha256}`)
    .replace(/^Retrieved:       .*$/m, `Retrieved:       ${retrieved}`);
}

async function main() {
  const commitRes = await fetch(
    `https://api.github.com/repos/${SOURCE_REPO}/commits/main?path=${SOURCE_FILE}`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!commitRes.ok) throw new Error(`Reading the source commit failed: ${commitRes.status}`);
  const { sha: commit } = (await commitRes.json()) as { sha: string };
  const res = await fetch(
    `https://raw.githubusercontent.com/${SOURCE_REPO}/${commit}/${SOURCE_FILE}`,
  );
  if (!res.ok) throw new Error(`Downloading the model map failed: ${res.status}`);
  const body = await res.text();
  const today = new Date().toISOString().slice(0, 10);
  const next = modelData(JSON.parse(body), today);
  let previous: Vendored | null = null;
  try {
    previous = JSON.parse(readFileSync(DATA, "utf8")) as Vendored;
  } catch {
    // None yet.
  }
  const refused = refusal(previous, next);
  if (refused) throw new Error(refused);
  writeFileSync(DATA, sortedJson(next));
  const sha256 = createHash("sha256").update(body).digest("hex");
  writeFileSync(LICENSE, stampLicense(readFileSync(LICENSE, "utf8"), commit, sha256, today));
  console.log(`Models: ${count(next)} across ${Object.keys(next).length} hosts`);
}

if (import.meta.main) await main();

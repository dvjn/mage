/// <reference types="vite-plus/client" />

// The skills that ship with the product, as one source every org has. Their text is bundled into
// the server from the builtin/ folder, so nothing is read from disk at runtime and nothing is
// stored: only the switches on them are, by the ids given here. They are listed first so a skill
// of the same name written or added by an org or a space replaces one.

import { discoverSkills } from "./discovery.ts";
import type { Skill, SkillSource } from "./service.ts";

export const BUILTIN_SOURCE_ID = "builtin";

const PREFIX = "builtin:";

export function builtinSkillId(name: string) {
  return `${PREFIX}${name}`;
}

export function isBuiltinId(id: string) {
  return id === BUILTIN_SOURCE_ID || id.startsWith(PREFIX);
}

const texts = import.meta.glob("./builtin/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const found = discoverSkills(
  Object.entries(texts).map(([path, text]) => ({ path: path.replace("./builtin/", ""), text })),
  "skill",
);

// The built-in source as the org has it, on unless its owners turned it off.
export function builtinSource(orgId: string, enabled: boolean): SkillSource {
  return {
    id: BUILTIN_SOURCE_ID,
    orgId,
    spaceId: null,
    label: "Built in",
    url: "",
    ref: null,
    resolvedRef: null,
    subpath: null,
    commit: "",
    fetchedAt: new Date(0),
    enabled,
    hasToken: false,
    createdBy: null,
    createdAt: new Date(0),
  };
}

// The built-in skills, each on unless the org's switch for it says otherwise.
export function builtinSkills(orgId: string, switches: ReadonlyMap<string, boolean>): Skill[] {
  return found.map((skill) => ({
    id: builtinSkillId(skill.name),
    orgId,
    spaceId: null,
    sourceId: BUILTIN_SOURCE_ID,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files: skill.files,
    enabled: switches.get(builtinSkillId(skill.name)) !== false,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
}

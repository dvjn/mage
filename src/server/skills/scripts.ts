// Skills' scripts that run by file: the .py files of the learned skills on in a space, each named
// `<skill>/<path>`, read by the scripts' tool to run them and by the skills' tools to name them.

import type { SpaceTools } from "@/server/tools/registry.ts";
import { closest } from "@/server/tools/signatures.ts";
import { type SkillFile, SKILLS_TOOLSET } from "@/shared/skills.ts";

export const RUN_SCRIPT = "scripts.run";

// A skill as its scripts are read from it.
interface ScriptSource {
  name: string;
  files: SkillFile[];
  learned?: unknown;
}

// The skill's scripts that run by file, as `<skill>/<path>`: a learned skill's .py files.
export function scriptFilesOf(skill: ScriptSource) {
  if (!skill.learned) return [];
  return skill.files
    .filter((file) => file.path.endsWith(".py"))
    .map((file) => `${skill.name}/${file.path}`);
}

// The code at `<skill>/<path>` of a learned skill on in the space as its tools read it, or why
// none runs from there.
export function learnedScript(now: SpaceTools, ref: string): { code: string } | { error: string } {
  const skills = (now.loaded.get(SKILLS_TOOLSET) as ScriptSource[] | undefined) ?? [];
  const runnable = skills.flatMap(scriptFilesOf);
  const skill = skills.find((one) => ref.startsWith(`${one.name}/`));
  const path = skill && ref.slice(skill.name.length + 1);
  const file = skill?.files.find((one) => one.path === path);
  if (file && runnable.includes(ref)) {
    return file.text.trim() ? { code: file.text } : { error: `${ref} is empty.` };
  }
  const these = runnable.length > 0 ? `Those here: ${runnable.join(", ")}.` : "None is here.";
  if (file) return { error: `Only learned skills' .py files run by file. ${these}` };
  const near = closest(ref, runnable);
  const hint = near.length > 0 ? `Did you mean: ${near.join(", ")}?` : these;
  return { error: `No skill file ${ref} is on here. ${hint}` };
}

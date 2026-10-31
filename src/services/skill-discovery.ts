// Finding skills in a repository's files: every folder up to a few levels deep with a SKILL.md is a
// skill, its name and description read from the file's frontmatter, its instructions the rest, and
// the other text files in its folder (but not in a skill folder inside it) ship with it, up to a
// cap. A name that is not a skill's name is made one; a skill without one is named for its folder.

import { parse } from "yaml";

import { SKILL_DESCRIPTION_MAX, type SkillFile, skillNameOf } from "@/shared/skills.ts";

// How deep a SKILL.md may be, in folders, and what one skill may carry with it.
const MAX_DEPTH = 4;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;

export interface FoundSkill {
  // Its folder, from where skills were looked for; "." for the top.
  path: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function oneLine(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SKILL_DESCRIPTION_MAX
    ? `${line.slice(0, SKILL_DESCRIPTION_MAX - 1)}…`
    : line;
}

// A SKILL.md's frontmatter and the instructions after it.
export function readSkillFile(text: string): {
  name: string | null;
  description: string | null;
  body: string;
} {
  const match = FRONTMATTER.exec(text);
  if (!match) return { name: null, description: null, body: text.trim() };
  let data: unknown = null;
  try {
    data = parse(match[1]!);
  } catch {
    // Frontmatter that does not parse is left out.
  }
  const fields = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const field = (key: string) =>
    typeof fields[key] === "string" && fields[key].trim() ? fields[key] : null;
  return {
    name: field("name"),
    description: field("description"),
    body: text.slice(match[0].length).trim(),
  };
}

// The first line of instructions that is not a heading, for a skill that does not describe itself.
function firstLine(body: string) {
  return body.split("\n").find((line) => line.trim() && !line.trim().startsWith("#")) ?? "";
}

function folderOf(path: string) {
  const at = path.lastIndexOf("/");
  return at < 0 ? "." : path.slice(0, at);
}

function depthOf(folder: string) {
  return folder === "." ? 0 : folder.split("/").length;
}

// The skills in the files, by folder; `fallback` names a skill at the top that names itself not.
export function discoverSkills(
  files: readonly { path: string; text: string }[],
  fallback: string,
): FoundSkill[] {
  const folders = files
    .filter((file) => /(?:^|\/)SKILL\.md$/.test(file.path))
    .map((file) => folderOf(file.path))
    .filter((folder) => depthOf(folder) <= MAX_DEPTH);
  const inside = (folder: string, path: string) => folder === "." || path.startsWith(`${folder}/`);
  // The skill folder a file belongs to: the deepest one holding it.
  const ownerOf = (path: string) =>
    folders
      .filter((folder) => inside(folder, path))
      .reduce<string | null>(
        (deepest, folder) =>
          deepest === null || depthOf(folder) > depthOf(deepest) ? folder : deepest,
        null,
      );
  return folders
    .map((folder) => {
      const prefix = folder === "." ? "" : `${folder}/`;
      const main = files.find((file) => file.path === `${prefix}SKILL.md`)!;
      const read = readSkillFile(main.text);
      let bytes = 0;
      const shipped: SkillFile[] = [];
      for (const file of files) {
        if (file === main || ownerOf(file.path) !== folder) continue;
        bytes += file.text.length;
        if (shipped.length >= MAX_FILES || bytes > MAX_FILE_BYTES) break;
        shipped.push({ path: file.path.slice(prefix.length), text: file.text });
      }
      const base = folder === "." ? fallback : folder.slice(folder.lastIndexOf("/") + 1);
      return {
        path: folder,
        name: skillNameOf(read.name ?? base) || skillNameOf(base) || "skill",
        description: oneLine(read.description ?? firstLine(read.body)),
        body: read.body,
        files: shipped,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

// Skills as the API shows them, shared by the server and the web client: the skills an org and a
// space have (from a git repository,
// or written in settings) with their switches, the bodies that add and change them, and reading
// what people paste to add skills from a repository: `owner/repo`, a GitHub, GitLab or other git
// address, a GitHub or GitLab address of a folder on a branch, or a command that adds skills, whose
// `--skill` names are left out since a repository comes whole.

import * as z from "zod";

// A skill's name: lower-case words joined by dashes.
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillNameSchema = z
  .string()
  .trim()
  .min(1, "Give the skill a name")
  .max(64, "A name has at most 64 characters")
  .regex(SKILL_NAME, "Use lower-case letters, digits and dashes, like write-release-notes");

export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 100_000;

export const skillDescriptionSchema = z
  .string()
  .trim()
  .min(1, "Say in a line when to use it")
  .max(SKILL_DESCRIPTION_MAX)
  .regex(/^[^\r\n]*$/, "The description is one line");

// A skill written in settings.
export const skillInputSchema = z.object({
  name: skillNameSchema,
  description: skillDescriptionSchema,
  body: z.string().max(SKILL_BODY_MAX, "The instructions are too long"),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

// A skill as settings list it: where it comes from (a source's folder, or written here), whether
// it is on, and how many files come with it.
export const skillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // The source it came from, and its folder there; null for one written in settings.
  sourceId: z.string().nullable(),
  path: z.string().nullable(),
  // The space it is for; null for the whole org.
  spaceId: z.string().nullable(),
  enabled: z.boolean(),
  fileCount: z.number(),
  updatedAt: z.iso.datetime(),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

// A file that comes with a skill, kept as text.
export const skillFileSchema = z.object({ path: z.string(), text: z.string() });

export type SkillFile = z.infer<typeof skillFileSchema>;

// Everything about a skill, for reading it: its instructions and files.
export const skillDetailSchema = skillSummarySchema.extend({
  body: z.string(),
  files: z.array(skillFileSchema),
});

export type SkillDetail = z.infer<typeof skillDetailSchema>;

// A repository skills come from, at the commit they were read at.
export const skillSourceSchema = z.object({
  id: z.string(),
  spaceId: z.string().nullable(),
  // What people call it, like owner/repo.
  label: z.string(),
  url: z.string(),
  // The branch or tag asked for; null for the repository's default branch.
  ref: z.string().nullable(),
  // The branch or tag read, the folder skills were looked for in, and the commit.
  resolvedRef: z.string().nullable(),
  subpath: z.string().nullable(),
  commit: z.string(),
  fetchedAt: z.iso.datetime(),
  enabled: z.boolean(),
  hasToken: z.boolean(),
  // The skills that ship with the product: only their switches change.
  builtin: z.boolean(),
  skills: z.array(skillSummarySchema),
});

export type SkillSourceSummary = z.infer<typeof skillSourceSchema>;

// The org's skills: its sources and the skills written or uploaded for it, and whether its spaces
// may add their own.
export const orgSkillListSchema = z.object({
  sources: z.array(skillSourceSchema),
  written: z.array(skillSummarySchema),
  spaceSkills: z.boolean(),
});

export type OrgSkillList = z.infer<typeof orgSkillListSchema>;

// One of the org's skills as a space sees it, with whether the space uses it; one the org turned
// off is off in the space whatever the space set.
export const spaceOrgSkillSchema = skillSummarySchema.extend({ inSpace: z.boolean() });

export const spaceOrgSourceSchema = skillSourceSchema.extend({
  inSpace: z.boolean(),
  skills: z.array(spaceOrgSkillSchema),
});

export type SpaceOrgSkill = z.infer<typeof spaceOrgSkillSchema>;
export type SpaceOrgSource = z.infer<typeof spaceOrgSourceSchema>;

// A space's skills: the org's, each with the space's switch, and its own, with whether the org
// lets it add skills.
export const spaceSkillListSchema = z.object({
  org: z.object({
    sources: z.array(spaceOrgSourceSchema),
    written: z.array(spaceOrgSkillSchema),
  }),
  own: z.object({
    sources: z.array(skillSourceSchema),
    written: z.array(skillSummarySchema),
  }),
  allowed: z.boolean(),
});

export type SpaceSkillList = z.infer<typeof spaceSkillListSchema>;

const tokenSchema = z.string().trim().min(1).max(2000).nullable().optional();

// Adding a source: the whole repository as pasted, its skills off, and a token for a private one.
export const newSkillSourceSchema = z.object({
  input: z.string().trim().min(1, "Paste a repository").max(2000),
  token: tokenSchema,
});

export type NewSkillSource = z.infer<typeof newSkillSourceSchema>;

export const skillTokenChangeSchema = z.object({ token: z.string().trim().max(2000).nullable() });

// A source read again, and the skills that came, changed and went, by name.
export const skillRefreshSchema = z.object({
  source: skillSourceSchema,
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
});

export type SkillRefresh = z.infer<typeof skillRefreshSchema>;

// The most an uploaded file may be, as it is sent.
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// An uploaded SKILL.md, or a zip of one or more skill folders, in base64.
export const skillUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  data: z
    .string()
    .max(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4, "This file is too large")
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "The file is not in base64"),
});

export type SkillUpload = z.infer<typeof skillUploadSchema>;

// What an upload made: the skills added, or, for a file that does not name and describe its skill,
// what it holds, for people to finish.
export const skillUploadResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("added"), skills: z.array(skillSummarySchema) }),
  z.object({
    status: z.literal("draft"),
    draft: z.object({ name: z.string(), description: z.string(), body: z.string() }),
  }),
]);

export type SkillUploadResult = z.infer<typeof skillUploadResultSchema>;

export const skillEnabledChangeSchema = z.object({ enabled: z.boolean() });

export const spaceSkillsChangeSchema = z.object({ allowed: z.boolean() });

// A source as pasted, once read: where to clone it from, what to call it, the branch or tag and
// folder when given.
export interface ParsedSource {
  url: string;
  label: string;
  ref: string | null;
  subpath: string | null;
}

const NOT_A_REPOSITORY = "Paste owner/repo, a git URL, or a skills add command";

// The runners a command may start with, and the packages that add skills.
const RUNNERS = new Set(["npx", "pnpx", "bunx", "yarn", "pnpm", "bun", "npm"]);
const RUNNER_VERBS = new Set(["dlx", "exec", "x"]);
const ADDERS = /^(?:skills|add-skill|@[\w.-]+\/skills)(?:@[\w.-]+)?$/;
// Flags of those commands that take a value.
const VALUED_FLAGS = new Set(["--agent", "-a", "--skill", "-s"]);

function trimSlashes(path: string) {
  return path.replace(/^\/+|\/+$/g, "");
}

// The words of a command, quotes removed.
function wordsOf(text: string) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
}

// The repository of a command that adds skills; null for anything else.
function fromCommand(text: string): string | null {
  const words = wordsOf(text);
  let at = 0;
  if (!RUNNERS.has(words[0] ?? "")) return null;
  at += 1;
  if (RUNNER_VERBS.has(words[at] ?? "")) at += 1;
  while (words[at]?.startsWith("-")) at += 1;
  const adder = words[at];
  if (!adder || !ADDERS.test(adder)) return null;
  at += 1;
  if (!adder.startsWith("add-skill") && ["add", "a", "install", "i"].includes(words[at] ?? "")) {
    at += 1;
  }
  let target: string | null = null;
  for (; at < words.length; at += 1) {
    const word = words[at]!;
    const [flag, inline] = word.startsWith("--") ? word.split("=", 2) : [word, undefined];
    if (flag!.startsWith("-")) {
      if (VALUED_FLAGS.has(flag!) && inline === undefined) at += 1;
    } else if (!target) {
      target = word;
    }
  }
  return target;
}

// A GitHub repository, with the branch and folder of a /tree/ address.
function fromGitHub(path: string): ParsedSource | null {
  const [owner, repo, kind, ref, ...rest] = trimSlashes(path).split("/");
  if (!owner || !repo) return null;
  const name = repo.replace(/\.git$/, "");
  const tree = kind === "tree" || kind === "blob";
  if (kind && !tree) return null;
  const subpath = tree ? trimSlashes(rest.join("/")) || null : null;
  return {
    url: `https://github.com/${owner}/${name}.git`,
    label: `${owner}/${name}`,
    ref: tree && ref ? ref : null,
    subpath,
  };
}

// Any other git address: a GitLab /-/tree/ address takes its branch and folder; others are cloned
// as given.
function fromUrl(url: URL): ParsedSource | null {
  if (!["http:", "https:"].includes(url.protocol)) return null;
  url.hash = "";
  url.search = "";
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    return fromGitHub(url.pathname);
  }
  const [repoPath, tree] = url.pathname.split("/-/");
  let ref: string | null = null;
  let subpath: string | null = null;
  if (tree !== undefined) {
    const [kind, branch, ...rest] = trimSlashes(tree).split("/");
    if ((kind !== "tree" && kind !== "blob") || !branch) return null;
    ref = branch;
    subpath = trimSlashes(rest.join("/")) || null;
  }
  const path = trimSlashes(repoPath ?? "");
  if (!path) return null;
  const clone = new URL(url);
  clone.pathname = `/${path}`;
  const bare = path.replace(/\.git$/, "");
  return {
    url: clone.href,
    label: url.hostname === "gitlab.com" ? bare : `${url.host}/${bare}`,
    ref,
    subpath,
  };
}

// What people pasted to add skills from, read as a repository to clone; or why it is not one.
export function parseSkillSource(text: string): ParsedSource | { error: string } {
  let target = text.trim();
  const command = fromCommand(target);
  if (command) target = command;
  else if (/\s/.test(target)) return { error: NOT_A_REPOSITORY };
  // git@host:owner/repo.git, as copied for SSH, is read over https.
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(target);
  if (ssh) target = `https://${ssh[1]}/${ssh[2]}`;
  let parsed: ParsedSource | null = null;
  if (/^https?:\/\//i.test(target)) {
    const url = URL.parse(target);
    parsed = url && fromUrl(url);
  } else if (/^(?:www\.)?github\.com\//i.test(target)) {
    parsed = fromGitHub(target.replace(/^(?:www\.)?github\.com\//i, ""));
  } else if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    parsed = fromGitHub(target);
  } else if (/^[\w.-]+\.[a-z]{2,}\/[^\s]+$/i.test(target)) {
    const url = URL.parse(`https://${target}`);
    parsed = url && fromUrl(url);
  }
  if (!parsed) return { error: NOT_A_REPOSITORY };
  return parsed;
}

// A name as a skill's name: lower case, words joined by dashes.
export function skillNameOf(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

// The ids of the built-in Skills toolset and its tools.
export const SKILLS_TOOLSET = "skills";
export const LOAD_SKILL = "skills.load";
export const READ_SKILL_FILE = "skills.read_file";

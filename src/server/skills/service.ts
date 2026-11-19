// The skills the agent loads when a task matches one. An org's owners keep the org's, which apply
// in every space of the org; a space's managers keep skills that space alone has, unless the org
// turned that off. A skill comes from a source, a git repository read whole at one commit, its
// skills arriving off, and kept until someone refreshes it; or is written or uploaded in settings,
// a SKILL.md or a zip of skill folders read as a repository is. Everything has a switch: a space's
// managers turn one of the org's sources or skills off for their space alone, though never on while
// the org has it off. A space's skill replaces the org's of the same name there, and two skills of
// one name are never on in one scope. Skills only shape what the agent does: tool policies still
// decide every call. A private source's token is sealed and never leaves the server. The agent
// reads a list of the skills on in its thread's space in its system prompt, and loads a skill, or
// one of its files, through the built-in Skills toolset.
// Skills the agent learns are a space's own, and never take the place of the org's or built-in.

import * as z from "zod";

import type { Principal } from "@/server/orgs/identity.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { OrgSettingStore } from "@/server/orgs/service.ts";
import type { OrgRead } from "@/server/tools/registry.ts";
import type { Space, Spaces } from "@/server/spaces/service.ts";
import type { AnyToolSpec, SpaceTools, Toolset, ToolSpec } from "@/server/tools/registry.ts";
import type { Guidance, SkillLine } from "@/server/execution/context.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Transact } from "@/server/sync/transact.ts";
import type { ToolContext } from "@/server/tools/registry.ts";
import { BTW, COMPACT, RELOAD } from "@/shared/threads/commands.ts";
import type { Influencer } from "@/shared/threads/events.ts";
import {
  LOAD_SKILL,
  type NewSkillSource as SkillSourceInput,
  type OrgSkillList,
  parseSkillSource,
  type ParsedSource,
  READ_SKILL_FILE,
  type SkillDetail,
  type SkillInput,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME,
  type SkillUpload,
  type SkillUploadResult,
  skillNameOf,
  SKILLS_TOOLSET,
  type SkillSourceSummary,
  type SkillSummary,
  type SkillRefresh,
  type SpaceSkillList,
  type SkillFile,
} from "@/shared/skills.ts";

import {
  BUILTIN_SOURCE_ID,
  builtinSkills,
  builtinSource,
  isBuiltinId,
  namingTools,
} from "./builtin.ts";
import { RUN_SCRIPT, scriptFilesOf } from "./scripts.ts";
import { discoverSkills, type FoundSkill, readSkillFile } from "./discovery.ts";
import { GitError, type GitReader, type GitSnapshot } from "./git.ts";
import { ArchiveError, type ArchiveReader } from "./zip.ts";

// Whose: an org's own (no space), or one space's.
export interface Scope {
  orgId: string;
  spaceId: string | null;
}

export interface SkillSource {
  id: string;
  orgId: string;
  spaceId: string | null;
  label: string;
  url: string;
  ref: string | null;
  resolvedRef: string | null;
  subpath: string | null;
  commit: string;
  fetchedAt: Date;
  enabled: boolean;
  hasToken: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export type NewSkillSource = Pick<
  SkillSource,
  "orgId" | "spaceId" | "label" | "url" | "ref" | "resolvedRef" | "subpath" | "commit"
> & { createdBy: string };

export interface Skill {
  id: string;
  orgId: string;
  spaceId: string | null;
  // The source it came from and its folder there; null for one written in settings.
  sourceId: string | null;
  path: string | null;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  learned?: LearnedFrom | null;
}

export interface LearnedFrom {
  threadId: string | null;
  threadTitle: string | null;
  approvedBy: string | null;
}

export interface NewLearnedSkill {
  spaceId: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  threadId: string | null;
  // The call that saved it; none for a manager's edit.
  callId: string | null;
  influence: Influencer[];
  approvedBy: string | null;
  // The learned skill it replaces.
  supersedesId: string | null;
  enabled: boolean;
}

// What the agent gives to save a skill.
export interface LearnInput {
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[];
  update?: boolean;
}

export type NewSkill = Pick<
  Skill,
  "orgId" | "spaceId" | "sourceId" | "path" | "name" | "description" | "body" | "files" | "enabled"
> & { createdBy: string };

export type SkillChanges = Partial<
  Pick<Skill, "name" | "description" | "body" | "files" | "enabled">
>;

export interface SkillStore {
  createSource(source: NewSkillSource): Promise<SkillSource>;
  findSource(id: string): Promise<SkillSource | null>;
  // The sources of the scope: the org's own when no space is given.
  sources(scope: Scope): Promise<SkillSource[]>;
  updateSource(
    id: string,
    changes: Partial<Pick<SkillSource, "enabled" | "commit" | "resolvedRef" | "fetchedAt">>,
  ): Promise<void>;
  // Deletes the source with its skills.
  deleteSource(id: string): Promise<void>;
  // The token a private source is read with, sealed at rest; null to forget it.
  token(id: string): Promise<string | null>;
  setToken(id: string, token: string | null): Promise<void>;

  create(skill: NewSkill): Promise<Skill>;
  find(id: string): Promise<Skill | null>;
  // Every skill of the scope, from its sources, written there and, for a space, learned there, in
  // one read.
  inScope(scope: Scope): Promise<Skill[]>;
  update(id: string, changes: SkillChanges): Promise<void>;
  delete(id: string): Promise<void>;
  setLearnedEnabled(id: string, enabled: boolean): Promise<void>;

  // What the call saved, in use or not.
  learnedOfCall(
    threadId: string,
    callId: string,
  ): Promise<{ name: string; updated: boolean } | null>;
  // Its id; null when the call saved one already, or a skill of its name is in use in the space.
  createLearned(skill: NewLearnedSkill): Promise<string | null>;
  // Retires the space's learned skill in use, answering what a row replacing it carries over; null
  // when it was not in use.
  retireLearned(
    spaceId: string,
    id: string,
    by: string | null,
    at: Date,
  ): Promise<Pick<NewLearnedSkill, "files" | "threadId" | "enabled"> | null>;
  // Holds the name in the scope until the transaction under way ends, so that writes of one name
  // there run one at a time.
  holdName(scope: Scope, name: string): Promise<void>;

  // What a space set for the org's sources and skills, for those it set.
  spaceSourceSettings(spaceId: string): Promise<Map<string, boolean>>;
  setSpaceSource(spaceId: string, sourceId: string, enabled: boolean): Promise<void>;
  spaceSkillSettings(spaceId: string): Promise<Map<string, boolean>>;
  setSpaceSkill(spaceId: string, skillId: string, enabled: boolean): Promise<void>;

  // The switches on the built-in skills, by the ids they are listed under: the org's and a space's.
  orgBuiltinSwitches(orgId: string): Promise<Map<string, boolean>>;
  setOrgBuiltin(orgId: string, key: string, enabled: boolean): Promise<void>;
  spaceBuiltinSwitches(spaceId: string): Promise<Map<string, boolean>>;
  setSpaceBuiltin(spaceId: string, key: string, enabled: boolean): Promise<void>;
}

export interface SkillsOptions {
  skills: SkillStore;
  git: GitReader;
  archives: ArchiveReader;
  spaces: Pick<Spaces, "require">;
  settings: Pick<OrgSettingStore, "get" | "setSpaceSkills">;
  transact: Transact;
  logger: Logger;
  // What the model calls each of the space's tools, for the built-in skills that name them.
  toolNames?: (space: Pick<Space, "id" | "orgId">) => Promise<(toolId: string) => string>;
  now?: () => Date;
}

export type Skills = ReturnType<typeof createSkills>;

const ORG_ONLY = "Only the organization's owners can manage its skills";
const SPACES_OFF = "The organization does not let spaces add skills";
const ORG_OFF = "The organization turned this off";
const NOT_FOUND = "Skill not found";
const SOURCE_NOT_FOUND = "Skill source not found";
const BUILT_IN = "Built-in skills can only be turned on or off";
const WRITTEN_ONLY = "Only skills written here can be changed; update the source instead";
// A skill that was in use as a request began, and changed before it held the skill's name.
const CHANGED = "It changed while this saved";

// What the agent is told after it saves a skill.
const USABLE = "Usable now; listed in this thread's instructions after /reload.";

// The names of Mage's own commands, which no learned skill takes.
const COMMANDS: ReadonlySet<string> = new Set([COMPACT, BTW, RELOAD]);

// A save the tool refuses, with what the model is told.
class Refusal extends Error {}

// A save another run of the same call made first.
class Replayed extends Error {}

export function alreadyOn(name: string) {
  return `A skill named ${name} is already on`;
}

// Whether the skill is on in its own scope: its switch, and its source's.
export function onInScope(skill: Skill, sources: ReadonlyMap<string, SkillSource>) {
  if (!skill.enabled) return false;
  if (!skill.sourceId) return true;
  return sources.get(skill.sourceId)?.enabled ?? false;
}

// What a space has, for working out the skills on there.
export interface SpaceSkills {
  orgSources: SkillSource[];
  orgSkills: Skill[];
  ownSources: SkillSource[];
  ownSkills: Skill[];
  // What the space set on the org's sources and skills.
  sourceSwitches: ReadonlyMap<string, boolean>;
  skillSwitches: ReadonlyMap<string, boolean>;
  // Whether the org lets the space have skills of its own.
  allowed: boolean;
}

function byId(sources: readonly SkillSource[]) {
  return new Map(sources.map((source) => [source.id, source]));
}

// The skills on in the space, by name: the org's it did not turn off, then its own, which replace
// the org's of the same name, while the org lets it have them.
// The skills on in the space, as its tools read them; none where the Skills toolset read nothing.
function loadedSkills(now: SpaceTools): Skill[] {
  return (now.loaded.get(SKILLS_TOOLSET) as Skill[] | undefined) ?? [];
}

export function effectiveSkills(set: SpaceSkills): Skill[] {
  const orgSources = byId(set.orgSources);
  const ownSources = byId(set.ownSources);
  const named = new Map<string, Skill>();
  for (const skill of set.orgSkills) {
    if (!onInScope(skill, orgSources)) continue;
    if (skill.sourceId && set.sourceSwitches.get(skill.sourceId) === false) continue;
    if (set.skillSwitches.get(skill.id) === false) continue;
    named.set(skill.name, skill);
  }
  if (set.allowed) {
    for (const skill of set.ownSkills) {
      // A learned skill never takes the place of the org's or a built-in one.
      if (skill.learned && named.has(skill.name)) continue;
      if (onInScope(skill, ownSources)) named.set(skill.name, skill);
    }
  }
  return [...named.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The ServiceError for a repository that could not be read; one that wants a token says so.
function gitFailure(err: unknown): never {
  if (!(err instanceof GitError)) throw err;
  if (err.kind === "unreachable") throw new ServiceError(502, err.message, "unreachable");
  throw new ServiceError(400, err.message, err.kind);
}

// The last part of what a source is called, for a skill at its top that names itself not.
function fallbackName(source: Pick<ParsedSource, "label" | "subpath">) {
  const from = source.subpath ?? source.label;
  return from.slice(from.lastIndexOf("/") + 1);
}

// The skills found in a snapshot, which must have some.
function foundIn(snapshot: GitSnapshot, source: Pick<ParsedSource, "label" | "subpath">) {
  const found = discoverSkills(snapshot.files, fallbackName(source));
  if (found.length === 0) {
    throw new ServiceError(400, "No SKILL.md found in this repository", "no_skills");
  }
  return found;
}

function sameSkill(a: Pick<Skill, "name" | "description" | "body" | "files">, b: FoundSkill) {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.body === b.body &&
    JSON.stringify(a.files) === JSON.stringify(b.files)
  );
}

// The skills the agent's prompt lists, after the line that says how to load one.
export function skillsGuidance(list: SkillLine[]): NonNullable<Guidance["skills"]> {
  return {
    line: (named) =>
      `Skills: instructions for kinds of tasks. When a task matches one, load it with ${named(LOAD_SKILL)} before you start.`,
    list,
  };
}

export function createSkills(options: SkillsOptions) {
  const { skills, git, archives, spaces, settings, logger } = options;
  const now = options.now ?? (() => new Date());

  async function spacesMayAdd(orgId: string, org?: OrgRead) {
    return (await (org?.() ?? settings.get(orgId))).spaceSkills;
  }

  // The scope the principal manages: the org's for its owners, or a space's for its managers.
  async function managed(principal: Principal, spaceId: string | null): Promise<Scope> {
    if (spaceId) {
      const space = await spaces.require(principal, spaceId, "manage");
      return { orgId: space.orgId, spaceId: space.id };
    }
    if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
    return { orgId: principal.orgId, spaceId: null };
  }

  // A scope the principal may add skills to: as above, for a space only while the org lets it.
  async function addable(principal: Principal, spaceId: string | null) {
    const scope = await managed(principal, spaceId);
    if (scope.spaceId && !(await spacesMayAdd(scope.orgId)))
      throw new ServiceError(403, SPACES_OFF);
    return scope;
  }

  function scopeOf(item: { orgId: string; spaceId: string | null }): Scope {
    return { orgId: item.orgId, spaceId: item.spaceId };
  }

  async function manageableSource(principal: Principal, id: string) {
    if (isBuiltinId(id)) throw new ServiceError(400, BUILT_IN);
    const source = await skills.findSource(id);
    if (!source || source.orgId !== principal.orgId) throw new ServiceError(404, SOURCE_NOT_FOUND);
    await managed(principal, source.spaceId);
    return source;
  }

  async function manageableSkill(principal: Principal, id: string) {
    if (isBuiltinId(id)) throw new ServiceError(400, BUILT_IN);
    const skill = await skills.find(id);
    if (!skill || skill.orgId !== principal.orgId) throw new ServiceError(404, NOT_FOUND);
    await managed(principal, skill.spaceId);
    return skill;
  }

  // The skills on in the scope, but the one given.
  async function onIn(scope: Scope, except: (skill: Skill) => boolean = () => false) {
    const sources = byId(await skills.sources(scope));
    return (await skills.inScope(scope)).filter(
      (skill) => onInScope(skill, sources) && !except(skill),
    );
  }

  // Refuses to turn on skills of these names where one of each is on already, or where two share
  // a name.
  async function refuseClashes(scope: Scope, names: string[], except: (skill: Skill) => boolean) {
    const on = new Set((await onIn(scope, except)).map((skill) => skill.name));
    const seen = new Set<string>();
    for (const name of names) {
      if (on.has(name) || seen.has(name)) throw new ServiceError(409, alreadyOn(name));
      seen.add(name);
    }
  }

  // Refuses a learned skill a new name that a command, a built-in or org skill, or another of the
  // space's skills has, on or off.
  async function refuseLearnedName(skill: Skill, name: string) {
    if (COMMANDS.has(name)) throw new ServiceError(409, `${name} is a command`);
    const set = await spaceSkills({ id: skill.spaceId!, orgId: skill.orgId });
    if (set.orgSkills.some((other) => other.name === name)) {
      throw new ServiceError(409, `${name} is a built-in or organization skill`);
    }
    if (set.ownSkills.some((other) => other.name === name && other.id !== skill.id)) {
      throw new ServiceError(409, `A skill named ${name} already exists here`);
    }
  }

  // Refuses a person's skill in a space the name of a learned one there, on or off.
  async function refuseLearnedHeld(scope: Scope, names: string[], except?: string) {
    if (!scope.spaceId) return;
    const held = (await skills.inScope(scope)).filter(
      (skill) => skill.learned && skill.id !== except,
    );
    for (const name of names) {
      if (held.some((skill) => skill.name === name)) {
        throw new ServiceError(409, `A learned skill named ${name} is already here`);
      }
    }
  }

  // The skill as it is once its names are held, which it must still be.
  async function stillLive(id: string) {
    const live = await skills.find(id);
    if (!live) throw new ServiceError(409, CHANGED);
    return live;
  }

  // A skill as settings list it; where a learned one came from, its thread only for those who
  // read the space's threads.
  function skillSummary(skill: Skill, threads = false): SkillSummary {
    const learned = skill.learned;
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      sourceId: skill.sourceId,
      path: skill.path,
      spaceId: skill.spaceId,
      enabled: skill.enabled,
      fileCount: skill.files.length,
      updatedAt: skill.updatedAt.toISOString(),
      learned: learned
        ? {
            thread:
              threads && learned.threadId
                ? { id: learned.threadId, title: learned.threadTitle ?? "Untitled" }
                : null,
            approvedBy: learned.approvedBy,
          }
        : null,
    };
  }

  function sourceSummary(source: SkillSource, all: readonly Skill[]): SkillSourceSummary {
    return {
      id: source.id,
      spaceId: source.spaceId,
      label: source.label,
      url: source.url,
      ref: source.ref,
      resolvedRef: source.resolvedRef,
      subpath: source.subpath,
      commit: source.commit,
      fetchedAt: source.fetchedAt.toISOString(),
      enabled: source.enabled,
      hasToken: source.hasToken,
      builtin: source.id === BUILTIN_SOURCE_ID,
      skills: all
        .filter((skill) => skill.sourceId === source.id)
        .map((skill) => skillSummary(skill)),
    };
  }

  // The scope's sources with their skills, and the skills written or learned there.
  async function listed(scope: Scope, threads = false) {
    const all = await skills.inScope(scope);
    return {
      sources: (await skills.sources(scope)).map((source) => sourceSummary(source, all)),
      written: all.filter((skill) => !skill.sourceId).map((skill) => skillSummary(skill, threads)),
    };
  }

  // The org's built-in source and skills, as its switches leave them.
  async function builtinOf(orgId: string) {
    const switches = await skills.orgBuiltinSwitches(orgId);
    return {
      source: builtinSource(orgId, switches.get(BUILTIN_SOURCE_ID) !== false),
      skills: builtinSkills(orgId, switches),
    };
  }

  async function spaceSkills(
    space: Pick<Space, "id" | "orgId">,
    given?: OrgRead,
  ): Promise<SpaceSkills> {
    const org = { orgId: space.orgId, spaceId: null };
    const own = { orgId: space.orgId, spaceId: space.id };
    const builtin = await builtinOf(space.orgId);
    const builtinSwitches = await skills.spaceBuiltinSwitches(space.id);
    return {
      orgSources: [builtin.source, ...(await skills.sources(org))],
      orgSkills: [...builtin.skills, ...(await skills.inScope(org))],
      ownSources: await skills.sources(own),
      ownSkills: await skills.inScope(own),
      sourceSwitches: new Map([
        ...(await skills.spaceSourceSettings(space.id)),
        ...builtinSwitches,
      ]),
      skillSwitches: new Map([...(await skills.spaceSkillSettings(space.id)), ...builtinSwitches]),
      allowed: await spacesMayAdd(space.orgId, given),
    };
  }

  async function effectiveIn(space: Pick<Space, "id" | "orgId">, org?: OrgRead) {
    return effectiveSkills(await spaceSkills(space, org));
  }

  // The skill's instructions as the agent in the space reads them, naming tools as `named` does
  // when given.
  async function instructionsOf(
    space: Pick<Space, "id" | "orgId">,
    skill: Skill,
    named?: (toolId: string) => string,
  ) {
    if (skill.sourceId !== BUILTIN_SOURCE_ID) return skill.body;
    const naming = named ?? (options.toolNames ? await options.toolNames(space) : (id) => id);
    return namingTools(skill.body, naming, await spacesMayAdd(space.orgId));
  }

  async function snapshotOf(parsed: ParsedSource, token: string | null) {
    try {
      return await git.snapshot({ url: parsed.url, ref: parsed.ref, token }, parsed.subpath);
    } catch (err) {
      logger.info({ url: parsed.url, err: (err as Error).message }, "skill source unreadable");
      return gitFailure(err);
    }
  }

  function parsedOf(input: string) {
    const parsed = parseSkillSource(input);
    if ("error" in parsed) throw new ServiceError(400, parsed.error);
    return parsed;
  }

  // Adds an uploaded skill as one written here. A zip is read as a repository is: one skill in it
  // comes on unless one of its name is; several come off, as a repository's do. A SKILL.md that
  // names and describes its skill comes on the same way; one that does not comes back as a draft
  // to finish.
  async function upload(
    principal: Principal,
    spaceId: string | null,
    input: SkillUpload,
  ): Promise<SkillUploadResult> {
    const scope = await addable(principal, spaceId);
    const bytes = Buffer.from(input.data, "base64");
    const base = input.fileName.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
    let found: FoundSkill[];
    if (/\.zip$/i.test(input.fileName)) {
      let files: { path: string; text: string }[];
      try {
        files = archives.files(bytes);
      } catch (err) {
        if (!(err instanceof ArchiveError)) throw err;
        throw new ServiceError(400, err.message, err.kind);
      }
      found = discoverSkills(files, base);
      if (found.length === 0) {
        throw new ServiceError(400, "No SKILL.md found in this file", "no_skills");
      }
    } else {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("\u0000")) throw new ServiceError(400, "This file isn't text", "invalid");
      const read = readSkillFile(text);
      const name = skillNameOf(read.name ?? (/^skill$/i.test(base) ? "" : base));
      const description = read.description?.replace(/\s+/g, " ").trim() ?? "";
      if (!read.name || !description || !SKILL_NAME.test(name)) {
        return { status: "draft", draft: { name, description, body: read.body } };
      }
      found = [
        {
          path: ".",
          name,
          description: description.slice(0, SKILL_DESCRIPTION_MAX),
          body: read.body,
          files: [],
        },
      ];
    }
    if (found.some((skill) => skill.body.length > SKILL_BODY_MAX)) {
      throw new ServiceError(400, "The instructions are too long");
    }
    const added = await options.transact(async () => {
      for (const name of [...new Set(found.map((skill) => skill.name))].sort()) {
        await skills.holdName(scope, name);
      }
      await refuseLearnedHeld(scope, [...new Set(found.map((skill) => skill.name))]);
      const on = new Set((await onIn(scope)).map((skill) => skill.name));
      const made: Skill[] = [];
      for (const skill of found) {
        made.push(
          await skills.create({
            ...scope,
            sourceId: null,
            path: null,
            name: skill.name,
            description: skill.description,
            body: skill.body,
            files: skill.files,
            enabled: found.length === 1 && !on.has(skill.name),
            createdBy: principal.userId,
          }),
        );
      }
      return made;
    });
    return { status: "added", skills: added.map((skill) => skillSummary(skill)) };
  }

  // Adds the whole repository, every skill found in it off until someone turns it on.
  async function addSource(principal: Principal, spaceId: string | null, input: SkillSourceInput) {
    const scope = await addable(principal, spaceId);
    const parsed = parsedOf(input.input);
    const token = input.token ?? null;
    const snapshot = await snapshotOf(parsed, token);
    const found = foundIn(snapshot, parsed);
    const source = await skills.createSource({
      ...scope,
      label: parsed.label,
      url: parsed.url,
      ref: parsed.ref,
      resolvedRef: snapshot.ref,
      subpath: parsed.subpath,
      commit: snapshot.commit,
      createdBy: principal.userId,
    });
    if (token) await skills.setToken(source.id, token);
    for (const skill of found) {
      await skills.create({
        ...scope,
        sourceId: source.id,
        path: skill.path,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        files: skill.files,
        enabled: false,
        createdBy: principal.userId,
      });
    }
    return sourceSummary((await skills.findSource(source.id))!, await skills.inScope(scope));
  }

  async function targetOf(source: SkillSource) {
    return { url: source.url, ref: source.ref, token: await skills.token(source.id) };
  }

  // What reading the source again changes, by folder: skills added, changed and removed.
  async function changesOf(source: SkillSource, found: FoundSkill[]) {
    const current = (await skills.inScope(scopeOf(source))).filter(
      (skill) => skill.sourceId === source.id,
    );
    const byPath = new Map(current.map((skill) => [skill.path, skill]));
    const paths = new Set(found.map((skill) => skill.path));
    return {
      current,
      added: found.filter((skill) => !byPath.has(skill.path)),
      changed: found.filter((skill) => {
        const before = byPath.get(skill.path);
        return before && !sameSkill(before, skill);
      }),
      removed: current.filter((skill) => !paths.has(skill.path ?? "")),
    };
  }

  const line = (skill: { name: string; description: string }) => ({
    name: skill.name,
    description: skill.description,
  });

  return {
    effectiveIn,
    instructionsOf,
    // Whether the org lets its spaces have skills of their own, learned ones among them.
    spacesMayAdd,

    // The skills on in the space, as the agent's prompt lists them, when it can load them: those
    // its tools read.
    listFor(offered: readonly AnyToolSpec[], now: SpaceTools): Guidance["skills"] {
      if (!offered.some((spec) => spec.name === LOAD_SKILL)) return undefined;
      return skillsGuidance(loadedSkills(now).map(line));
    },

    // The org's skills, which its members may read.
    async orgSkills(principal: Principal): Promise<OrgSkillList> {
      const scope = { orgId: principal.orgId, spaceId: null };
      const { sources, written } = await listed(scope);
      const builtin = await builtinOf(principal.orgId);
      return {
        sources: [sourceSummary(builtin.source, builtin.skills), ...sources],
        written,
        spaceSkills: await spacesMayAdd(principal.orgId),
      };
    },

    async setSpaceSkills(principal: Principal, allowed: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
      await settings.setSpaceSkills(principal.orgId, allowed);
    },

    // A space's: the org's skills, each with the space's switch, and its own.
    async spaceSkills(principal: Principal, spaceId: string): Promise<SpaceSkillList> {
      const space = await spaces.require(principal, spaceId);
      const org = { orgId: space.orgId, spaceId: null };
      const own = { orgId: space.orgId, spaceId: space.id };
      const builtinSwitches = await skills.spaceBuiltinSwitches(space.id);
      const sourceSwitches = new Map([
        ...(await skills.spaceSourceSettings(space.id)),
        ...builtinSwitches,
      ]);
      const skillSwitches = new Map([
        ...(await skills.spaceSkillSettings(space.id)),
        ...builtinSwitches,
      ]);
      const builtin = await builtinOf(space.orgId);
      const inSpace = (skill: SkillSummary) => ({
        ...skill,
        inSpace: skillSwitches.get(skill.id) !== false,
      });
      const orgListed = await listed(org);
      return {
        org: {
          sources: [sourceSummary(builtin.source, builtin.skills), ...orgListed.sources].map(
            (source) => ({
              ...source,
              inSpace: sourceSwitches.get(source.id) !== false,
              skills: source.skills.map(inSpace),
            }),
          ),
          written: orgListed.written.map(inSpace),
        },
        own: await listed(own, !!space.role),
        allowed: await spacesMayAdd(space.orgId),
      };
    },

    addSource,

    // Turns the whole source on or off; on, none of its skills may clash with one on.
    async setSourceEnabled(principal: Principal, id: string, enabled: boolean) {
      if (id === BUILTIN_SOURCE_ID) {
        return skills.setOrgBuiltin((await managed(principal, null)).orgId, id, enabled);
      }
      const source = await manageableSource(principal, id);
      if (enabled && !source.enabled) {
        const scope = scopeOf(source);
        const names = (await skills.inScope(scope))
          .filter((skill) => skill.sourceId === id && skill.enabled)
          .map((skill) => skill.name);
        await refuseClashes(scope, names, (skill) => skill.sourceId === id);
      }
      await skills.updateSource(id, { enabled });
    },

    async setSkillEnabled(principal: Principal, id: string, enabled: boolean) {
      if (isBuiltinId(id)) {
        const orgId = (await managed(principal, null)).orgId;
        if (!(await builtinOf(orgId)).skills.some((skill) => skill.id === id)) {
          throw new ServiceError(404, NOT_FOUND);
        }
        return skills.setOrgBuiltin(orgId, id, enabled);
      }
      const skill = await manageableSkill(principal, id);
      if (!skill.learned) {
        if (enabled) await refuseClashes(scopeOf(skill), [skill.name], (other) => other.id === id);
        return skills.update(id, { enabled });
      }
      // A learned skill is switched one write of its name at a time, as the agent saves it.
      await options.transact(async () => {
        await skills.holdName(scopeOf(skill), skill.name);
        await stillLive(id);
        if (enabled) await refuseClashes(scopeOf(skill), [skill.name], (other) => other.id === id);
        await skills.setLearnedEnabled(id, enabled);
      });
    },

    // The skill with its instructions and files, for anyone who may read its scope.
    async get(principal: Principal, id: string): Promise<SkillDetail> {
      if (isBuiltinId(id)) {
        const skill = (await builtinOf(principal.orgId)).skills.find(
          (candidate) => candidate.id === id,
        );
        if (!skill) throw new ServiceError(404, NOT_FOUND);
        const body = namingTools(skill.body, (toolId) => toolId);
        return { ...skillSummary(skill), body, files: skill.files };
      }
      const skill = await skills.find(id);
      if (!skill || skill.orgId !== principal.orgId) throw new ServiceError(404, NOT_FOUND);
      const space = skill.spaceId ? await spaces.require(principal, skill.spaceId) : null;
      return { ...skillSummary(skill, !!space?.role), body: skill.body, files: skill.files };
    },

    // Writes a skill in settings, on unless one of its name is.
    async write(
      principal: Principal,
      spaceId: string | null,
      input: SkillInput,
    ): Promise<SkillSummary> {
      const scope = await addable(principal, spaceId);
      const made = await options.transact(async () => {
        await skills.holdName(scope, input.name);
        await refuseClashes(scope, [input.name], () => false);
        await refuseLearnedHeld(scope, [input.name]);
        return skills.create({
          ...scope,
          sourceId: null,
          path: null,
          ...input,
          files: [],
          enabled: true,
          createdBy: principal.userId,
        });
      });
      return skillSummary(made);
    },

    async edit(principal: Principal, id: string, input: SkillInput): Promise<SkillSummary> {
      const skill = await manageableSkill(principal, id);
      if (skill.sourceId) throw new ServiceError(400, WRITTEN_ONLY);
      const scope = scopeOf(skill);
      const saved = await options.transact(async () => {
        for (const name of [...new Set([skill.name, input.name])].sort()) {
          await skills.holdName(scope, name);
        }
        const live = await stillLive(id);
        if (live.enabled) await refuseClashes(scope, [input.name], (other) => other.id === id);
        if (!live.learned) {
          await refuseLearnedHeld(scope, [input.name], id);
          await skills.update(id, input);
          return id;
        }
        if (input.name !== live.name) await refuseLearnedName(live, input.name);
        // A manager's edit replaces the row as the agent's update does, approved by the editor.
        const old = await skills.retireLearned(live.spaceId!, id, null, now());
        if (!old) throw new ServiceError(409, CHANGED);
        const made = await skills.createLearned({
          ...old,
          spaceId: live.spaceId!,
          ...input,
          callId: null,
          influence: [],
          approvedBy: principal.userId,
          supersedesId: id,
        });
        if (!made) throw new ServiceError(409, CHANGED);
        return made;
      });
      return skillSummary((await skills.find(saved))!);
    },

    upload,

    // Deletes a skill written here; a learned one is retired and kept.
    async remove(principal: Principal, id: string) {
      const skill = await manageableSkill(principal, id);
      const spaceId = skill.spaceId;
      if (skill.learned && spaceId) {
        await options.transact(async () => {
          await skills.holdName(scopeOf(skill), skill.name);
          if (!(await skills.retireLearned(spaceId, id, principal.userId, now()))) {
            throw new ServiceError(409, CHANGED);
          }
        });
        return;
      }
      if (skill.sourceId) throw new ServiceError(400, WRITTEN_ONLY);
      await skills.delete(id);
    },

    // Reads the source's branch or tag again and applies it at once: new skills arrive off,
    // removed ones go, changed ones keep their switch unless their new name is on already. A
    // commit already read changes nothing.
    async refresh(principal: Principal, id: string): Promise<SkillRefresh> {
      const source = await manageableSource(principal, id);
      const target = await targetOf(source);
      const scope = scopeOf(source);
      let head: string;
      try {
        head = await git.head(target);
      } catch (err) {
        return gitFailure(err);
      }
      if (head === source.commit) {
        await skills.updateSource(id, { fetchedAt: now() });
        return {
          source: sourceSummary((await skills.findSource(id))!, await skills.inScope(scope)),
          added: [],
          changed: [],
          removed: [],
        };
      }
      const snapshot = await snapshotOf(source, target.token);
      const found = foundIn(snapshot, source);
      const { current, added, changed, removed } = await changesOf(source, found);
      const byPath = new Map(current.map((skill) => [skill.path, skill]));
      for (const skill of removed) await skills.delete(skill.id);
      for (const skill of changed) {
        const before = byPath.get(skill.path)!;
        const clashes =
          before.enabled &&
          before.name !== skill.name &&
          (await onIn(scope, (other) => other.id === before.id)).some(
            (other) => other.name === skill.name,
          );
        await skills.update(before.id, {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          files: skill.files,
          ...(clashes && { enabled: false }),
        });
      }
      for (const skill of added) {
        await skills.create({
          ...scope,
          sourceId: source.id,
          path: skill.path,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          files: skill.files,
          enabled: false,
          createdBy: principal.userId,
        });
      }
      await skills.updateSource(id, {
        commit: snapshot.commit,
        resolvedRef: snapshot.ref,
        fetchedAt: now(),
      });
      return {
        source: sourceSummary((await skills.findSource(id))!, await skills.inScope(scope)),
        added: added.map((skill) => skill.name),
        changed: changed.map((skill) => skill.name),
        removed: removed.map((skill) => skill.name),
      };
    },

    // Changes the token the source is read with, once it reads the source; null forgets it.
    async setToken(principal: Principal, id: string, token: string | null) {
      const source = await manageableSource(principal, id);
      if (token) {
        try {
          await git.head({ url: source.url, ref: source.ref, token });
        } catch (err) {
          return gitFailure(err);
        }
      }
      await skills.setToken(id, token || null);
      return sourceSummary((await skills.findSource(id))!, await skills.inScope(scopeOf(source)));
    },

    async removeSource(principal: Principal, id: string) {
      await manageableSource(principal, id);
      await skills.deleteSource(id);
    },

    // Turns one of the org's sources on or off for the space alone; never on while the org has
    // it off.
    async setSpaceSource(
      principal: Principal,
      spaceId: string,
      sourceId: string,
      enabled: boolean,
    ) {
      const space = await spaces.require(principal, spaceId, "manage");
      if (sourceId === BUILTIN_SOURCE_ID) {
        if (enabled && !(await builtinOf(space.orgId)).source.enabled)
          throw new ServiceError(409, ORG_OFF);
        return skills.setSpaceBuiltin(space.id, sourceId, enabled);
      }
      const source = await skills.findSource(sourceId);
      if (!source || source.orgId !== space.orgId || source.spaceId) {
        throw new ServiceError(404, SOURCE_NOT_FOUND);
      }
      if (enabled && !source.enabled) throw new ServiceError(409, ORG_OFF);
      await skills.setSpaceSource(space.id, source.id, enabled);
    },

    // Turns one of the org's skills on or off for the space alone; never on while the org has it
    // off.
    async setSpaceSkill(principal: Principal, spaceId: string, skillId: string, enabled: boolean) {
      const space = await spaces.require(principal, spaceId, "manage");
      if (isBuiltinId(skillId)) {
        const builtin = await builtinOf(space.orgId);
        const found = builtin.skills.find((candidate) => candidate.id === skillId);
        if (!found) throw new ServiceError(404, NOT_FOUND);
        if (enabled && (!found.enabled || !builtin.source.enabled)) {
          throw new ServiceError(409, ORG_OFF);
        }
        return skills.setSpaceBuiltin(space.id, skillId, enabled);
      }
      const skill = await skills.find(skillId);
      if (!skill || skill.orgId !== space.orgId || skill.spaceId) {
        throw new ServiceError(404, NOT_FOUND);
      }
      const source = skill.sourceId ? await skills.findSource(skill.sourceId) : null;
      if (enabled && (!skill.enabled || (source && !source.enabled))) {
        throw new ServiceError(409, ORG_OFF);
      }
      await skills.setSpaceSkill(space.id, skill.id, enabled);
    },

    // Saves a skill the agent learned for the thread's space: never under the name of a command,
    // a built-in or org skill, or one a person wrote or added; under one the space learned only to
    // update it. Writes of one name in a space run one at a time; a second run of a call gives
    // back what the first saved.
    async learn(
      ctx: Pick<
        ToolContext,
        "orgId" | "spaceId" | "threadId" | "callId" | "influence" | "approvedBy"
      >,
      input: LearnInput,
    ): Promise<{ ok: true; value: object } | { ok: false; error: string }> {
      const saved = (done: { name: string; updated: boolean }) => ({
        ok: true as const,
        value: { name: done.name, ...(done.updated && { updated: true }), note: USABLE },
      });
      const done = await skills.learnedOfCall(ctx.threadId, ctx.callId);
      if (done) return saved(done);
      const { name } = input;
      if (COMMANDS.has(name))
        return { ok: false, error: `${name} is a command; choose another name` };
      try {
        const updated = await options.transact(async () => {
          await skills.holdName({ orgId: ctx.orgId, spaceId: ctx.spaceId }, name);
          const set = await spaceSkills({ id: ctx.spaceId, orgId: ctx.orgId });
          if (!set.allowed) throw new Refusal(SPACES_OFF);
          if (set.orgSkills.some((skill) => skill.name === name)) {
            throw new Refusal(`${name} is a built-in or organization skill; choose another name`);
          }
          const current = set.ownSkills.find((skill) => skill.name === name && skill.learned);
          if (set.ownSkills.some((skill) => skill.name === name && !skill.learned)) {
            throw new Refusal(
              `${name} was written by a person; only learned skills can be updated here`,
            );
          }
          if (current && !input.update) {
            throw new Refusal(`A skill named ${name} already exists here; set update to change it`);
          }
          const old = current && (await skills.retireLearned(ctx.spaceId, current.id, null, now()));
          if (current && !old) {
            throw new Refusal(`${name} was changed or deleted as this saved; save it again`);
          }
          const made = await skills.createLearned({
            spaceId: ctx.spaceId,
            name,
            description: input.description,
            body: input.instructions,
            files: input.files ?? [],
            threadId: ctx.threadId,
            callId: ctx.callId,
            influence: ctx.influence,
            approvedBy: ctx.approvedBy ?? null,
            supersedesId: current?.id ?? null,
            // An update keeps the switch a manager set.
            enabled: old ? old.enabled : true,
          });
          // Another run of the call saved first: this one's retire rolls back.
          if (!made) throw new Replayed();
          return !!current;
        });
        return saved({ name, updated });
      } catch (err) {
        if (err instanceof Refusal) return { ok: false, error: err.message };
        if (!(err instanceof Replayed)) throw err;
        return saved((await skills.learnedOfCall(ctx.threadId, ctx.callId))!);
      }
    },

    // The built-in Skills toolset: loading a skill that is on in the thread's space, and reading
    // one of its files; always on where a skill is on, with no switch and no policy.
    toolset(): Toolset {
      const named = async (space: Pick<Space, "id" | "orgId">, name: string) =>
        (await effectiveIn(space)).find((skill) => skill.name === name);
      const missing = async (space: Pick<Space, "id" | "orgId">, name: string) => {
        const names = (await effectiveIn(space)).map((skill) => skill.name);
        return {
          ok: false as const,
          error: names.length
            ? `No skill named ${name} is on here. The skills here: ${names.join(", ")}.`
            : `No skill named ${name} is on here. There are no skills here.`,
        };
      };
      const nameInput = z.string().trim().min(1).meta({ title: "Skill", description: "Its name" });

      const load: ToolSpec<{ name: string }> = {
        name: LOAD_SKILL,
        title: "Load",
        annotations: { readOnlyHint: true },
        description: "Load a skill by name: its instructions and its file list.",
        input: z.object({ name: nameInput }),
        risk: () => "normal",
        async run({ name }, ctx) {
          const space = { id: ctx.spaceId, orgId: ctx.orgId };
          const skill = await named(space, name);
          if (!skill) return Promise.resolve(await missing(space, name));
          const scripts = scriptFilesOf(skill);
          return Promise.resolve({
            ok: true,
            value: {
              name: skill.name,
              description: skill.description,
              instructions: await instructionsOf(space, skill, ctx.named),
              files: skill.files.map((file) => file.path),
              ...(scripts.length > 0 && {
                scripts: `Run each with ${ctx.named(RUN_SCRIPT)} by file, its values in inputs: ${scripts.map((ref) => `file="${ref}"`).join(", ")}.`,
              }),
            },
          });
        },
      };

      const readFile: ToolSpec<{ name: string; path: string }> = {
        name: READ_SKILL_FILE,
        title: "Read file",
        annotations: { readOnlyHint: true },
        description: "Read a skill's file by skill name and path.",
        input: z.object({
          name: nameInput,
          path: z
            .string()
            .trim()
            .min(1)
            .meta({ title: "Path", description: "As the skill lists it" }),
        }),
        risk: () => "normal",
        async run({ name, path }, ctx) {
          const space = { id: ctx.spaceId, orgId: ctx.orgId };
          const skill = await named(space, name);
          if (!skill) return Promise.resolve(await missing(space, name));
          const file = skill.files.find((candidate) => candidate.path === path);
          if (!file) {
            return Promise.resolve({
              ok: false,
              error: `${name} has no file ${path}. Its files: ${
                skill.files.map((candidate) => candidate.path).join(", ") || "none"
              }.`,
            });
          }
          return Promise.resolve({ ok: true, value: { path: file.path, text: file.text } });
        },
      };

      return {
        id: SKILLS_TOOLSET,
        title: "Skills",
        source: "builtin",
        tools: [load, readFile],
        load: effectiveIn,
        // Offered only where some skill is on.
        usefulIn: (_space, { loaded }) => (loaded as Skill[]).length > 0,
        fixed: true,
        // Every org has the built-in skills, so settings always show it.
        listedIn: () => true,
        // A call that loads a skill names the skill.
        present: async () => (row) => {
          const named = (row.input as { name?: unknown } | null)?.name;
          return row.toolId === LOAD_SKILL && typeof named === "string"
            ? { names: { skill: named } }
            : undefined;
        },
      };
    },
  };
}

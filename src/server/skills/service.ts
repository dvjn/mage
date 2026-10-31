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

import * as z from "zod";

import type { Principal } from "@/server/orgs/identity.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import type { OrgSettingStore } from "@/server/orgs/service.ts";
import type { Space, Spaces } from "@/server/spaces/service.ts";
import type { AnyToolSpec, Toolset, ToolSpec } from "@/server/agent/tools.ts";
import type { Guidance } from "@/server/agent/context.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
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
}

export type NewSkill = Pick<
  Skill,
  "orgId" | "spaceId" | "sourceId" | "path" | "name" | "description" | "body" | "files" | "enabled"
> & { createdBy: string };

export type SkillChanges = Partial<
  Pick<Skill, "name" | "description" | "body" | "files" | "enabled">
>;

export interface SkillStore {
  createSource(source: NewSkillSource): SkillSource;
  findSource(id: string): SkillSource | null;
  // The sources of the scope: the org's own when no space is given.
  sources(scope: Scope): SkillSource[];
  updateSource(
    id: string,
    changes: Partial<Pick<SkillSource, "enabled" | "commit" | "resolvedRef" | "fetchedAt">>,
  ): void;
  // Deletes the source with its skills.
  deleteSource(id: string): void;
  // The token a private source is read with, sealed at rest; null to forget it.
  token(id: string): string | null;
  setToken(id: string, token: string | null): void;

  create(skill: NewSkill): Skill;
  find(id: string): Skill | null;
  // Every skill of the scope, from its sources and written there.
  inScope(scope: Scope): Skill[];
  update(id: string, changes: SkillChanges): void;
  delete(id: string): void;

  // What a space set for the org's sources and skills, for those it set.
  spaceSourceSettings(spaceId: string): Map<string, boolean>;
  setSpaceSource(spaceId: string, sourceId: string, enabled: boolean): void;
  spaceSkillSettings(spaceId: string): Map<string, boolean>;
  setSpaceSkill(spaceId: string, skillId: string, enabled: boolean): void;
}

export interface SkillsOptions {
  skills: SkillStore;
  git: GitReader;
  archives: ArchiveReader;
  spaces: Pick<Spaces, "require">;
  settings: Pick<OrgSettingStore, "get" | "setSpaceSkills">;
  logger: Logger;
  now?: () => Date;
}

export type Skills = ReturnType<typeof createSkills>;

const ORG_ONLY = "Only the organization's owners can manage its skills";
const SPACES_OFF = "The organization does not let spaces add skills";
const ORG_OFF = "The organization turned this off";
const NOT_FOUND = "Skill not found";
const SOURCE_NOT_FOUND = "Skill source not found";
const WRITTEN_ONLY = "Only skills written here can be changed; update the source instead";

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

export function createSkills(options: SkillsOptions) {
  const { skills, git, archives, spaces, settings, logger } = options;
  const now = options.now ?? (() => new Date());

  function spacesMayAdd(orgId: string) {
    return settings.get(orgId).spaceSkills;
  }

  // The scope the principal manages: the org's for its owners, or a space's for its managers.
  function managed(principal: Principal, spaceId: string | null): Scope {
    if (spaceId) {
      const space = spaces.require(principal, spaceId, "manage");
      return { orgId: space.orgId, spaceId: space.id };
    }
    if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
    return { orgId: principal.orgId, spaceId: null };
  }

  // A scope the principal may add skills to: as above, for a space only while the org lets it.
  function addable(principal: Principal, spaceId: string | null) {
    const scope = managed(principal, spaceId);
    if (scope.spaceId && !spacesMayAdd(scope.orgId)) throw new ServiceError(403, SPACES_OFF);
    return scope;
  }

  function scopeOf(item: { orgId: string; spaceId: string | null }): Scope {
    return { orgId: item.orgId, spaceId: item.spaceId };
  }

  function manageableSource(principal: Principal, id: string) {
    const source = skills.findSource(id);
    if (!source || source.orgId !== principal.orgId) throw new ServiceError(404, SOURCE_NOT_FOUND);
    managed(principal, source.spaceId);
    return source;
  }

  function manageableSkill(principal: Principal, id: string) {
    const skill = skills.find(id);
    if (!skill || skill.orgId !== principal.orgId) throw new ServiceError(404, NOT_FOUND);
    managed(principal, skill.spaceId);
    return skill;
  }

  // The skills on in the scope, but the one given.
  function onIn(scope: Scope, except: (skill: Skill) => boolean = () => false) {
    const sources = byId(skills.sources(scope));
    return skills.inScope(scope).filter((skill) => onInScope(skill, sources) && !except(skill));
  }

  // Refuses to turn on skills of these names where one of each is on already, or where two share
  // a name.
  function refuseClashes(scope: Scope, names: string[], except: (skill: Skill) => boolean) {
    const on = new Set(onIn(scope, except).map((skill) => skill.name));
    const seen = new Set<string>();
    for (const name of names) {
      if (on.has(name) || seen.has(name)) throw new ServiceError(409, alreadyOn(name));
      seen.add(name);
    }
  }

  function skillSummary(skill: Skill): SkillSummary {
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
      skills: all.filter((skill) => skill.sourceId === source.id).map(skillSummary),
    };
  }

  // The scope's sources with their skills, and the skills written there.
  function listed(scope: Scope) {
    const all = skills.inScope(scope);
    return {
      sources: skills.sources(scope).map((source) => sourceSummary(source, all)),
      written: all.filter((skill) => !skill.sourceId).map(skillSummary),
    };
  }

  function spaceSkills(space: Pick<Space, "id" | "orgId">): SpaceSkills {
    const org = { orgId: space.orgId, spaceId: null };
    const own = { orgId: space.orgId, spaceId: space.id };
    return {
      orgSources: skills.sources(org),
      orgSkills: skills.inScope(org),
      ownSources: skills.sources(own),
      ownSkills: skills.inScope(own),
      sourceSwitches: skills.spaceSourceSettings(space.id),
      skillSwitches: skills.spaceSkillSettings(space.id),
      allowed: spacesMayAdd(space.orgId),
    };
  }

  function effectiveIn(space: Pick<Space, "id" | "orgId">) {
    return effectiveSkills(spaceSkills(space));
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
    const scope = addable(principal, spaceId);
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
    const on = new Set(onIn(scope).map((skill) => skill.name));
    const added = found.map((skill) =>
      skills.create({
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
    return { status: "added", skills: added.map(skillSummary) };
  }

  // Adds the whole repository, every skill found in it off until someone turns it on.
  async function addSource(principal: Principal, spaceId: string | null, input: SkillSourceInput) {
    const scope = addable(principal, spaceId);
    const parsed = parsedOf(input.input);
    const token = input.token ?? null;
    const snapshot = await snapshotOf(parsed, token);
    const found = foundIn(snapshot, parsed);
    const source = skills.createSource({
      ...scope,
      label: parsed.label,
      url: parsed.url,
      ref: parsed.ref,
      resolvedRef: snapshot.ref,
      subpath: parsed.subpath,
      commit: snapshot.commit,
      createdBy: principal.userId,
    });
    if (token) skills.setToken(source.id, token);
    for (const skill of found) {
      skills.create({
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
    return sourceSummary(skills.findSource(source.id)!, skills.inScope(scope));
  }

  function targetOf(source: SkillSource) {
    return { url: source.url, ref: source.ref, token: skills.token(source.id) };
  }

  // What reading the source again changes, by folder: skills added, changed and removed.
  function changesOf(source: SkillSource, found: FoundSkill[]) {
    const current = skills.inScope(scopeOf(source)).filter((skill) => skill.sourceId === source.id);
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

    // The skills on in the space, as the agent's prompt lists them, when it can load them.
    listFor(
      space: Pick<Space, "id" | "orgId">,
      offered: readonly AnyToolSpec[],
    ): Guidance["skills"] {
      if (!offered.some((spec) => spec.name === LOAD_SKILL)) return [];
      return effectiveIn(space).map(line);
    },

    // The org's skills, which its members may read.
    orgSkills(principal: Principal): OrgSkillList {
      const scope = { orgId: principal.orgId, spaceId: null };
      return { ...listed(scope), spaceSkills: spacesMayAdd(principal.orgId) };
    },

    setSpaceSkills(principal: Principal, allowed: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
      settings.setSpaceSkills(principal.orgId, allowed);
    },

    // A space's: the org's skills, each with the space's switch, and its own.
    spaceSkills(principal: Principal, spaceId: string): SpaceSkillList {
      const space = spaces.require(principal, spaceId);
      const org = { orgId: space.orgId, spaceId: null };
      const own = { orgId: space.orgId, spaceId: space.id };
      const sourceSwitches = skills.spaceSourceSettings(space.id);
      const skillSwitches = skills.spaceSkillSettings(space.id);
      const inSpace = (skill: SkillSummary) => ({
        ...skill,
        inSpace: skillSwitches.get(skill.id) !== false,
      });
      const orgListed = listed(org);
      return {
        org: {
          sources: orgListed.sources.map((source) => ({
            ...source,
            inSpace: sourceSwitches.get(source.id) !== false,
            skills: source.skills.map(inSpace),
          })),
          written: orgListed.written.map(inSpace),
        },
        own: listed(own),
        allowed: spacesMayAdd(space.orgId),
      };
    },

    addSource,

    // Turns the whole source on or off; on, none of its skills may clash with one on.
    setSourceEnabled(principal: Principal, id: string, enabled: boolean) {
      const source = manageableSource(principal, id);
      if (enabled && !source.enabled) {
        const scope = scopeOf(source);
        const names = skills
          .inScope(scope)
          .filter((skill) => skill.sourceId === id && skill.enabled)
          .map((skill) => skill.name);
        refuseClashes(scope, names, (skill) => skill.sourceId === id);
      }
      skills.updateSource(id, { enabled });
    },

    setSkillEnabled(principal: Principal, id: string, enabled: boolean) {
      const skill = manageableSkill(principal, id);
      if (enabled) refuseClashes(scopeOf(skill), [skill.name], (other) => other.id === id);
      skills.update(id, { enabled });
    },

    // The skill with its instructions and files, for anyone who may read its scope.
    get(principal: Principal, id: string): SkillDetail {
      const skill = skills.find(id);
      if (!skill || skill.orgId !== principal.orgId) throw new ServiceError(404, NOT_FOUND);
      if (skill.spaceId) spaces.require(principal, skill.spaceId);
      return { ...skillSummary(skill), body: skill.body, files: skill.files };
    },

    // Writes a skill in settings, on unless one of its name is.
    write(principal: Principal, spaceId: string | null, input: SkillInput): SkillSummary {
      const scope = addable(principal, spaceId);
      refuseClashes(scope, [input.name], () => false);
      return skillSummary(
        skills.create({
          ...scope,
          sourceId: null,
          path: null,
          ...input,
          files: [],
          enabled: true,
          createdBy: principal.userId,
        }),
      );
    },

    edit(principal: Principal, id: string, input: SkillInput): SkillSummary {
      const skill = manageableSkill(principal, id);
      if (skill.sourceId) throw new ServiceError(400, WRITTEN_ONLY);
      if (skill.enabled) refuseClashes(scopeOf(skill), [input.name], (other) => other.id === id);
      skills.update(id, input);
      return skillSummary(skills.find(id)!);
    },

    upload,

    remove(principal: Principal, id: string) {
      const skill = manageableSkill(principal, id);
      if (skill.sourceId) throw new ServiceError(400, WRITTEN_ONLY);
      skills.delete(id);
    },

    // Reads the source's branch or tag again and applies it at once: new skills arrive off,
    // removed ones go, changed ones keep their switch unless their new name is on already. A
    // commit already read changes nothing.
    async refresh(principal: Principal, id: string): Promise<SkillRefresh> {
      const source = manageableSource(principal, id);
      const target = targetOf(source);
      const scope = scopeOf(source);
      let head: string;
      try {
        head = await git.head(target);
      } catch (err) {
        return gitFailure(err);
      }
      if (head === source.commit) {
        skills.updateSource(id, { fetchedAt: now() });
        return {
          source: sourceSummary(skills.findSource(id)!, skills.inScope(scope)),
          added: [],
          changed: [],
          removed: [],
        };
      }
      const snapshot = await snapshotOf(source, target.token);
      const found = foundIn(snapshot, source);
      const { current, added, changed, removed } = changesOf(source, found);
      const byPath = new Map(current.map((skill) => [skill.path, skill]));
      for (const skill of removed) skills.delete(skill.id);
      for (const skill of changed) {
        const before = byPath.get(skill.path)!;
        const clashes =
          before.enabled &&
          before.name !== skill.name &&
          onIn(scope, (other) => other.id === before.id).some((other) => other.name === skill.name);
        skills.update(before.id, {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          files: skill.files,
          ...(clashes && { enabled: false }),
        });
      }
      for (const skill of added) {
        skills.create({
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
      skills.updateSource(id, {
        commit: snapshot.commit,
        resolvedRef: snapshot.ref,
        fetchedAt: now(),
      });
      return {
        source: sourceSummary(skills.findSource(id)!, skills.inScope(scope)),
        added: added.map((skill) => skill.name),
        changed: changed.map((skill) => skill.name),
        removed: removed.map((skill) => skill.name),
      };
    },

    // Changes the token the source is read with, once it reads the source; null forgets it.
    async setToken(principal: Principal, id: string, token: string | null) {
      const source = manageableSource(principal, id);
      if (token) {
        try {
          await git.head({ url: source.url, ref: source.ref, token });
        } catch (err) {
          return gitFailure(err);
        }
      }
      skills.setToken(id, token || null);
      return sourceSummary(skills.findSource(id)!, skills.inScope(scopeOf(source)));
    },

    removeSource(principal: Principal, id: string) {
      manageableSource(principal, id);
      skills.deleteSource(id);
    },

    // Turns one of the org's sources on or off for the space alone; never on while the org has
    // it off.
    setSpaceSource(principal: Principal, spaceId: string, sourceId: string, enabled: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      const source = skills.findSource(sourceId);
      if (!source || source.orgId !== space.orgId || source.spaceId) {
        throw new ServiceError(404, SOURCE_NOT_FOUND);
      }
      if (enabled && !source.enabled) throw new ServiceError(409, ORG_OFF);
      skills.setSpaceSource(space.id, source.id, enabled);
    },

    // Turns one of the org's skills on or off for the space alone; never on while the org has it
    // off.
    setSpaceSkill(principal: Principal, spaceId: string, skillId: string, enabled: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      const skill = skills.find(skillId);
      if (!skill || skill.orgId !== space.orgId || skill.spaceId) {
        throw new ServiceError(404, NOT_FOUND);
      }
      const source = skill.sourceId ? skills.findSource(skill.sourceId) : null;
      if (enabled && (!skill.enabled || (source && !source.enabled))) {
        throw new ServiceError(409, ORG_OFF);
      }
      skills.setSpaceSkill(space.id, skill.id, enabled);
    },

    // The built-in Skills toolset: loading a skill that is on in the thread's space, and reading
    // one of its files; offered only where a skill is on.
    toolset(): Toolset {
      const named = (space: Pick<Space, "id" | "orgId">, name: string) =>
        effectiveIn(space).find((skill) => skill.name === name);
      const missing = (space: Pick<Space, "id" | "orgId">, name: string) => {
        const names = effectiveIn(space).map((skill) => skill.name);
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
        description:
          "Load a skill by name: its instructions, and the files that come with it. Load one when the task matches its description, before you start.",
        input: z.object({ name: nameInput }),
        risk: () => "normal",
        run({ name }, ctx) {
          const space = { id: ctx.spaceId, orgId: ctx.orgId };
          const skill = named(space, name);
          if (!skill) return Promise.resolve(missing(space, name));
          return Promise.resolve({
            ok: true,
            value: {
              name: skill.name,
              description: skill.description,
              instructions: skill.body,
              files: skill.files.map((file) => file.path),
            },
          });
        },
      };

      const readFile: ToolSpec<{ name: string; path: string }> = {
        name: READ_SKILL_FILE,
        title: "Read file",
        annotations: { readOnlyHint: true },
        description:
          "Read one of the files that come with a skill, by the skill's name and the file's path.",
        input: z.object({
          name: nameInput,
          path: z
            .string()
            .trim()
            .min(1)
            .meta({ title: "Path", description: "As the skill lists it" }),
        }),
        risk: () => "normal",
        run({ name, path }, ctx) {
          const space = { id: ctx.spaceId, orgId: ctx.orgId };
          const skill = named(space, name);
          if (!skill) return Promise.resolve(missing(space, name));
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
        // Offered only where some skill is on.
        usefulIn: (space) => effectiveIn(space).length > 0,
      };
    },
  };
}

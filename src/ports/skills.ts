// The skills orgs and spaces keep for the agent (each from a repository source, or written or
// uploaded in settings) with the switches spaces set on the org's, and
// reading a repository's files at one commit, or an uploaded archive's, to find skills in.

import type { SkillFile } from "@/shared/skills.ts";

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

// A repository to read: where it is, the branch or tag (null for its default), and a token for a
// private one.
export interface GitTarget {
  url: string;
  ref: string | null;
  token: string | null;
}

// A repository's text files at one commit, by their path from its root.
export interface GitSnapshot {
  commit: string;
  // The branch or tag read, when known.
  ref: string | null;
  files: { path: string; text: string }[];
}

// Why a repository could not be read: not found or not open without a token, too large, or not
// reached at all.
export class GitError extends Error {
  readonly kind: "auth" | "not_found" | "too_large" | "unreachable";

  constructor(kind: GitError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface GitReader {
  // The commit the branch or tag points to now. Throws GitError.
  head(target: GitTarget): Promise<string>;
  // The text files at the branch or tag, read shallowly, under the folder when one is given.
  // Throws GitError.
  snapshot(target: GitTarget, subpath: string | null): Promise<GitSnapshot>;
}

// Why an uploaded archive could not be read: too large, or not an archive.
export class ArchiveError extends Error {
  readonly kind: "too_large" | "invalid";

  constructor(kind: ArchiveError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ArchiveReader {
  // The text files in the archive, by their path in it. Throws ArchiveError.
  files(data: Uint8Array): { path: string; text: string }[];
}

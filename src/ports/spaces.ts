// Spaces hold an org's threads; their members are who can see them. A role comes to a person
// directly, through a group they are in, or, in a shared space, through being in its org.

import type { Page, PageParams } from "@/shared/paging.ts";
import type { Effort } from "@/shared/threads.ts";

// Owners manage the space; messagers and owners post; viewers only read.
export type SpaceRole = "owner" | "messager" | "viewer";

export type EveryoneRole = Exclude<SpaceRole, "owner">;

// Who a role is given to: a person, or every member of a group.
export interface Subject {
  kind: "user" | "group";
  id: string;
}

// A role given in a space, with the name of whom it is given to.
export interface Grant {
  subject: Subject;
  role: SpaceRole;
  name: string;
  // A person's email; null for a group.
  email: string | null;
  createdAt: Date;
}

export interface Space {
  id: string;
  orgId: string;
  kind: "personal" | "shared";
  name: string;
  // The space a personal org starts with; it can be renamed but not deleted.
  primary: boolean;
  // The model ref and reasoning effort its new threads start with; null takes the org's.
  defaultModel: string | null;
  defaultEffort: Effort | null;
  // The role everyone in the org has in a shared space; null for none.
  everyoneRole: EveryoneRole | null;
  // Null once the user who made it is gone.
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSpace {
  orgId: string;
  kind: Space["kind"];
  name: string;
  primary?: boolean;
  everyoneRole?: EveryoneRole | null;
  createdBy: string;
}

// A space as its org's owners see it in the list of all its spaces.
export interface CatalogSpace extends Space {
  // Its name as everyone sees it, and who made it.
  displayName: string;
  ownerName: string | null;
  // How many people and groups have a role in it, and whether it has threads.
  memberCount: number;
  hasThreads: boolean;
}

export interface SpaceStore {
  // Makes the space with its creator as owner.
  create(space: NewSpace): Space;
  find(id: string): Space | null;
  // The org's spaces: primary ones first, then oldest first.
  listInOrg(orgId: string): Space[];
  // The user's highest role in each of the org's spaces where they have one: given to them, to a
  // group of theirs, or to everyone in the org while they are in it.
  rolesIn(orgId: string, userId: string): Map<string, SpaceRole>;
  // The user's highest role in the space, as above, or null when they have none.
  roleOf(spaceId: string, userId: string): SpaceRole | null;
  // The roles given in the space to people and groups: people first, then groups, by name.
  grants(spaceId: string): Grant[];
  // A page of them, matching the text in the name or email, of the role if given.
  grantPage(spaceId: string, params: PageParams & { role?: SpaceRole }): Page<Grant>;
  // A page of the org's spaces by the name everyone sees, matching the text in it, of the kind and
  // everyone's role if given ("none" for shared spaces open to no one in the org).
  catalogPage(
    orgId: string,
    params: PageParams & { kind?: Space["kind"]; everyone?: EveryoneRole | "none" },
  ): Page<CatalogSpace>;
  // Gives the subject the role in the space, or changes the one it has.
  grant(spaceId: string, subject: Subject, role: SpaceRole): void;
  revoke(spaceId: string, subject: Subject): void;
  setEveryoneRole(id: string, role: EveryoneRole | null): Space;
  // The user's own private space in a team org, or null when they have none.
  memberSpaceOf(orgId: string, userId: string): Space | null;
  // The org's spaces whose default model is one of the refs.
  withDefaultModel(orgId: string, refs: string[]): Space[];
  rename(id: string, name: string): Space;
  // Null goes back to the org's; a field left out is kept.
  setDefaults(id: string, changes: { model?: string | null; effort?: Effort | null }): Space;
  delete(id: string): void;
}

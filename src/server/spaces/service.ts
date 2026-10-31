// An org's spaces as its people see them: listing, creating, renaming and deleting empty ones,
// setting the model and effort their new threads start with, who is in a shared space and with
// what role, and the one rule for what each person may do in a space. A person's role is the
// highest of the one given to them, those given to their groups and, in a shared space, the one
// given to everyone in the org. A team org's owners manage its shared spaces without a role there,
// but read their threads only once they give themselves one.

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Models } from "@/server/models/service.ts";
import type { Directory, OrgRole } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { OrgSettingStore } from "@/server/orgs/service.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import type { PageParams, Page } from "@/shared/paging.ts";
import {
  FIRST_SPACE_NAME,
  namedForPerson,
  type SpaceMembers,
  spaceNameFor,
} from "@/shared/spaces.ts";
import type { Effort } from "@/shared/threads/thread.ts";

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

export interface SpacesOptions {
  spaces: SpaceStore;
  threads: Pick<ThreadStore, "anyInSpace">;
  models: Pick<Models, "requireModel">;
  directory: Pick<
    Directory,
    "org" | "roleIn" | "linkedRole" | "groupIdsOf" | "memberCount" | "user"
  >;
  settings: Pick<OrgSettingStore, "get">;
  // Told when people may have lost a role in the org's spaces.
  accessChanged?: (orgId: string) => void;
  hooks?: Hooks;
}

export type Spaces = ReturnType<typeof createSpaces>;

// Reading the space's threads; posting, steering, queueing and stopping in them; managing the space.
export type SpaceAction = "read" | "message" | "manage";

const ALLOWED: Record<SpaceRole, readonly SpaceAction[]> = {
  owner: ["read", "message", "manage"],
  messager: ["read", "message"],
  viewer: ["read"],
};

const RANK: Record<SpaceRole, number> = { viewer: 1, messager: 2, owner: 3 };

const REFUSED: Record<SpaceAction, string> = {
  read: "Space not found",
  message: "Only the space's messagers and owners can do this",
  manage: "Only the space's owner can do this",
};

// Who acts: their org role is known for signed-in people, not for the authors of waiting messages.
type Who = Pick<Principal, "userId" | "orgId"> & { role?: OrgRole };

export type SpaceView = Space & { role: SpaceRole | null; manage: boolean };

export function createSpaces(options: SpacesOptions) {
  const { spaces, threads, models, directory, settings } = options;
  const accessChanged = options.accessChanged ?? (() => {});

  // Someone new starts with their own space in their personal org.
  options.hooks?.on("person.signedUp", ({ userId, orgId }) => {
    spaces.create({
      orgId,
      kind: "personal",
      name: FIRST_SPACE_NAME,
      primary: true,
      createdBy: userId,
    });
  });

  // The person's role in the space, or null when its org is not theirs or they have none.
  function roleIn(who: Who, space: Space) {
    return space.orgId === who.orgId ? spaces.roleOf(space.id, who.userId) : null;
  }

  // An owner of the space's team org, who manages its shared spaces.
  function orgManages(who: Who, space: Space) {
    return space.orgId === who.orgId && who.role === "owner" && space.kind === "shared";
  }

  // The one rule for what a person may do in a space: their org owns it and their role there
  // allows the action, or they own the org and manage its shared spaces.
  function can(who: Who, space: Space, action: SpaceAction) {
    const role = roleIn(who, space);
    if (role !== null && ALLOWED[role].includes(action)) return true;
    return action === "manage" && orgManages(who, space);
  }

  function canSee(who: Who, space: Space) {
    return can(who, space, "read");
  }

  // The space with the person's role when they can read it, otherwise null.
  function findVisible(who: Who, id: string): (Space & { role: SpaceRole }) | null {
    const space = spaces.find(id);
    const role = space && roleIn(who, space);
    return space && role ? { ...space, role } : null;
  }

  // The space as the person sees it, named for them.
  function view(who: Who, space: Space, role = roleIn(who, space)): SpaceView {
    const owner = space.createdBy ? directory.user(space.createdBy)?.name : null;
    const name = spaceNameFor(space, owner ?? "A former member");
    return { ...space, name, role, manage: can(who, space, "manage") };
  }

  // The space when the principal may take the action there. A space they cannot see is not found,
  // so its existence does not leak; one they can see but not act on is forbidden.
  function require(principal: Who, id: string, action: SpaceAction = "read"): SpaceView {
    const space = spaces.find(id);
    const role = space && roleIn(principal, space);
    if (!space || (!role && !orgManages(principal, space))) {
      throw new ServiceError(404, REFUSED.read);
    }
    if (!can(principal, space, action)) {
      throw new ServiceError(
        403,
        role ? REFUSED[action] : "Add yourself in Members to read its threads",
      );
    }
    return view(principal, space, role);
  }

  // The shared space, for changing who is in it.
  function requireShared(principal: Principal, id: string) {
    const space = require(principal, id, "manage");
    if (space.kind !== "shared") {
      throw new ServiceError(409, "A private space has no other members");
    }
    return space;
  }

  // Whether the principal may make spaces in their org.
  function canCreate(principal: Principal) {
    if (principal.role === "owner") return true;
    return settings.get(principal.orgId).spaceCreation === "members";
  }

  return {
    can,
    canSee,
    canCreate,
    findVisible,
    require,

    // The spaces the principal has a role in and, for a team org's owners, its other shared ones.
    list(principal: Principal): SpaceView[] {
      const roles = spaces.rolesIn(principal.orgId, principal.userId);
      return spaces
        .listInOrg(principal.orgId)
        .filter((space) => roles.has(space.id) || orgManages(principal, space))
        .map((space) => view(principal, space, roles.get(space.id) ?? null));
    },

    // A page of every space of a team org for its owners, shared ones and its members' private
    // ones, with who made each, how many people and groups have a role there, and whether it has
    // threads.
    catalog(
      principal: Principal,
      params: PageParams & { kind?: Space["kind"]; everyone?: EveryoneRole | "none" },
    ) {
      if (directory.org(principal.orgId)?.kind !== "team" || principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can see all its spaces");
      }
      const roles = spaces.rolesIn(principal.orgId, principal.userId);
      const page = spaces.catalogPage(principal.orgId, params);
      return {
        ...page,
        items: page.items.map(({ displayName, ownerName, memberCount, hasThreads, ...space }) => ({
          ...view(principal, space, roles.get(space.id) ?? null),
          name: displayName,
          ownerName,
          memberCount,
          hasThreads,
        })),
      };
    },

    // In a team org a new space is shared; in a personal one, private.
    create(principal: Principal, name: string): SpaceView {
      const team = directory.org(principal.orgId)?.kind === "team";
      if (team && !canCreate(principal)) {
        throw new ServiceError(403, "Only the organization's owners can make spaces");
      }
      const space = spaces.create({
        orgId: principal.orgId,
        kind: team ? "shared" : "personal",
        name,
        createdBy: principal.userId,
      });
      return view(principal, space, "owner");
    },

    // Gives a member of a team org their own private space, unless the org turned that off or
    // they have one.
    ensureMemberSpace(orgId: string, userId: string) {
      if (directory.org(orgId)?.kind !== "team" || !settings.get(orgId).memberSpaces) return null;
      return (
        spaces.memberSpaceOf(orgId, userId) ??
        spaces.create({
          orgId,
          kind: "personal",
          name: FIRST_SPACE_NAME,
          primary: true,
          createdBy: userId,
        })
      );
    },

    // A person's own space keeps their name.
    rename(principal: Principal, id: string, name: string) {
      const space = require(principal, id, "manage");
      if (namedForPerson(space)) {
        throw new ServiceError(409, "A personal space is named for its person");
      }
      return view(principal, spaces.rename(id, name));
    },

    // A default model must be one the org can use now; null goes back to the org's.
    async setDefaults(
      principal: Principal,
      id: string,
      changes: { model?: string | null; effort?: Effort | null },
    ) {
      require(principal, id, "manage");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      require(principal, id, "manage");
      return view(principal, spaces.setDefaults(id, changes));
    },

    remove(principal: Principal, id: string) {
      const space = require(principal, id, "manage");
      if (space.primary) throw new ServiceError(409, `${space.name} cannot be deleted`);
      if (threads.anyInSpace(id)) {
        throw new ServiceError(409, "Only a space without threads can be deleted");
      }
      spaces.delete(id);
    },

    // Who is in the space and how, a page at a time: the roles given to people and groups, and to
    // everyone in the org; each person's role as it works out, and what gives it when that is not
    // their own. The asker may not change their own role, nor the last owner's.
    members(
      principal: Principal,
      id: string,
      params: PageParams & { role?: SpaceRole },
    ): SpaceMembers {
      const found = spaces.find(id);
      const space = require(principal, id, found && can(principal, found, "manage")
        ? "manage"
        : "read");
      const orgName = directory.org(space.orgId)?.name ?? "";
      const all = spaces.grants(id);
      const groupGrants = all.filter((grant) => grant.subject.kind === "group");
      const owners = all.filter(
        (grant) => grant.subject.kind === "user" && grant.role === "owner",
      ).length;
      const page = spaces.grantPage(id, params);
      return {
        kind: space.kind,
        everyoneRole: space.everyoneRole,
        orgName,
        grants: {
          ...page,
          items: page.items.map((grant) => {
            const { subject, role, name, email } = grant;
            let effective = role;
            let via: { name: string; groupId: string | null } | null = null;
            const groups =
              subject.kind === "user" ? directory.groupIdsOf(space.orgId, subject.id) : [];
            const covering = groupGrants.filter((other) => groups.includes(other.subject.id));
            for (const other of covering) {
              if (RANK[other.role] > RANK[effective]) {
                effective = other.role;
                via = { name: other.name, groupId: other.subject.id };
              }
            }
            if (
              subject.kind === "user" &&
              space.everyoneRole &&
              RANK[space.everyoneRole] > RANK[effective]
            ) {
              effective = space.everyoneRole;
              via = { name: `Everyone in ${orgName}`, groupId: null };
            }
            return {
              kind: subject.kind,
              id: subject.id,
              name,
              email,
              role,
              effective,
              via: via?.name ?? null,
              viaGroupId: via?.groupId ?? null,
              coveredBy: covering.map((other) => ({ name: other.name, role: other.role })),
              memberCount: subject.kind === "group" ? directory.memberCount(subject.id) : null,
              locked:
                subject.kind !== "user"
                  ? null
                  : subject.id === principal.userId
                    ? ("self" as const)
                    : role === "owner" && owners <= 1
                      ? ("last_owner" as const)
                      : null,
            };
          }),
        },
      };
    },

    // Gives a person or group of the org a role in the shared space, changes it, or with null
    // takes it away.
    setMember(principal: Principal, id: string, subject: Subject, role: SpaceRole | null) {
      const space = requireShared(principal, id);
      if (subject.kind === "user" && !directory.roleIn(space.orgId, subject.id)) {
        throw new ServiceError(404, "Member not found");
      }
      if (subject.kind === "group" && !directory.linkedRole(space.orgId, subject.id)) {
        throw new ServiceError(404, "Group not found");
      }
      if (role) spaces.grant(id, subject, role);
      else spaces.revoke(id, subject);
      accessChanged(space.orgId);
    },

    // The role everyone in the org has in the shared space, now and later; null for none.
    setEveryone(principal: Principal, id: string, role: EveryoneRole | null) {
      const space = requireShared(principal, id);
      const changed = spaces.setEveryoneRole(id, role);
      accessChanged(space.orgId);
      return view(principal, changed);
    },
  };
}

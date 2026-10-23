// An org's spaces as its people see them: listing, creating, renaming and deleting empty ones,
// setting the model and effort their new threads start with, who is in a shared space and with
// what role, and the one rule for what each person may do in a space. A person's role is the
// highest of the one given to them, those given to their groups and, in a shared space, the one
// given to everyone in the org. A team org's owners manage its shared spaces without a role there,
// but read their threads only once they give themselves one.

import type { Directory, OrgRole } from "@/ports/directory.ts";
import type { Principal } from "@/ports/identity.ts";
import type { OrgSettingStore } from "@/ports/org-settings.ts";
import type { EveryoneRole, Space, SpaceRole, SpaceStore, Subject } from "@/ports/spaces.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import type { PageParams } from "@/shared/paging.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Models } from "@/services/models.ts";
import { FIRST_SPACE_NAME, type SpaceMembers, spaceNameFor } from "@/shared/spaces.ts";
import type { Effort } from "@/shared/threads.ts";

export interface SpacesOptions {
  spaces: SpaceStore;
  threads: Pick<ThreadStore, "anyInSpace">;
  models: Pick<Models, "requireModel">;
  directory: Pick<Directory, "org" | "roleIn" | "group" | "groupIdsOf" | "memberCount" | "user">;
  settings: Pick<OrgSettingStore, "get">;
  // Told when people may have lost a role in the org's spaces.
  accessChanged?: (orgId: string) => void;
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

    rename(principal: Principal, id: string, name: string) {
      require(principal, id, "manage");
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
      if (subject.kind === "group" && directory.group(subject.id)?.orgId !== space.orgId) {
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

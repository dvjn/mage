// An org's spaces as its people see them: listing, creating, renaming and deleting empty ones,
// setting the model and effort their new threads start with, who is in a shared space and with
// what role, and the one rule for what each person may do in a space. A person's role is the
// highest of the one given to them, those given to their groups and, in a shared space, the one
// given to everyone in the org. A team org's owners manage its shared spaces without a role there,
// but read their threads only once they give themselves one. A team org's members make a private
// space of their own when the org allows it; when they or the org's owners delete it, it goes to
// trash with its threads, seen only by whoever deleted it and the org's owners, who may restore it
// or delete it for good, and it is deleted for good after a while. While the org does not allow
// them, or while its person is not in the org, it is archived: hidden from everyone, read-only to
// its person, and the agent does not run there. Archived is worked out whenever it is asked, so
// allowing them again, or rejoining, restores it; only since when it is archived is kept, and a
// space archived for long enough is deleted.

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Models } from "@/server/models/service.ts";
import type { Directory, OrgRole } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { OrgSettingStore } from "@/server/orgs/service.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import type { PageParams, Page } from "@/shared/paging.ts";
import {
  FIRST_SPACE_NAME,
  TRASH_DAYS,
  namedForPerson,
  type SpaceDefaultsChange,
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
  // What the agent of its threads goes by where people see it; null takes the org's.
  agentName: string | null;
  // The role everyone in the org has in a shared space; null for none.
  everyoneRole: EveryoneRole | null;
  // Null once the user who made it is gone.
  createdBy: string | null;
  // Since when a member's own space has been archived, as last noted; null while it is not.
  archivedAt: Date | null;
  // When it went to trash and by whom (null once they are gone); null while it is not in trash.
  trashedAt: Date | null;
  trashedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// What the agent of the space's threads goes by: the space's name for it, else its org's, else the
// usual one.
export function agentNameIn(
  settings: Pick<OrgSettingStore, "get">,
  space: Pick<Space, "orgId" | "agentName">,
) {
  return space.agentName ?? settings.get(space.orgId).agentName ?? DEFAULT_AGENT_NAME;
}

// A member's own space in trash, with its person, who put it there and how many threads it has.
export interface TrashedSpace extends Space {
  trashedAt: Date;
  ownerName: string | null;
  trashedByName: string | null;
  threadCount: number;
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
  // How many people and groups have a role in it, and how many threads it has.
  memberCount: number;
  threadCount: number;
}

// Spaces in trash are left out of every list and role; only `find` and the trash's own reads
// return them.
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
  setDefaults(id: string, changes: SpaceDefaultsChange): Space;
  delete(id: string): void;
  setArchivedAt(id: string, at: Date | null): void;
  trash(id: string, by: string, at: Date): void;
  untrash(id: string): void;
  // The org's spaces in trash, the last put there first.
  trashedIn(orgId: string): TrashedSpace[];
  // The spaces put in trash at or before the time, in any org.
  trashedBefore(at: Date): Space[];
  // Every team org's members' own spaces, but those in trash.
  memberSpaces(): Space[];
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
  hooks?: Hooks;
  now?: () => Date;
}

declare module "@/server/kernel/hooks.ts" {
  interface HookEvents {
    // People may have lost a role in the org's spaces, or one of them went to trash.
    "space.accessChanged": { orgId: string };
  }
}

export type Spaces = ReturnType<typeof createSpaces>;

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a member's own space stays archived before it is deleted.
export const ARCHIVE_DAYS = 90;

// Reading the space's threads; posting, steering, queueing and stopping in them; managing the
// space; deleting it, or deleting its threads and moving them out.
export type SpaceAction = "read" | "message" | "manage" | "remove";

const ALLOWED: Record<SpaceRole, readonly SpaceAction[]> = {
  owner: ["read", "message", "manage", "remove"],
  messager: ["read", "message"],
  viewer: ["read"],
};

// What a person may still do in their own archived space.
const ARCHIVED_ALLOWED: readonly SpaceAction[] = ["read", "remove"];

const ARCHIVED = "This space is archived";

const RANK: Record<SpaceRole, number> = { viewer: 1, messager: 2, owner: 3 };

const REFUSED: Record<SpaceAction, string> = {
  read: "Space not found",
  message: "Only the space's messagers and owners can do this",
  manage: "Only the space's owner can do this",
  remove: "Only the space's owner can do this",
};

// Who acts: their org role is known for signed-in people, not for the authors of waiting messages.
type Who = Pick<Principal, "userId" | "orgId"> & { role?: OrgRole };

export type SpaceView = Space & {
  role: SpaceRole | null;
  post: boolean;
  manage: boolean;
  remove: boolean;
  archived: boolean;
};

export function createSpaces(options: SpacesOptions) {
  const { spaces, threads, models, directory, settings } = options;
  const now = options.now ?? (() => new Date());
  const accessChanged = (orgId: string) => options.hooks?.run("space.accessChanged", { orgId });

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

  // Members who came back get back the space they left. Whoever left or came back, and every
  // member when the org stops or starts allowing their spaces, starts or stops their countdown.
  options.hooks?.on("org.membersSettled", ({ orgId, joined }) => {
    for (const userId of joined) {
      const own = spaces.memberSpaceOf(orgId, userId);
      if (own) spaces.grant(own.id, { kind: "user", id: userId }, "owner");
    }
    noteArchived(orgId);
  });
  options.hooks?.on("org.personalSpacesChanged", ({ orgId }) => noteArchived(orgId));

  // Notes since when each member's space of the org, or of every org, is archived, and forgets it
  // once it is not.
  function noteArchived(orgId?: string, at = now()) {
    for (const space of spaces.memberSpaces()) {
      if (orgId && space.orgId !== orgId) continue;
      const isArchived = archived(space);
      if (isArchived && !space.archivedAt) spaces.setArchivedAt(space.id, at);
      else if (!isArchived && space.archivedAt) spaces.setArchivedAt(space.id, null);
    }
  }

  // A team org member's own private space.
  function memberSpace(space: Space) {
    return space.kind === "personal" && directory.org(space.orgId)?.kind === "team";
  }

  // A member's space while their org does not allow them, or while its person is not in the org.
  // Worked out whenever it is asked, so allowing them again, or rejoining, restores it.
  function archived(space: Space) {
    if (!memberSpace(space)) return false;
    if (!settings.get(space.orgId).memberSpaces) return true;
    return !space.createdBy || !directory.roleIn(space.orgId, space.createdBy);
  }

  // The person's role in the space, or null when its org is not theirs, they have none or it is in
  // trash.
  function roleIn(who: Who, space: Space) {
    return space.orgId === who.orgId && !space.trashedAt
      ? spaces.roleOf(space.id, who.userId)
      : null;
  }

  // An owner of the space's team org, who manages its shared spaces.
  function orgManages(who: Who, space: Space) {
    return (
      space.orgId === who.orgId &&
      who.role === "owner" &&
      space.kind === "shared" &&
      !space.trashedAt
    );
  }

  // The space in trash, when the principal put it there or owns its org.
  function requireTrashed(principal: Principal, id: string) {
    const space = spaces.find(id);
    if (
      !space?.trashedAt ||
      space.orgId !== principal.orgId ||
      (principal.role !== "owner" && space.trashedBy !== principal.userId)
    ) {
      throw new ServiceError(404, REFUSED.read);
    }
    return space;
  }

  // The one rule for what a person may do in a space: their org owns it and their role there
  // allows the action, or they own the org and manage its shared spaces. An archived space only
  // lets its person read it and clear it out.
  function can(who: Who, space: Space, action: SpaceAction) {
    const role = roleIn(who, space);
    if (archived(space)) return role !== null && ARCHIVED_ALLOWED.includes(action);
    if (role !== null && ALLOWED[role].includes(action)) return true;
    return (action === "manage" || action === "remove") && orgManages(who, space);
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

  // The space as the person sees it: their own is their personal space, another's is named for
  // its person.
  function view(who: Who, space: Space, role = roleIn(who, space)): SpaceView {
    const owner = space.createdBy ? directory.user(space.createdBy)?.name : null;
    const name = spaceNameFor(space, owner ?? "A former member", space.createdBy === who.userId);
    return {
      ...space,
      name,
      role,
      post: can(who, space, "message"),
      manage: can(who, space, "manage"),
      remove: can(who, space, "remove"),
      archived: archived(space),
    };
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
        archived(space)
          ? ARCHIVED
          : role
            ? REFUSED[action]
            : "Add yourself in Members to read its threads",
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

    // Whether the space is archived; false for one that is gone.
    isArchived(id: string) {
      const space = spaces.find(id);
      return !!space && archived(space);
    },

    // Whether the space is in trash or gone.
    isGone(id: string) {
      const space = spaces.find(id);
      return !space || !!space.trashedAt;
    },

    // Whether the agent may run in the space's threads.
    runsIn(space: Space) {
      return !space.trashedAt && !archived(space);
    },

    // The spaces the principal has a role in and, for a team org's owners, its other shared ones.
    list(principal: Principal): SpaceView[] {
      const roles = spaces.rolesIn(principal.orgId, principal.userId);
      return spaces
        .listInOrg(principal.orgId)
        .filter((space) => roles.has(space.id) || orgManages(principal, space))
        .map((space) => view(principal, space, roles.get(space.id) ?? null));
    },

    // A page of every space of a team org for its owners, shared ones and its members' private
    // ones, with who made each, how many people and groups have a role there, and how many threads
    // it has.
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
        items: page.items.map(({ displayName, ownerName, memberCount, threadCount, ...space }) => ({
          ...view(principal, space, roles.get(space.id) ?? null),
          name: displayName,
          ownerName,
          memberCount,
          threadCount,
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

    // Makes the principal's own private space in their team org, when it allows them one and they
    // have none.
    createMine(principal: Principal): SpaceView {
      if (directory.org(principal.orgId)?.kind !== "team") {
        throw new ServiceError(409, "A personal organization has its own space");
      }
      if (!settings.get(principal.orgId).memberSpaces) {
        throw new ServiceError(403, "This organization does not allow personal spaces");
      }
      if (spaces.memberSpaceOf(principal.orgId, principal.userId)) {
        throw new ServiceError(409, "You already have a space");
      }
      const space = spaces.create({
        orgId: principal.orgId,
        kind: "personal",
        name: FIRST_SPACE_NAME,
        primary: true,
        createdBy: principal.userId,
      });
      return view(principal, space, "owner");
    },

    // A person's own space keeps their name.
    rename(principal: Principal, id: string, name: string) {
      const space = require(principal, id, "manage");
      if (namedForPerson(space)) {
        throw new ServiceError(409, "A personal space is named for its person");
      }
      return view(principal, spaces.rename(id, name));
    },

    // A default model must be one the org can use now; null goes back to the org's, as it does for
    // the agent's name.
    async setDefaults(principal: Principal, id: string, changes: SpaceDefaultsChange) {
      require(principal, id, "manage");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      require(principal, id, "manage");
      return view(principal, spaces.setDefaults(id, changes));
    },

    // A member's space goes to trash with its threads, by its person or by one of the org's
    // owners, who never read it, and the agent stops there; any other space is deleted once it has
    // no threads.
    async remove(principal: Principal, id: string) {
      const found = spaces.find(id);
      const member =
        !!found && !found.trashedAt && memberSpace(found) && found.orgId === principal.orgId;
      const space = member && principal.role === "owner" ? found : require(principal, id, "remove");
      if (member) {
        spaces.trash(space.id, principal.userId, now());
        await accessChanged(space.orgId);
        return;
      }
      if (space.primary) throw new ServiceError(409, `${space.name} cannot be deleted`);
      if (threads.anyInSpace(id)) {
        throw new ServiceError(409, "Only a space without threads can be deleted");
      }
      spaces.delete(id);
    },

    // The org's spaces in trash: all of them for its owners, those they put there for anyone else.
    trash(principal: Principal) {
      return spaces
        .trashedIn(principal.orgId)
        .filter((space) => principal.role === "owner" || space.trashedBy === principal.userId)
        .map((space) => ({
          ...space,
          name: spaceNameFor(
            space,
            space.ownerName ?? "A former member",
            space.createdBy === principal.userId,
          ),
        }));
    },

    // Takes the space out of trash as it was, unless its person has made another since.
    restore(principal: Principal, id: string) {
      const space = requireTrashed(principal, id);
      if (space.createdBy && spaces.memberSpaceOf(space.orgId, space.createdBy)) {
        throw new ServiceError(409, "Its person has made another space since");
      }
      spaces.untrash(id);
      // Its person may have left and come back while it was in trash.
      if (space.createdBy && directory.roleIn(space.orgId, space.createdBy)) {
        spaces.grant(id, { kind: "user", id: space.createdBy }, "owner");
      }
      noteArchived(space.orgId);
    },

    // Deletes the space in trash with its threads for good.
    purge(principal: Principal, id: string) {
      spaces.delete(requireTrashed(principal, id).id);
    },

    // Deletes for good the spaces in trash for longer than its days, and the members' spaces
    // archived for longer than theirs, first noting since when those not yet noted are archived.
    // Answers how many went.
    sweep(at = now()) {
      noteArchived(undefined, at);
      const before = (days: number) => at.getTime() - days * DAY_MS;
      const gone = [
        ...spaces.trashedBefore(new Date(before(TRASH_DAYS))),
        ...spaces
          .memberSpaces()
          .filter(
            (space) =>
              !!space.archivedAt &&
              space.archivedAt.getTime() <= before(ARCHIVE_DAYS) &&
              archived(space),
          ),
      ];
      for (const space of gone) spaces.delete(space.id);
      return gone.length;
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
    async setMember(principal: Principal, id: string, subject: Subject, role: SpaceRole | null) {
      const space = requireShared(principal, id);
      if (subject.kind === "user" && !directory.roleIn(space.orgId, subject.id)) {
        throw new ServiceError(404, "Member not found");
      }
      if (subject.kind === "group" && !directory.linkedRole(space.orgId, subject.id)) {
        throw new ServiceError(404, "Group not found");
      }
      if (role) spaces.grant(id, subject, role);
      else spaces.revoke(id, subject);
      await accessChanged(space.orgId);
    },

    // The role everyone in the org has in the shared space, now and later; null for none.
    async setEveryone(principal: Principal, id: string, role: EveryoneRole | null) {
      const space = requireShared(principal, id);
      const changed = spaces.setEveryoneRole(id, role);
      await accessChanged(space.orgId);
      return view(principal, changed);
    },
  };
}

// Orgs and who is in them: the orgs a person belongs to, creating team orgs, a team org's members
// and their roles, inviting people by email with single-use links shown once, taking the links
// back, joining through one, adding people and linking groups from the directory, removing members,
// the settings owners choose for the org's spaces, and renaming and deleting a team org. A member's
// role is the highest of their own and their linked groups'; whenever one of those changes, the org
// is settled, and people who joined get their own space and those who left lose what they had. A
// team org keeps at least one owner in their own right, so the directory cannot leave it without.

import { createHash, randomBytes } from "node:crypto";

import type { Directory, MemberRow, OrgRole } from "@/ports/directory.ts";
import type { Principal } from "@/ports/identity.ts";
import type { OrgInviteStore } from "@/ports/org-invites.ts";
import type { OrgSettingStore } from "@/ports/org-settings.ts";
import type { SpaceStore } from "@/ports/spaces.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Page, PageParams } from "@/shared/paging.ts";
import type { Spaces } from "@/services/spaces.ts";
import type {
  CreatedOrgInvite,
  JoinPreview,
  OrgList,
  OrgMember,
  OrgPerson,
  TeamSettings,
} from "@/shared/orgs.ts";

export interface OrgsOptions {
  directory: Directory;
  invites: OrgInviteStore;
  spaces: Pick<Spaces, "ensureMemberSpace" | "list">;
  spaceStore: Pick<SpaceStore, "create" | "find">;
  threads: Pick<ThreadStore, "find">;
  // The agent's runs, stopped in an org being deleted.
  runs: Pick<RunStore, "activeThreadIds" | "requestCancel">;
  settings: Pick<OrgSettingStore, "get" | "setTeamSettings">;
  // Told when people may have lost a role in the org's spaces.
  accessChanged?: (orgId: string) => void;
  // Where the app is served; invite links lead there.
  baseUrl: string;
  // Who may create team orgs, and the accounts that run the server.
  teamOrgs: "everyone" | "operator";
  operatorEmails: string[];
  now?: () => Date;
}

export type Orgs = ReturnType<typeof createOrgs>;

export const ORG_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// The shared space every team org starts with, open to everyone in it.
export const GENERAL_SPACE_NAME = "General";

// Who is signed in, whatever org they act in.
export interface Account {
  userId: string;
  email: string;
}

function hashOf(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// An email with all but the first letter of its name hidden: "a***@example.com".
export function maskEmail(email: string) {
  const at = email.indexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
}

export function createOrgs(options: OrgsOptions) {
  const { directory, invites, spaces, spaceStore, threads, runs, settings, baseUrl } = options;
  const now = options.now ?? (() => new Date());
  const accessChanged = options.accessChanged ?? (() => {});

  function canCreate(email: string) {
    return options.teamOrgs === "everyone" || options.operatorEmails.includes(email.toLowerCase());
  }

  // The principal's org when it is a team org they own.
  function requireOwner(principal: Principal) {
    const org = directory.org(principal.orgId);
    if (org?.kind !== "team") {
      throw new ServiceError(409, "A personal organization has only you in it");
    }
    if (principal.role !== "owner") {
      throw new ServiceError(403, "Only the organization's owners can do this");
    }
    return org;
  }

  function ownerCount(orgId: string) {
    return directory.directOwnerCount(orgId);
  }

  // Brings the org's members, or only the users', in line with their roles; those who joined get
  // their own space, and if anyone lost a role their waiting messages are checked.
  function settle(orgId: string, userIds?: string[]) {
    const settled = directory.settle(orgId, now(), userIds);
    for (const userId of settled.joined) spaces.ensureMemberSpace(orgId, userId);
    if (settled.changed) accessChanged(orgId);
  }

  function requireDirectoryPerson(userId: string) {
    if (directory.user(userId)?.source !== "scim") {
      throw new ServiceError(404, "Nobody by that id in the directory");
    }
  }

  function requireLinked(orgId: string, groupId: string) {
    const role = directory.linkedRole(orgId, groupId);
    if (!role) throw new ServiceError(404, "Group not found");
    return role;
  }

  // The member's role of their own, and the linked group they are in, if any.
  function standing(orgId: string, userId: string) {
    const row = directory.memberPage(orgId, { limit: 1, userId }).items[0];
    if (!row) throw new ServiceError(404, "Member not found");
    return row;
  }

  // A member as the asker sees them, and why the asker may not change their role: it is their own,
  // or the last owner's in their own right.
  function memberSummary(principal: Principal, member: MemberRow, owners: number): OrgMember {
    return {
      userId: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      directRole: member.directRole,
      viaGroup: member.viaGroup,
      source: member.source,
      joinedAt: member.joinedAt.toISOString(),
      groupCount: member.groupCount,
      locked:
        member.id === principal.userId
          ? "self"
          : member.directRole === "owner" && owners <= 1
            ? "last_owner"
            : null,
    };
  }

  function requireMember(orgId: string, userId: string) {
    const role = directory.roleIn(orgId, userId);
    if (!role) throw new ServiceError(404, "Member not found");
    return role;
  }

  function invite(token: string) {
    const found = invites.findByHash(hashOf(token));
    if (!found) throw new ServiceError(404, "This invite link does not exist", "not_found");
    return found;
  }

  // Why a link can no longer be used, or null when it can.
  function refusal(found: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) {
    if (found.revokedAt) return "revoked" as const;
    if (found.acceptedAt) return "used" as const;
    if (found.expiresAt <= now()) return "expired" as const;
    return null;
  }

  function teamSettings(principal: Principal): TeamSettings {
    const { spaceCreation, memberSpaces } = settings.get(principal.orgId);
    return { spaceCreation, memberSpaces };
  }

  const REFUSED = {
    revoked: "This invite link was revoked",
    used: "This invite link was already used",
    expired: "This invite link has expired",
  };

  return {
    // The orgs the person is in, and whether they may create a team org.
    list(account: Account): OrgList {
      return {
        orgs: directory.orgsOf(account.userId).map(({ id, name, kind, role, ownerName }) => ({
          id,
          name,
          kind,
          role,
          ownerName,
        })),
        canCreate: canCreate(account.email),
      };
    },

    // Which of the person's orgs the space, or the thread's space, is in; null when none is.
    locate(account: Account, place: { space?: string; thread?: string }) {
      const spaceId = place.space ?? (place.thread && threads.find(place.thread)?.spaceId);
      const orgId = spaceId ? spaceStore.find(spaceId)?.orgId : undefined;
      return orgId && directory.roleIn(orgId, account.userId) ? orgId : null;
    },

    // A team org with its creator as owner, its General space open to everyone in it, and the
    // creator's own space when the org gives members one.
    async create(account: Account, name: string) {
      if (!canCreate(account.email)) {
        throw new ServiceError(403, "Only the server's operators can create organizations");
      }
      const org = await directory.createTeamOrg(name, account.userId);
      const general = spaceStore.create({
        orgId: org.id,
        kind: "shared",
        name: GENERAL_SPACE_NAME,
        everyoneRole: "messager",
        createdBy: account.userId,
      });
      spaces.ensureMemberSpace(org.id, account.userId);
      return { orgId: org.id, spaceId: general.id };
    },

    // A page of the org's members by name, with how many groups each is in.
    members(principal: Principal, params: PageParams & { role?: OrgRole }): Page<OrgMember> {
      const page = directory.memberPage(principal.orgId, params);
      const owners = ownerCount(principal.orgId);
      return { ...page, items: page.items.map((row) => memberSummary(principal, row, owners)) };
    },

    // One member, for a glance at who they are.
    member(principal: Principal, userId: string): OrgMember {
      const page = directory.memberPage(principal.orgId, { limit: 1, userId });
      const row = page.items[0];
      if (!row) throw new ServiceError(404, "Member not found");
      return memberSummary(principal, row, ownerCount(principal.orgId));
    },

    // The groups a member is in, a page at a time.
    groupsOf(principal: Principal, userId: string, params: PageParams) {
      requireMember(principal.orgId, userId);
      return directory.groupPage(principal.orgId, { ...params, userId });
    },

    // A page of the org's people: for its owners, the invites not yet used first, then its linked
    // groups and its members by name.
    people(
      principal: Principal,
      params: PageParams & { role?: OrgRole; status?: "member" | "invited" | "group" },
    ): Page<OrgPerson> {
      const owner = principal.role === "owner" && directory.org(principal.orgId)?.kind === "team";
      const page = directory.peoplePage(principal.orgId, {
        ...params,
        invitesAt: owner ? now() : null,
      });
      const owners = ownerCount(principal.orgId);
      return {
        ...page,
        items: page.items.map((row) =>
          row.kind === "member"
            ? { kind: "member", ...memberSummary(principal, row, owners) }
            : row.kind === "group"
              ? {
                  kind: "group",
                  id: row.id,
                  name: row.name,
                  role: row.role,
                  memberCount: row.memberCount,
                  linkedAt: row.linkedAt.toISOString(),
                }
              : {
                  kind: "invite",
                  id: row.id,
                  email: row.email,
                  role: row.role,
                  createdByName: row.createdByName,
                  expiresAt: row.expiresAt.toISOString(),
                },
        ),
      };
    },

    // A link for the email to join with the role; its token is in the url and nowhere else. It
    // replaces any link the email has not used yet.
    invite(principal: Principal, email: string, role: OrgRole): CreatedOrgInvite {
      requireOwner(principal);
      const lower = email.trim().toLowerCase();
      const existing = directory.userByEmail(lower);
      if (existing && directory.roleIn(principal.orgId, existing.id)) {
        throw new ServiceError(409, `${existing.name} is already a member`);
      }
      // A new link for the same email takes the place of any not yet used.
      for (const old of invites.pending(principal.orgId, now())) {
        if (old.email === lower) invites.revoke(old.id, now());
      }
      const token = randomBytes(32).toString("base64url");
      const created = invites.create({
        orgId: principal.orgId,
        email: lower,
        role,
        tokenHash: hashOf(token),
        createdBy: principal.userId,
        expiresAt: new Date(now().getTime() + ORG_INVITE_LIFETIME_MS),
      });
      return {
        id: created.id,
        email: lower,
        role,
        url: new URL(`/join/${token}`, baseUrl).toString(),
        expiresAt: created.expiresAt.toISOString(),
      };
    },

    revokeInvite(principal: Principal, id: string) {
      requireOwner(principal);
      const found = invites.find(id);
      if (!found || found.orgId !== principal.orgId || refusal(found)) {
        throw new ServiceError(404, "Invite not found");
      }
      invites.revoke(id, now());
    },

    // What a link offers, for the page that opens it. Signed out, the whole email it is for, to
    // sign in or up with; signed in as someone else, only its first letter and domain.
    preview(token: string, account: Account | null): JoinPreview {
      const found = invite(token);
      const org = directory.org(found.orgId);
      const inviter = found.createdBy ? directory.user(found.createdBy) : null;
      const yours = !!account && account.email.toLowerCase() === found.email;
      return {
        orgName: org?.name ?? "",
        inviterName: inviter?.name ?? null,
        email: !account || yours ? found.email : maskEmail(found.email),
        role: found.role,
        status: refusal(found) ?? "ok",
        yours,
        member: !!account && !!directory.roleIn(found.orgId, account.userId),
      };
    },

    // Makes the person a member with the link's role and uses the link up, when it was made for
    // their email. Someone already in the org just goes to it: to its first shared space they are
    // in, or else their own.
    async accept(account: Account, token: string) {
      const found = invite(token);
      const landing = () => {
        const role = directory.roleIn(found.orgId, account.userId);
        if (!role) return { orgId: found.orgId, spaceId: null };
        const list = spaces
          .list({ userId: account.userId, orgId: found.orgId, role })
          .filter((space) => space.role);
        const space = list.find((s) => s.kind === "shared") ?? list[0];
        return { orgId: found.orgId, spaceId: space?.id ?? null };
      };
      if (directory.roleIn(found.orgId, account.userId)) return landing();
      if (account.email.toLowerCase() !== found.email) {
        throw new ServiceError(
          403,
          `This invite is for ${maskEmail(found.email)}`,
          "wrong_account",
        );
      }
      const refused = refusal(found);
      if (refused) throw new ServiceError(410, REFUSED[refused], refused);
      if (!invites.markAccepted(found.id, account.userId, now())) {
        throw new ServiceError(410, REFUSED.used, "used");
      }
      await directory.addMember(found.orgId, account.userId, found.role);
      spaces.ensureMemberSpace(found.orgId, account.userId);
      return landing();
    },

    // Gives the member a role of their own; their role is then the higher of it and their groups'.
    setRole(principal: Principal, userId: string, role: OrgRole) {
      requireOwner(principal);
      const member = standing(principal.orgId, userId);
      if (member.directRole === "owner" && role !== "owner" && ownerCount(principal.orgId) === 1) {
        throw new ServiceError(409, "An organization needs at least one owner");
      }
      directory.setDirectRole(principal.orgId, userId, role);
      settle(principal.orgId, [userId]);
    },

    // Takes back the member's own role. Without a linked group to keep them in, they leave the org
    // with their roles in its spaces, and their waiting messages there are dropped.
    removeMember(principal: Principal, userId: string) {
      requireOwner(principal);
      const member = standing(principal.orgId, userId);
      if (!member.directRole) {
        throw new ServiceError(
          409,
          `${member.name} is in through ${member.viaGroup ?? "a group"}. Unlink the group or change it in your directory.`,
        );
      }
      if (member.directRole === "owner" && ownerCount(principal.orgId) === 1) {
        throw new ServiceError(409, "An organization needs at least one owner");
      }
      directory.setDirectRole(principal.orgId, userId, null);
      settle(principal.orgId, [userId]);
    },

    // Adds someone from the directory with a role of their own.
    addMember(principal: Principal, userId: string, role: OrgRole) {
      requireOwner(principal);
      requireDirectoryPerson(userId);
      directory.setDirectRole(principal.orgId, userId, role);
      settle(principal.orgId, [userId]);
    },

    // Links a directory group: everyone active in it is a member with at least the role.
    linkGroup(principal: Principal, groupId: string, role: OrgRole) {
      requireOwner(principal);
      if (!directory.group(groupId)) throw new ServiceError(404, "Group not found");
      if (directory.linkedRole(principal.orgId, groupId)) {
        throw new ServiceError(409, "That group is already linked");
      }
      directory.linkGroup(principal.orgId, groupId, role);
      settle(principal.orgId);
    },

    setGroupRole(principal: Principal, groupId: string, role: OrgRole) {
      requireOwner(principal);
      requireLinked(principal.orgId, groupId);
      directory.linkGroup(principal.orgId, groupId, role);
      settle(principal.orgId);
    },

    // Unlinks the group with the roles the org's spaces gave it; people in only through it leave.
    unlinkGroup(principal: Principal, groupId: string) {
      requireOwner(principal);
      requireLinked(principal.orgId, groupId);
      directory.unlinkGroup(principal.orgId, groupId);
      settle(principal.orgId);
    },

    // A page of the directory's people by name, with their role in the org, for adding them.
    directoryPeople(principal: Principal, params: PageParams) {
      requireOwner(principal);
      return directory.directoryPeoplePage(principal.orgId, params);
    },

    // A page of the directory's groups by name, with the role each is linked with, for linking.
    directoryGroups(principal: Principal, params: PageParams) {
      requireOwner(principal);
      return directory.directoryGroupPage(principal.orgId, params);
    },

    // The directory changed the person or the groups they are in. Once it turned them off or
    // deleted them, their own roles in team orgs go, except where they are the last owner in their
    // own right. Each team org they are in, or could be through a group, is settled for them.
    directoryChanged(userId: string, active: boolean) {
      if (!active) directory.clearDirectRoles(userId);
      for (const orgId of directory.orgsToSettle(userId)) settle(orgId, [userId]);
    },

    rename(principal: Principal, name: string) {
      requireOwner(principal);
      directory.renameOrg(principal.orgId, name);
    },

    // Stops the agent in the org's threads, then deletes the org with everything in it.
    delete(principal: Principal) {
      if (directory.org(principal.orgId)?.kind !== "team") {
        throw new ServiceError(403, "A personal organization cannot be deleted");
      }
      requireOwner(principal);
      for (const threadId of new Set(runs.activeThreadIds())) {
        const thread = threads.find(threadId);
        if (thread && spaceStore.find(thread.spaceId)?.orgId === principal.orgId) {
          runs.requestCancel(threadId, principal.userId, now());
        }
      }
      directory.deleteOrg(principal.orgId);
    },

    settings: teamSettings,

    setSettings(principal: Principal, changes: Partial<TeamSettings>): TeamSettings {
      requireOwner(principal);
      settings.setTeamSettings(principal.orgId, changes);
      return teamSettings(principal);
    },
  };
}

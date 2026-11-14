// Orgs and who is in them: the orgs a person belongs to, creating team orgs, a team org's members
// and their roles, inviting people by email with single-use links shown once, taking the links
// back, joining through one, adding people and linking groups from the directory, removing members,
// the settings owners choose for the org's spaces, the name its agent goes by, and renaming and
// deleting a team org. A member's role is the highest of their own and their linked groups';
// whenever one of those changes, the org is settled, and the app told who joined and who left.
// A team org keeps at least one owner in their own right, so the directory cannot leave it without.

import { createHash, randomBytes } from "node:crypto";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Hooks } from "@/server/kernel/hooks.ts";
import type { SpaceStore, Spaces } from "@/server/spaces/service.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import {
  type AgentName,
  type CreatedOrgInvite,
  DEFAULT_AGENT_NAME,
  type JoinPreview,
  type OrgList,
  type OrgMember,
  type OrgPerson,
  type TeamSettings,
} from "@/shared/orgs.ts";
import type { Page, PageParams } from "@/shared/paging.ts";
import type { Effort } from "@/shared/threads/thread.ts";

import type { Directory, MemberRow, OrgRole } from "./directory.ts";
import type { Principal } from "./identity.ts";

export interface OrgInvite {
  id: string;
  orgId: string;
  // Lower-cased.
  email: string;
  role: OrgRole;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface OrgInviteStore {
  create(invite: {
    orgId: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    createdBy: string;
    expiresAt: Date;
  }): Promise<OrgInvite>;
  find(id: string): Promise<OrgInvite | null>;
  findByHash(tokenHash: string): Promise<OrgInvite | null>;
  // The org's invites not used, revoked or expired at `now`, newest first, with who made each.
  pending(orgId: string, now: Date): Promise<(OrgInvite & { createdByName: string | null })[]>;
  // Stamps the invite used by the user; false when it was used or revoked first.
  markAccepted(id: string, userId: string, at: Date): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
}

export interface OrgSettings {
  // A model ref such as `codex/gpt-5`, or null when the org has not picked one.
  defaultModel: string | null;
  // The model ref that names threads, or null to choose one automatically.
  titleModel: string | null;
  // The reasoning effort new threads start with, or null for the usual one.
  defaultEffort: Effort | null;
  // Who may make shared spaces in a team org.
  spaceCreation: "members" | "owners";
  // Whether a team org's members may make a private space of their own; while not, the ones made
  // are archived.
  memberSpaces: boolean;
  // Whether a space's managers may add MCP servers for it, and its threads use them.
  spaceMcpServers: boolean;
  // Whether a space's managers may add skills for it, and its threads use them.
  spaceSkills: boolean;
  // What the agent of the org's threads goes by where people see it, or null for the usual name.
  agentName: string | null;
}

export interface OrgSettingStore {
  get(orgId: string): Promise<OrgSettings>;
  setDefaultModel(orgId: string, ref: string): Promise<void>;
  setTitleModel(orgId: string, ref: string | null): Promise<void>;
  setDefaultEffort(orgId: string, effort: Effort | null): Promise<void>;
  setTeamSettings(
    orgId: string,
    changes: Partial<Pick<OrgSettings, "spaceCreation" | "memberSpaces">>,
  ): Promise<void>;
  setSpaceMcpServers(orgId: string, allowed: boolean): Promise<void>;
  setSpaceSkills(orgId: string, allowed: boolean): Promise<void>;
  setAgentName(orgId: string, name: string | null): Promise<void>;
}

export interface OrgsOptions {
  directory: Directory;
  invites: OrgInviteStore;
  spaces: Pick<Spaces, "list">;
  spaceStore: Pick<SpaceStore, "create" | "find">;
  threads: Pick<ThreadStore, "find">;
  settings: Pick<OrgSettingStore, "get" | "setTeamSettings" | "setAgentName">;
  hooks?: Hooks;
  // Where the app is served; invite links lead there.
  baseUrl: string;
  // Who may create team orgs, and the accounts that run the server.
  teamOrgs: "everyone" | "operator";
  operatorEmails: string[];
  now?: () => Date;
}

declare module "@/server/kernel/hooks.ts" {
  interface HookEvents {
    // The org allows its members' own spaces again, or no longer does and they are archived.
    "org.personalSpacesChanged": { orgId: string; allowed: boolean };
    // The org's members were settled: some joined or came back, some left, or someone's role
    // changed, so people may have lost a role in its spaces.
    "org.membersSettled": { orgId: string; joined: string[]; left: string[] };
    // The org is about to be deleted with everything in it; `by` is whoever deletes it.
    "org.deleting": { orgId: string; by: string };
  }
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
  const { directory, invites, spaces, spaceStore, threads, settings, baseUrl } = options;
  const now = options.now ?? (() => new Date());

  function canCreate(email: string) {
    return options.teamOrgs === "everyone" || options.operatorEmails.includes(email.toLowerCase());
  }

  // The principal's org when it is a team org they own.
  async function requireOwner(principal: Principal) {
    const org = await directory.org(principal.orgId);
    if (org?.kind !== "team") {
      throw new ServiceError(409, "A personal organization has only you in it");
    }
    if (principal.role !== "owner") {
      throw new ServiceError(403, "Only the organization's owners can do this");
    }
    return org;
  }

  async function ownerCount(orgId: string) {
    return directory.directOwnerCount(orgId);
  }

  // Brings the org's members, or only the users', in line with their roles, and tells the app
  // when anything changed.
  async function settle(orgId: string, userIds?: string[]) {
    const { joined, left, changed } = await directory.settle(orgId, now(), userIds);
    if (changed) await options.hooks?.run("org.membersSettled", { orgId, joined, left });
  }

  async function requireDirectoryPerson(userId: string) {
    if ((await directory.user(userId))?.source !== "scim") {
      throw new ServiceError(404, "Nobody by that id in the directory");
    }
  }

  async function requireLinked(orgId: string, groupId: string) {
    const role = await directory.linkedRole(orgId, groupId);
    if (!role) throw new ServiceError(404, "Group not found");
    return role;
  }

  // The member's role of their own, and the linked group they are in, if any.
  async function standing(orgId: string, userId: string) {
    const row = (await directory.memberPage(orgId, { limit: 1, userId })).items[0];
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
      groupRole: member.groupRole,
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

  async function requireMember(orgId: string, userId: string) {
    const role = await directory.roleIn(orgId, userId);
    if (!role) throw new ServiceError(404, "Member not found");
    return role;
  }

  async function invite(token: string) {
    const found = await invites.findByHash(hashOf(token));
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

  async function teamSettings(principal: Principal): Promise<TeamSettings> {
    const { spaceCreation, memberSpaces } = await settings.get(principal.orgId);
    return { spaceCreation, memberSpaces };
  }

  const REFUSED = {
    revoked: "This invite link was revoked",
    used: "This invite link was already used",
    expired: "This invite link has expired",
  };

  const orgs = {
    // The orgs the person is in, and whether they may create a team org.
    async list(account: Account): Promise<OrgList> {
      return {
        orgs: (await directory.orgsOf(account.userId)).map(
          ({ id, name, kind, role, ownerName }) => ({
            id,
            name,
            kind,
            role,
            ownerName,
          }),
        ),
        canCreate: canCreate(account.email),
      };
    },

    // Which of the person's orgs the space, or the thread's space, is in; null when none is.
    async locate(account: Account, place: { space?: string; thread?: string }) {
      const spaceId = place.space ?? (place.thread && (await threads.find(place.thread))?.spaceId);
      const orgId = spaceId ? (await spaceStore.find(spaceId))?.orgId : undefined;
      return orgId && (await directory.roleIn(orgId, account.userId)) ? orgId : null;
    },

    // A team org with its creator as owner and its General space open to everyone in it. Its
    // members' own spaces start off; its owners may allow them.
    async create(account: Account, name: string) {
      if (!canCreate(account.email)) {
        throw new ServiceError(403, "Only the server's operators can create organizations");
      }
      const org = await directory.createTeamOrg(name, account.userId);
      const general = await spaceStore.create({
        orgId: org.id,
        kind: "shared",
        name: GENERAL_SPACE_NAME,
        everyoneRole: "messager",
        createdBy: account.userId,
      });
      await settings.setTeamSettings(org.id, { memberSpaces: false });
      return { orgId: org.id, spaceId: general.id };
    },

    // A page of the org's members by name, with how many groups each is in.
    async members(
      principal: Principal,
      params: PageParams & { role?: OrgRole },
    ): Promise<Page<OrgMember>> {
      const page = await directory.memberPage(principal.orgId, params);
      const owners = await ownerCount(principal.orgId);
      return { ...page, items: page.items.map((row) => memberSummary(principal, row, owners)) };
    },

    // One member, for a glance at who they are.
    async member(principal: Principal, userId: string): Promise<OrgMember> {
      const page = await directory.memberPage(principal.orgId, { limit: 1, userId });
      const row = page.items[0];
      if (!row) throw new ServiceError(404, "Member not found");
      return memberSummary(principal, row, await ownerCount(principal.orgId));
    },

    // The groups a member is in, a page at a time.
    async groupsOf(principal: Principal, userId: string, params: PageParams) {
      await requireMember(principal.orgId, userId);
      return directory.groupPage(principal.orgId, { ...params, userId });
    },

    // A page of the org's people: for its owners, the invites not yet used first, then its linked
    // groups and its members by name.
    async people(
      principal: Principal,
      params: PageParams & { role?: OrgRole; status?: "member" | "invited" | "group" },
    ): Promise<Page<OrgPerson>> {
      const owner =
        principal.role === "owner" && (await directory.org(principal.orgId))?.kind === "team";
      const page = await directory.peoplePage(principal.orgId, {
        ...params,
        invitesAt: owner ? now() : null,
      });
      const owners = await ownerCount(principal.orgId);
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
    async invite(principal: Principal, email: string, role: OrgRole): Promise<CreatedOrgInvite> {
      await requireOwner(principal);
      const lower = email.trim().toLowerCase();
      const existing = await directory.userByEmail(lower);
      if (existing && (await directory.roleIn(principal.orgId, existing.id))) {
        throw new ServiceError(409, `${existing.name} is already a member`);
      }
      // A new link for the same email takes the place of any not yet used.
      for (const old of await invites.pending(principal.orgId, now())) {
        if (old.email === lower) await invites.revoke(old.id, now());
      }
      const token = randomBytes(32).toString("base64url");
      const created = await invites.create({
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

    async revokeInvite(principal: Principal, id: string) {
      await requireOwner(principal);
      const found = await invites.find(id);
      if (!found || found.orgId !== principal.orgId || refusal(found)) {
        throw new ServiceError(404, "Invite not found");
      }
      await invites.revoke(id, now());
    },

    // What a link offers, for the page that opens it. Signed out, the whole email it is for, to
    // sign in or up with; signed in as someone else, only its first letter and domain.
    async preview(token: string, account: Account | null): Promise<JoinPreview> {
      const found = await invite(token);
      const org = await directory.org(found.orgId);
      const inviter = found.createdBy ? await directory.user(found.createdBy) : null;
      const yours = !!account && account.email.toLowerCase() === found.email;
      return {
        orgName: org?.name ?? "",
        inviterName: inviter?.name ?? null,
        email: !account || yours ? found.email : maskEmail(found.email),
        role: found.role,
        status: refusal(found) ?? "ok",
        yours,
        member: !!account && !!(await directory.roleIn(found.orgId, account.userId)),
      };
    },

    // Makes the person a member with the link's role and uses the link up, when it was made for
    // their email. Someone already in the org just goes to it: to its first shared space they are
    // in, or else their own.
    async accept(account: Account, token: string) {
      const found = await invite(token);
      const landing = async () => {
        const role = await directory.roleIn(found.orgId, account.userId);
        if (!role) return { orgId: found.orgId, spaceId: null };
        const list = (
          await spaces.list({ userId: account.userId, orgId: found.orgId, role })
        ).filter((space) => space.role && !space.archived);
        const space = list.find((s) => s.kind === "shared") ?? list[0];
        return { orgId: found.orgId, spaceId: space?.id ?? null };
      };
      if (await directory.roleIn(found.orgId, account.userId)) return landing();
      if (account.email.toLowerCase() !== found.email) {
        throw new ServiceError(
          403,
          `This invite is for ${maskEmail(found.email)}`,
          "wrong_account",
        );
      }
      const refused = refusal(found);
      if (refused) throw new ServiceError(410, REFUSED[refused], refused);
      if (!(await invites.markAccepted(found.id, account.userId, now()))) {
        throw new ServiceError(410, REFUSED.used, "used");
      }
      await directory.addMember(found.orgId, account.userId, found.role);
      await options.hooks?.run("org.membersSettled", {
        orgId: found.orgId,
        joined: [account.userId],
        left: [],
      });
      return landing();
    },

    // Gives the member a role of their own; their role is then the higher of it and their groups'.
    async setRole(principal: Principal, userId: string, role: OrgRole) {
      await requireOwner(principal);
      const member = await standing(principal.orgId, userId);
      if (
        member.directRole === "owner" &&
        role !== "owner" &&
        (await ownerCount(principal.orgId)) === 1
      ) {
        throw new ServiceError(409, "An organization needs at least one owner");
      }
      await directory.setDirectRole(principal.orgId, userId, role);
      await settle(principal.orgId, [userId]);
    },

    // Takes back the member's own role. Without a linked group to keep them in, they leave the org
    // with their roles in its spaces, and their waiting messages there are dropped.
    async removeMember(principal: Principal, userId: string) {
      await requireOwner(principal);
      const member = await standing(principal.orgId, userId);
      if (!member.directRole) {
        throw new ServiceError(
          409,
          `${member.name} is in through ${member.viaGroup ?? "a group"}. Remove the group or change it in your directory.`,
        );
      }
      if (member.directRole === "owner" && (await ownerCount(principal.orgId)) === 1) {
        throw new ServiceError(409, "An organization needs at least one owner");
      }
      await directory.setDirectRole(principal.orgId, userId, null);
      await settle(principal.orgId, [userId]);
    },

    // Adds someone from the directory with a role of their own.
    async addMember(principal: Principal, userId: string, role: OrgRole) {
      await requireOwner(principal);
      await requireDirectoryPerson(userId);
      await directory.setDirectRole(principal.orgId, userId, role);
      await settle(principal.orgId, [userId]);
    },

    // Links a directory group: everyone active in it is a member with at least the role.
    async linkGroup(principal: Principal, groupId: string, role: OrgRole) {
      await requireOwner(principal);
      if (!(await directory.group(groupId))) throw new ServiceError(404, "Group not found");
      if (await directory.linkedRole(principal.orgId, groupId)) {
        throw new ServiceError(409, "That group is already linked");
      }
      await directory.linkGroup(principal.orgId, groupId, role);
      await settle(principal.orgId);
    },

    async setGroupRole(principal: Principal, groupId: string, role: OrgRole) {
      await requireOwner(principal);
      await requireLinked(principal.orgId, groupId);
      await directory.linkGroup(principal.orgId, groupId, role);
      await settle(principal.orgId);
    },

    // Unlinks the group with the roles the org's spaces gave it; people in only through it leave.
    async unlinkGroup(principal: Principal, groupId: string) {
      await requireOwner(principal);
      await requireLinked(principal.orgId, groupId);
      await directory.unlinkGroup(principal.orgId, groupId);
      await settle(principal.orgId);
    },

    // A page of the directory's people by name, with their role in the org, for adding them.
    async directoryPeople(principal: Principal, params: PageParams) {
      await requireOwner(principal);
      return directory.directoryPeoplePage(principal.orgId, params);
    },

    // A page of the directory's groups by name, with the role each is linked with, for linking.
    async directoryGroups(principal: Principal, params: PageParams) {
      await requireOwner(principal);
      return directory.directoryGroupPage(principal.orgId, params);
    },

    // The directory changed the person or the groups they are in. Once it turned them off or
    // deleted them, their own roles in team orgs go, except where they are the last owner in their
    // own right. Each team org they are in, or could be through a group, is settled for them.
    async directoryChanged(userId: string, active: boolean) {
      if (!active) await directory.clearDirectRoles(userId);
      for (const orgId of await directory.orgsToSettle(userId)) await settle(orgId, [userId]);
    },

    async rename(principal: Principal, name: string) {
      await requireOwner(principal);
      await directory.renameOrg(principal.orgId, name);
    },

    // Has the agent stopped in the org's threads, then deletes the org with everything in it.
    async delete(principal: Principal) {
      if ((await directory.org(principal.orgId))?.kind !== "team") {
        throw new ServiceError(403, "A personal organization cannot be deleted");
      }
      await requireOwner(principal);
      await options.hooks?.run("org.deleting", { orgId: principal.orgId, by: principal.userId });
      await directory.deleteOrg(principal.orgId);
    },

    settings: teamSettings,

    // What the agent of the org's threads goes by where people see it.
    async agentName(principal: Principal): Promise<AgentName> {
      return { name: (await settings.get(principal.orgId)).agentName ?? DEFAULT_AGENT_NAME };
    },

    // Names the org's agent, for its owners; the usual name is kept as none.
    async setAgentName(principal: Principal, name: string): Promise<AgentName> {
      if (principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can do this");
      }
      await settings.setAgentName(principal.orgId, name === DEFAULT_AGENT_NAME ? null : name);
      return { name };
    },

    async setSettings(principal: Principal, changes: Partial<TeamSettings>): Promise<TeamSettings> {
      await requireOwner(principal);
      const before = (await settings.get(principal.orgId)).memberSpaces;
      await settings.setTeamSettings(principal.orgId, changes);
      const allowed = changes.memberSpaces;
      if (allowed !== undefined && allowed !== before) {
        await options.hooks?.run("org.personalSpacesChanged", { orgId: principal.orgId, allowed });
      }
      return teamSettings(principal);
    },
  };
  // The directory's changes settle the orgs the person is in, or could be through a group.
  options.hooks?.on("directory.changed", async ({ userId, active }) =>
    orgs.directoryChanged(userId, active),
  );
  return orgs;
}

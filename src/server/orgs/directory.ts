// The people and groups of each org: who belongs to which org and with what role, the directory's
// groups orgs link with a role, and the people removed from an org. A member's role is the highest
// of the one given to them in the org and those of the linked groups they are active in; settling
// an org brings its members in line with that. Every record says where it comes from: Mage itself,
// or the SCIM directory the server is connected to.

import type { Page, PageParams } from "@/shared/paging.ts";

export type OrgRole = "owner" | "member";

export type OrgKind = "personal" | "team";

// Where a record comes from: Mage itself, or a directory it syncs from.
export type RecordSource = "local" | "scim";

export interface Org {
  id: string;
  name: string;
  kind: OrgKind;
  createdAt: Date;
}

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  source: RecordSource;
}

// A person the directory brought, and their role in an org, if any.
export interface DirectoryPerson extends DirectoryUser {
  role: OrgRole | null;
}

export interface OrgMember extends DirectoryUser {
  role: OrgRole;
  joinedAt: Date;
}

export interface Group {
  id: string;
  name: string;
  source: RecordSource;
  // The group's id in the directory it comes from; null for local groups.
  externalId: string | null;
  // The group's mail address in the directory, if it has one.
  email: string | null;
  createdAt: Date;
}

export interface MemberRow extends OrgMember {
  // How many of the org's linked groups they are in.
  groupCount: number;
  // The role given to them in the org itself; null when they are in only through groups.
  directRole: OrgRole | null;
  // The name of a linked group they are in, the first by name, when they are in any.
  viaGroup: string | null;
  // The highest role their linked groups give, when they are in any.
  groupRole: OrgRole | null;
}

// An invite not yet used, as a row among the org's people.
export interface InviteRow {
  id: string;
  email: string;
  role: OrgRole;
  createdByName: string | null;
  expiresAt: Date;
}

export interface GroupRow extends Group {
  // How many active people are in it.
  memberCount: number;
}

// A group linked to an org, and the role it gives.
export interface LinkedGroupRow extends GroupRow {
  role: OrgRole;
  linkedAt: Date;
}

export type PersonRow =
  | ({ kind: "member" } & MemberRow)
  | ({ kind: "invite" } & InviteRow)
  | ({ kind: "group" } & LinkedGroupRow);

// What settling an org changed: who joined it, who left it, and whether any role changed.
export interface Settled {
  joined: string[];
  left: string[];
  changed: boolean;
}

export interface Directory {
  org(orgId: string): Org | null;
  // The orgs the user belongs to with their role in each: their personal org first, then by name.
  orgsOf(userId: string): (Org & { role: OrgRole; ownerName: string | null })[];
  // Makes a team org with the user as its owner.
  createTeamOrg(name: string, ownerId: string): Promise<Org>;

  renameOrg(orgId: string, name: string): void;
  // Deletes the org with everything in it: its spaces and their threads, connections, settings,
  // group links, invites and members. Sessions that used it last forget it.
  deleteOrg(orgId: string): void;

  user(id: string): DirectoryUser | null;
  userByEmail(email: string): DirectoryUser | null;

  // The user's role in the org, or null when they are not in it.
  roleIn(orgId: string, userId: string): OrgRole | null;
  // The org's members, oldest first.
  members(orgId: string): OrgMember[];
  // A page of the org's members by name, matching the text in name or email, of the role and the one
  // user if given.
  memberPage(
    orgId: string,
    params: PageParams & { role?: OrgRole; userId?: string },
  ): Page<MemberRow>;
  member(orgId: string, userId: string): OrgMember | null;
  // A page of the org's people: its invites not yet used at `invitesAt` first, by email, when asked
  // for, then its linked groups and its members with a role of their own, by name; someone in only
  // through groups is left to their groups' rows. Matching the text in name or email, of the role
  // and status if given.
  peoplePage(
    orgId: string,
    params: PageParams & {
      role?: OrgRole;
      status?: "member" | "invited" | "group";
      invitesAt: Date | null;
    },
  ): Page<PersonRow>;
  // Makes the user a member with the role as their own, and clears them as a former member.
  addMember(orgId: string, userId: string, role: OrgRole): Promise<void>;
  // Gives the user, or with null takes back, a role of their own in the org; settling the org then
  // works out their membership.
  setDirectRole(orgId: string, userId: string, role: OrgRole | null): void;
  // How many members have owner as a role of their own.
  directOwnerCount(orgId: string): number;
  // Brings the team org's members, or only those of the users, in line with their own roles and
  // their active linked groups': someone who gains a role becomes a member, someone who keeps one
  // gets the highest, and someone left with none is taken out of the org and the roles given to
  // them in its spaces, and kept as a former member.
  settle(orgId: string, at: Date, userIds?: string[]): Settled;
  // The team orgs the user is a member of or has a linked group in.
  orgsToSettle(userId: string): string[];
  // Takes back the user's own roles in team orgs, but not in one where they are the last who owns
  // it in their own right.
  clearDirectRoles(userId: string): void;
  // The org's former members among the users.
  formerMembers(orgId: string, userIds: string[]): string[];

  // A directory group, or null when there is none by the id.
  group(id: string): Group | null;
  // The role the group is linked to the org with, or null when it is not linked.
  linkedRole(orgId: string, groupId: string): OrgRole | null;
  // A page of the groups linked to the org by name, or of those the user is active in, matching
  // the text in the name.
  groupPage(orgId: string, params: PageParams & { userId?: string }): Page<LinkedGroupRow>;
  // A page of the group's active members by name, matching the text in name or email.
  groupMemberPage(groupId: string, params: PageParams): Page<DirectoryUser>;
  memberCount(groupId: string): number;
  // The ids of the groups linked to the org that the user is active in.
  groupIdsOf(orgId: string, userId: string): string[];
  // A page of the directory's active people by name, with their role in the org, matching the text
  // in name or email.
  directoryPeoplePage(orgId: string, params: PageParams): Page<DirectoryPerson>;
  // A page of the directory's groups by name, with the role each is linked to the org with,
  // matching the text in the name.
  directoryGroupPage(orgId: string, params: PageParams): Page<GroupRow & { role: OrgRole | null }>;
  linkGroup(orgId: string, groupId: string, role: OrgRole): void;
  // Unlinks the group, with the roles the org's spaces gave it.
  unlinkGroup(orgId: string, groupId: string): void;
}

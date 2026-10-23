// The people and groups of each org: who belongs to which org and with what role, the groups owners
// make, and the people removed from an org. Every record says where it comes from, so a directory
// outside Mage can bring its own beside the local ones.

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

export interface OrgMember extends DirectoryUser {
  role: OrgRole;
  joinedAt: Date;
}

export interface Group {
  id: string;
  orgId: string;
  name: string;
  source: RecordSource;
  // The group's id in the directory it comes from; null for local groups.
  externalId: string | null;
  createdAt: Date;
}

export interface MemberRow extends OrgMember {
  // How many of the org's groups they are in.
  groupCount: number;
}

// An invite not yet used, as a row among the org's people.
export interface InviteRow {
  id: string;
  email: string;
  role: OrgRole;
  createdByName: string | null;
  expiresAt: Date;
}

export type PersonRow = ({ kind: "member" } & MemberRow) | ({ kind: "invite" } & InviteRow);

export interface GroupRow extends Group {
  memberCount: number;
}

export interface Directory {
  org(orgId: string): Org | null;
  // The orgs the user belongs to with their role in each: their personal org first, then by name.
  orgsOf(userId: string): (Org & { role: OrgRole; ownerName: string | null })[];
  // Makes a team org with the user as its owner.
  createTeamOrg(name: string, ownerId: string): Promise<Org>;

  renameOrg(orgId: string, name: string): void;
  // Deletes the org with everything in it: its spaces and their threads, connections, settings,
  // groups, invites and members. Sessions that used it last forget it.
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
  // for, then its members by name; matching the text in name or email, of the role and status if
  // given.
  peoplePage(
    orgId: string,
    params: PageParams & {
      role?: OrgRole;
      status?: "member" | "invited";
      invitesAt: Date | null;
    },
  ): Page<PersonRow>;
  // Makes the user a member, and clears them as a former member.
  addMember(orgId: string, userId: string, role: OrgRole): Promise<void>;
  setRole(orgId: string, userId: string, role: OrgRole): void;
  // Takes the user out of the org, its groups and the roles given to them in its spaces, and keeps
  // them as a former member.
  removeMember(orgId: string, userId: string, at: Date): void;
  // The org's former members among the users.
  formerMembers(orgId: string, userIds: string[]): string[];

  // The org's groups by name.
  groups(orgId: string): Group[];
  group(id: string): Group | null;
  // A page of the org's groups by name, or of those the user is in, matching the text in the name.
  groupPage(orgId: string, params: PageParams & { userId?: string }): Page<GroupRow>;
  // A page of the group's members by name, matching the text in name or email.
  groupMemberPage(groupId: string, params: PageParams): Page<DirectoryUser>;
  memberCount(groupId: string): number;
  // The ids of the org's groups the user is in.
  groupIdsOf(orgId: string, userId: string): string[];
  createGroup(orgId: string, name: string): Group;
  renameGroup(id: string, name: string): Group;
  // Deletes the group with its members and the roles spaces gave it.
  deleteGroup(id: string): void;
  // Each group's members' ids, for the org's groups.
  groupMembers(orgId: string): Map<string, string[]>;
  addToGroup(groupId: string, userId: string): void;
  removeFromGroup(groupId: string, userId: string): void;
}

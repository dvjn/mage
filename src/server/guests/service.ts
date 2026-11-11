// Letting people outside a thread's space into that one thread. The space's owners and messagers
// make single-use invite links, shown once, that work for seven days and give whoever opens one
// access for an hour, a day, a week or for good, to view the thread or to message in it; opening
// another link renews it. They see who is in the thread and the links not yet used, and revoke
// them: owners any guest or link, messagers those they made. They also change what a guest or a
// link allows, and what the thread allows the org's members outside the space.

import { createHash, randomBytes } from "node:crypto";

import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { SpaceRole } from "@/server/spaces/service.ts";
import type {
  ThreadStore,
  Listed,
  ListedThread,
  ListWindow,
  Thread,
  ThreadListFilter,
} from "@/server/threads/service.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { PageParams, Page } from "@/shared/paging.ts";
import type { Transact } from "@/server/db/db.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Access, ThreadAccess } from "@/server/spaces/thread-access.ts";
import {
  ACCESS_FOR_MS,
  type AccessFor,
  type CreatedInvite,
  type GuestCandidate,
  type OrgAccess,
  type PendingInvite,
  type ThreadRole,
  type ThreadPeople,
  type ThreadPerson,
} from "@/shared/guests.ts";

export interface ThreadGuest {
  threadId: string;
  userId: string;
  // Whoever's invite last granted the access; null once they are gone.
  invitedBy: string | null;
  // Whether they may only read the thread or post in it too.
  role: ThreadRole;
  createdAt: Date;
  // Null for access that does not run out.
  accessUntil: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

// A directory group let into a thread: everyone in it while it lasts is a guest.
export interface ThreadGroupGuest {
  threadId: string;
  groupId: string;
  invitedBy: string | null;
  role: ThreadRole;
  createdAt: Date;
  accessUntil: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export interface ThreadInvite {
  id: string;
  threadId: string;
  createdBy: string | null;
  createdAt: Date;
  linkExpiresAt: Date;
  accessFor: AccessFor;
  role: ThreadRole;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

// A thread a user is a guest in, with its space's name as an outsider sees it and its org's name.
export interface GuestThread {
  thread: Thread;
  spaceName: string;
  orgName: string;
  // The space is the org's person's own first space, named after them, so the org adds nothing.
  spaceNamedForOrg: boolean;
  accessUntil: Date | null;
}

export interface GuestStore {
  // The user's guest row in the thread, active or not, or null when they never were one.
  find(threadId: string, userId: string): ThreadGuest | null;
  // Makes the user a guest of the thread with access until then, or gives a guest row that exists
  // that access again, clearing any revocation.
  grant(guest: {
    threadId: string;
    userId: string;
    invitedBy: string | null;
    accessUntil: Date | null;
    // Message when not given.
    role?: ThreadRole;
  }): ThreadGuest;
  setRole(threadId: string, userId: string, role: ThreadRole): void;
  // The group's grant on the thread, active or not, or null when it never had one.
  findGroup(threadId: string, groupId: string): ThreadGroupGuest | null;
  // Lets the group's people in until then, or gives a grant that exists that access again.
  grantGroup(grant: {
    threadId: string;
    groupId: string;
    invitedBy: string | null;
    accessUntil: Date | null;
    role: ThreadRole;
  }): ThreadGroupGuest;
  setGroupRole(threadId: string, groupId: string, role: ThreadRole): void;
  revokeGroup(threadId: string, groupId: string, by: string, at: Date): void;
  // The thread's groups whose grant has not ended at `now`, oldest first, with their names, how
  // many people are in them and their inviters' names.
  activeGroupsIn(
    threadId: string,
    now: Date,
  ): (ThreadGroupGuest & { name: string; memberCount: number; invitedByName: string | null })[];
  // What the user's active groups let them do in the thread while they have no role in its space,
  // the most any gives; null when none does.
  groupRole(threadId: string, userId: string, now: Date): ThreadRole | null;
  // Everyone who is a guest of the thread at `now`, by a grant of their own or through a group,
  // with the most they may do.
  reachedIn(threadId: string, now: Date): { userId: string; name: string; role: ThreadRole }[];
  // What the org's members outside the thread's space may do in it.
  orgAccess(threadId: string): OrgAccess;
  setOrgAccess(threadId: string, orgAccess: OrgAccess): void;
  revoke(threadId: string, userId: string, by: string, at: Date): void;
  // The thread's guests whose access has not ended at `now`, oldest first, with their names and
  // their inviters' names.
  activeIn(
    threadId: string,
    now: Date,
  ): (ThreadGuest & { name: string; invitedByName: string | null })[];
  // The threads the user is an active guest in at `now`, or reaches through their org's access to
  // a space they have no role in, but those of spaces in trash, most recently active first.
  threadsOf(userId: string, now: Date): GuestThread[];
  // Those of them the filter keeps, matching text in their title or the place they are in; those
  // the window takes, every match without one.
  sharedListed(
    userId: string,
    now: Date,
    filter: ThreadListFilter,
    window?: ListWindow,
  ): Listed<GuestThread & ListedThread>;
  // The thread's space name as someone outside its org sees it, or null for an unknown thread.
  hostSpaceName(threadId: string): string | null;

  createInvite(invite: {
    threadId: string;
    tokenHash: string;
    createdBy: string;
    linkExpiresAt: Date;
    accessFor: AccessFor;
    role: ThreadRole;
  }): ThreadInvite;
  setInviteRole(id: string, role: ThreadRole): void;
  findInvite(id: string): ThreadInvite | null;
  findInviteByHash(tokenHash: string): ThreadInvite | null;
  // The thread's links not used, revoked or expired at `now`, oldest first.
  pendingInvites(threadId: string, now: Date): ThreadInvite[];
  // Stamps the link used by the user; false when it was used or revoked first.
  markAccepted(id: string, userId: string, at: Date): boolean;
  revokeInvite(id: string, at: Date): void;
}

export interface GuestsOptions {
  access: Pick<ThreadAccess, "of" | "require">;
  guests: GuestStore;
  directory: Pick<Directory, "memberPage" | "roleIn" | "user" | "groupPage" | "linkedRole">;
  threads: Pick<ThreadStore, "eventsAfter">;
  transact: Transact;
  // Tells the guest's inbox when their access begins or ends.
  bus: Pick<EventBus, "activity">;
  // Where the app is served; invite links lead there.
  baseUrl: string;
  now?: () => Date;
}

export type Guests = ReturnType<typeof createGuests>;

// The most groups the first page of candidates holds.
const GROUPS_MAX = 5;

export const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function hashOf(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// The later of two ends of access, where null never ends.
function later(a: Date | null, b: Date | null) {
  if (!a || !b) return null;
  return a > b ? a : b;
}

// An owner may revoke anything; a messager what they made.
// The more of two roles.
function wider(a: ThreadRole, b: ThreadRole): ThreadRole {
  return a === "message" || b === "message" ? "message" : "view";
}

function mayRevoke(access: Access, principal: Principal, madeBy: string | null) {
  return access.via === "space" && (access.role === "owner" || madeBy === principal.userId);
}

export function createGuests(options: GuestsOptions) {
  const { access, guests, directory, threads, transact, bus, baseUrl } = options;
  const now = options.now ?? (() => new Date());

  function pendingSummary(invite: ThreadInvite, canRevoke: boolean): PendingInvite {
    return {
      id: invite.id,
      accessFor: invite.accessFor,
      role: invite.role,
      createdBy: invite.createdBy,
      linkExpiresAt: invite.linkExpiresAt.toISOString(),
      canRevoke,
    };
  }

  // Refuses a link that can no longer be used, saying why.
  function refuse(invite: ThreadInvite) {
    if (invite.revokedAt) throw new ServiceError(410, "This invite link was revoked", "revoked");
    if (invite.acceptedAt) throw new ServiceError(410, "This invite link was already used", "used");
    if (invite.linkExpiresAt <= now()) {
      throw new ServiceError(410, "This invite link has expired", "expired");
    }
  }

  // Whether the access is one a guest grant does not add to: the space's, or a guest's own.
  function reaches(found: Access | null) {
    return !!found && !(found.via === "guest" && found.viaOrg);
  }

  // Why the person needs no grant, in a few words; null when they do.
  function reason(found: Access | null) {
    if (!reaches(found)) return null;
    if (found?.via === "space") {
      return found.role === "owner"
        ? "Owner"
        : `In the space · ${found.role === "messager" ? "Message" : "View"}`;
    }
    return "Guest";
  }

  return {
    // A new link to the thread; its token is in the url and nowhere else.
    invite(
      principal: Principal,
      threadId: string,
      accessFor: AccessFor,
      role: ThreadRole,
    ): CreatedInvite {
      access.require(principal, threadId, "share");
      const token = randomBytes(32).toString("base64url");
      const invite = guests.createInvite({
        threadId,
        tokenHash: hashOf(token),
        createdBy: principal.userId,
        linkExpiresAt: new Date(now().getTime() + LINK_LIFETIME_MS),
        accessFor,
        role,
      });
      return {
        id: invite.id,
        url: new URL(`/invite/${token}`, baseUrl).toString(),
        accessFor,
        role,
        linkExpiresAt: invite.linkExpiresAt.toISOString(),
      };
    },

    // The org's members and groups who could be added, matching the text in name or email, those
    // who already have access too, marked with why. The groups come with the first page.
    candidates(principal: Principal, threadId: string, params: PageParams): Page<GuestCandidate> {
      const { thread } = access.require(principal, threadId, "share");
      const page = directory.memberPage(principal.orgId, params);
      const held = new Set(
        guests.activeGroupsIn(thread.rootThreadId ?? threadId, now()).map((row) => row.groupId),
      );
      const groups = params.cursor
        ? []
        : directory
            .groupPage(principal.orgId, {
              ...(params.q && { q: params.q }),
              limit: GROUPS_MAX,
            })
            .items.map((group): GuestCandidate => ({
              kind: "group",
              id: group.id,
              name: group.name,
              email: group.email ?? "",
              memberCount: group.memberCount,
              already: held.has(group.id) ? "Added" : null,
            }));
      const people = page.items.map((member): GuestCandidate => ({
        kind: "user",
        id: member.id,
        name: member.name,
        email: member.email,
        memberCount: null,
        already: reason(access.of({ userId: member.id, orgId: principal.orgId }, thread)),
      }));
      return { items: [...groups, ...people], nextCursor: page.nextCursor, total: page.total };
    },

    // Makes a member of the thread's org a guest for as long as asked, as a link would; only one
    // the thread's candidates include.
    add(
      principal: Principal,
      threadId: string,
      userId: string,
      accessFor: AccessFor,
      role: ThreadRole,
    ) {
      const { thread } = access.require(principal, threadId, "share");
      const person = directory.user(userId);
      if (
        !person ||
        !directory.roleIn(principal.orgId, userId) ||
        reaches(access.of({ userId, orgId: principal.orgId }, thread))
      ) {
        throw new ServiceError(404, "Person not found");
      }
      const span = ACCESS_FOR_MS[accessFor];
      guests.grant({
        threadId,
        userId,
        invitedBy: principal.userId,
        accessUntil: span === null ? null : new Date(now().getTime() + span),
        role,
      });
      bus.activity({ threadId });
    },

    // Lets everyone in a group of the thread's org in as guests for as long as asked, while they
    // are in it.
    addGroup(
      principal: Principal,
      threadId: string,
      groupId: string,
      accessFor: AccessFor,
      role: ThreadRole,
    ) {
      const { thread } = access.require(principal, threadId, "share");
      if (!directory.linkedRole(principal.orgId, groupId)) {
        throw new ServiceError(404, "Group not found");
      }
      const span = ACCESS_FOR_MS[accessFor];
      guests.grantGroup({
        threadId: thread.rootThreadId ?? threadId,
        groupId,
        invitedBy: principal.userId,
        accessUntil: span === null ? null : new Date(now().getTime() + span),
        role,
      });
      bus.activity({ threadId });
    },

    // The space's members who have written in the thread, its guests, and its links not yet used.
    people(principal: Principal, threadId: string): ThreadPeople {
      const { thread, access: mine } = access.require(principal, threadId, "share");
      const at = now();
      const active = guests.activeIn(threadId, at);
      const groups = guests.activeGroupsIn(thread.rootThreadId ?? threadId, at);
      const guestIds = new Set(active.map((guest) => guest.userId));
      const writers = new Map<string, { name: string; role: SpaceRole }>();
      for (const event of threads.eventsAfter(threadId, 0)) {
        if (event.type !== "message" || event.actor.kind !== "user") continue;
        const { userId } = event.actor;
        if (guestIds.has(userId) || writers.has(userId) || !event.actorName) continue;
        const theirs = access.of({ userId, orgId: principal.orgId }, thread);
        if (theirs?.via === "space")
          writers.set(userId, { name: event.actorName, role: theirs.role });
      }
      const members: ThreadPerson[] = [...writers].map(([userId, { name, role }]) => ({
        userId,
        name,
        kind: "member",
        role,
        access: null,
        accessUntil: null,
        invitedBy: null,
        memberCount: null,
        canRevoke: false,
      }));
      return {
        people: [
          ...members,
          ...active.map((guest): ThreadPerson => ({
            userId: guest.userId,
            name: guest.name,
            kind: "guest",
            role: null,
            access: guest.role,
            accessUntil: guest.accessUntil?.toISOString() ?? null,
            invitedBy: guest.invitedByName,
            memberCount: null,
            canRevoke: mayRevoke(mine, principal, guest.invitedBy),
          })),
          ...groups.map((group): ThreadPerson => ({
            userId: group.groupId,
            name: group.name,
            kind: "group",
            role: null,
            access: group.role,
            accessUntil: group.accessUntil?.toISOString() ?? null,
            invitedBy: group.invitedByName,
            memberCount: group.memberCount,
            canRevoke: mayRevoke(mine, principal, group.invitedBy),
          })),
        ],
        invites: guests
          .pendingInvites(threadId, at)
          .map((invite) => pendingSummary(invite, mayRevoke(mine, principal, invite.createdBy))),
        orgAccess: guests.orgAccess(thread.rootThreadId ?? threadId),
      };
    },

    // What the org's members outside the space may do in the thread.
    setOrgAccess(principal: Principal, threadId: string, orgAccess: OrgAccess) {
      const { thread } = access.require(principal, threadId, "share");
      guests.setOrgAccess(thread.rootThreadId ?? threadId, orgAccess);
      bus.activity({ threadId });
    },

    // What an active guest may do in the thread.
    setGuestRole(principal: Principal, threadId: string, userId: string, role: ThreadRole) {
      access.require(principal, threadId, "share");
      const guest = guests.activeIn(threadId, now()).find((found) => found.userId === userId);
      if (!guest) throw new ServiceError(404, "Guest not found");
      guests.setRole(threadId, userId, role);
      bus.activity({ threadId });
    },

    // What an active group of guests may do in the thread.
    setGroupRole(principal: Principal, threadId: string, groupId: string, role: ThreadRole) {
      const { thread } = access.require(principal, threadId, "share");
      const root = thread.rootThreadId ?? threadId;
      if (!guests.activeGroupsIn(root, now()).some((found) => found.groupId === groupId)) {
        throw new ServiceError(404, "Group not found");
      }
      guests.setGroupRole(root, groupId, role);
      bus.activity({ threadId });
    },

    revokeGroup(principal: Principal, threadId: string, groupId: string) {
      const { thread, access: mine } = access.require(principal, threadId, "share");
      const root = thread.rootThreadId ?? threadId;
      const at = now();
      const group = guests.activeGroupsIn(root, at).find((found) => found.groupId === groupId);
      if (!group) throw new ServiceError(404, "Group not found");
      if (!mayRevoke(mine, principal, group.invitedBy)) {
        throw new ServiceError(
          403,
          "Only the space's owner or whoever added the group can remove it",
        );
      }
      guests.revokeGroup(root, groupId, principal.userId, at);
      bus.activity({ threadId });
    },

    // What whoever opens a link not yet used may do in the thread.
    setInviteRole(principal: Principal, threadId: string, inviteId: string, role: ThreadRole) {
      access.require(principal, threadId, "share");
      const invite = guests.findInvite(inviteId);
      if (!invite || invite.threadId !== threadId || invite.acceptedAt || invite.revokedAt) {
        throw new ServiceError(404, "Invite not found");
      }
      guests.setInviteRole(inviteId, role);
    },

    revokeInvite(principal: Principal, threadId: string, inviteId: string) {
      const { access: mine } = access.require(principal, threadId, "share");
      const invite = guests.findInvite(inviteId);
      if (!invite || invite.threadId !== threadId || invite.acceptedAt || invite.revokedAt) {
        throw new ServiceError(404, "Invite not found");
      }
      if (!mayRevoke(mine, principal, invite.createdBy)) {
        throw new ServiceError(
          403,
          "Only the space's owner or whoever made the link can revoke it",
        );
      }
      guests.revokeInvite(inviteId, now());
    },

    revokeGuest(principal: Principal, threadId: string, userId: string) {
      const { access: mine } = access.require(principal, threadId, "share");
      const at = now();
      const guest = guests.activeIn(threadId, at).find((found) => found.userId === userId);
      if (!guest) throw new ServiceError(404, "Guest not found");
      if (!mayRevoke(mine, principal, guest.invitedBy)) {
        throw new ServiceError(
          403,
          "Only the space's owner or whoever invited them can revoke a guest",
        );
      }
      guests.revoke(threadId, userId, principal.userId, at);
      bus.activity({ threadId });
    },

    // Makes the principal a guest of the link's thread, or renews their access, and uses the link
    // up. Someone who can already see the thread through its space just goes to it, leaving the
    // link for whoever it was meant for; opening a link one has used again goes to the thread too.
    accept(principal: Principal, token: string) {
      const invite = guests.findInviteByHash(hashOf(token));
      if (!invite) throw new ServiceError(404, "This invite link does not exist", "not_found");
      const { threadId } = invite;
      const reached = () => {
        try {
          return access.require(principal, threadId).access;
        } catch {
          return null;
        }
      };
      if (reached()?.via === "space") return { threadId };
      if (invite.acceptedBy === principal.userId && reached()) return { threadId };
      refuse(invite);
      transact(() => {
        const at = now();
        // Someone else used or revoked it meanwhile.
        if (!guests.markAccepted(invite.id, principal.userId, at)) {
          refuse(guests.findInvite(invite.id) ?? invite);
          throw new ServiceError(410, "This invite link was already used", "used");
        }
        const span = ACCESS_FOR_MS[invite.accessFor];
        const until = span === null ? null : new Date(at.getTime() + span);
        const current = guests.find(threadId, principal.userId);
        const holds =
          current && !current.revokedAt && (!current.accessUntil || current.accessUntil > at);
        // Access that already lasts longer stays as it is, with whoever gave it.
        const keeps = holds && later(current.accessUntil, until) === current.accessUntil;
        guests.grant({
          threadId,
          userId: principal.userId,
          invitedBy: keeps ? current.invitedBy : invite.createdBy,
          accessUntil: holds ? later(current.accessUntil, until) : until,
          role: holds ? wider(current.role, invite.role) : invite.role,
        });
      });
      bus.activity({ threadId });
      return { threadId };
    },
  };
}

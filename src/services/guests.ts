// Letting people outside a thread's space into that one thread. The space's owners and messagers
// make single-use invite links, shown once, that work for seven days and give whoever opens one
// access for an hour, a day, a week or for good; opening another link renews it. They see who is
// in the thread and the links not yet used, and revoke them: owners any guest or link, messagers
// those they made.

import { createHash, randomBytes } from "node:crypto";

import type { GuestStore, ThreadInvite } from "@/ports/guests.ts";
import type { Principal } from "@/ports/identity.ts";
import type { SpaceRole } from "@/ports/spaces.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import type { Transact } from "@/ports/transaction.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Access, ThreadAccess } from "@/services/thread-access.ts";
import {
  ACCESS_FOR_MS,
  type AccessFor,
  type CreatedInvite,
  type PendingInvite,
  type ThreadPeople,
  type ThreadPerson,
} from "@/shared/guests.ts";

export interface GuestsOptions {
  access: Pick<ThreadAccess, "of" | "require">;
  guests: GuestStore;
  threads: Pick<ThreadStore, "eventsAfter">;
  transact: Transact;
  // Where the app is served; invite links lead there.
  baseUrl: string;
  now?: () => Date;
}

export type Guests = ReturnType<typeof createGuests>;

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
function mayRevoke(access: Access, principal: Principal, madeBy: string | null) {
  return access.via === "space" && (access.role === "owner" || madeBy === principal.userId);
}

export function createGuests(options: GuestsOptions) {
  const { access, guests, threads, transact, baseUrl } = options;
  const now = options.now ?? (() => new Date());

  function pendingSummary(invite: ThreadInvite, canRevoke: boolean): PendingInvite {
    return {
      id: invite.id,
      accessFor: invite.accessFor,
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

  return {
    // A new link to the thread; its token is in the url and nowhere else.
    invite(principal: Principal, threadId: string, accessFor: AccessFor): CreatedInvite {
      access.require(principal, threadId, "share");
      const token = randomBytes(32).toString("base64url");
      const invite = guests.createInvite({
        threadId,
        tokenHash: hashOf(token),
        createdBy: principal.userId,
        linkExpiresAt: new Date(now().getTime() + LINK_LIFETIME_MS),
        accessFor,
      });
      return {
        id: invite.id,
        url: new URL(`/invite/${token}`, baseUrl).toString(),
        accessFor,
        linkExpiresAt: invite.linkExpiresAt.toISOString(),
      };
    },

    // The space's members who have written in the thread, its guests, and its links not yet used.
    people(principal: Principal, threadId: string): ThreadPeople {
      const { thread, access: mine } = access.require(principal, threadId, "share");
      const at = now();
      const active = guests.activeIn(threadId, at);
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
        accessUntil: null,
        invitedBy: null,
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
            accessUntil: guest.accessUntil?.toISOString() ?? null,
            invitedBy: guest.invitedByName,
            canRevoke: mayRevoke(mine, principal, guest.invitedBy),
          })),
        ],
        invites: guests
          .pendingInvites(threadId, at)
          .map((invite) => pendingSummary(invite, mayRevoke(mine, principal, invite.createdBy))),
      };
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
        });
      });
      return { threadId };
    },
  };
}

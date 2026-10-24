// Thread guests and the invite links that make them: people outside a thread's space let into that
// one thread until their access runs out or is revoked.

import type { AccessFor } from "@/shared/guests.ts";

import type { Listed, ListedThread, ListWindow, Thread, ThreadListFilter } from "./threads.ts";

export interface ThreadGuest {
  threadId: string;
  userId: string;
  // Whoever's invite last granted the access; null once they are gone.
  invitedBy: string | null;
  createdAt: Date;
  // Null for access that does not run out.
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
  }): ThreadGuest;
  revoke(threadId: string, userId: string, by: string, at: Date): void;
  // The thread's guests whose access has not ended at `now`, oldest first, with their names and
  // their inviters' names.
  activeIn(
    threadId: string,
    now: Date,
  ): (ThreadGuest & { name: string; invitedByName: string | null })[];
  // The threads the user is an active guest in at `now`, most recently active first.
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
  }): ThreadInvite;
  findInvite(id: string): ThreadInvite | null;
  findInviteByHash(tokenHash: string): ThreadInvite | null;
  // The thread's links not used, revoked or expired at `now`, oldest first.
  pendingInvites(threadId: string, now: Date): ThreadInvite[];
  // Stamps the link used by the user; false when it was used or revoked first.
  markAccepted(id: string, userId: string, at: Date): boolean;
  revokeInvite(id: string, at: Date): void;
}

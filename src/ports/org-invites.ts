// Invites to join a team org: single-use links bound to one email address.

import type { OrgRole } from "./directory.ts";

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
  }): OrgInvite;
  find(id: string): OrgInvite | null;
  findByHash(tokenHash: string): OrgInvite | null;
  // The org's invites not used, revoked or expired at `now`, newest first, with who made each.
  pending(orgId: string, now: Date): (OrgInvite & { createdByName: string | null })[];
  // Stamps the invite used by the user; false when it was used or revoked first.
  markAccepted(id: string, userId: string, at: Date): boolean;
  revoke(id: string, at: Date): void;
}

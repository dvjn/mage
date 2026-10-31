import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";

import type { OrgInvite, OrgInviteStore } from "./service.ts";
import { orgInvite, user } from "./schema.ts";

const columns = {
  id: orgInvite.id,
  orgId: orgInvite.organizationId,
  email: orgInvite.email,
  role: orgInvite.role,
  createdBy: orgInvite.createdBy,
  createdAt: orgInvite.createdAt,
  expiresAt: orgInvite.expiresAt,
  acceptedBy: orgInvite.acceptedBy,
  acceptedAt: orgInvite.acceptedAt,
  revokedAt: orgInvite.revokedAt,
};

export function createOrgInviteStore(db: Db): OrgInviteStore {
  return {
    create({ orgId, ...invite }) {
      return db
        .insert(orgInvite)
        .values({ id: ulid(), organizationId: orgId, ...invite })
        .returning(columns)
        .get();
    },

    find(id): OrgInvite | null {
      return db.select(columns).from(orgInvite).where(eq(orgInvite.id, id)).get() ?? null;
    },

    findByHash(tokenHash): OrgInvite | null {
      return (
        db.select(columns).from(orgInvite).where(eq(orgInvite.tokenHash, tokenHash)).get() ?? null
      );
    },

    pending(orgId, now) {
      return db
        .select({ ...columns, createdByName: user.name })
        .from(orgInvite)
        .leftJoin(user, eq(user.id, orgInvite.createdBy))
        .where(
          and(
            eq(orgInvite.organizationId, orgId),
            isNull(orgInvite.acceptedAt),
            isNull(orgInvite.revokedAt),
            gt(orgInvite.expiresAt, now),
          ),
        )
        .orderBy(desc(orgInvite.createdAt))
        .all();
    },

    markAccepted(id, userId, at) {
      const result = db
        .update(orgInvite)
        .set({ acceptedBy: userId, acceptedAt: at })
        .where(and(eq(orgInvite.id, id), isNull(orgInvite.acceptedAt), isNull(orgInvite.revokedAt)))
        .run();
      return result.changes > 0;
    },

    revoke(id, at) {
      db.update(orgInvite).set({ revokedAt: at }).where(eq(orgInvite.id, id)).run();
    },
  };
}

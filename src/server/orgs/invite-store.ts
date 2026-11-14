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
    async create({ orgId, ...invite }) {
      return (
        await db
          .insert(orgInvite)
          .values({ id: ulid(), organizationId: orgId, ...invite })
          .returning(columns)
      )[0]!;
    },

    async find(id): Promise<OrgInvite | null> {
      return (
        (await db.select(columns).from(orgInvite).where(eq(orgInvite.id, id)).limit(1))[0] ?? null
      );
    },

    async findByHash(tokenHash): Promise<OrgInvite | null> {
      return (
        (
          await db
            .select(columns)
            .from(orgInvite)
            .where(eq(orgInvite.tokenHash, tokenHash))
            .limit(1)
        )[0] ?? null
      );
    },

    async pending(orgId, now) {
      return await db
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
        .orderBy(desc(orgInvite.createdAt));
    },

    async markAccepted(id, userId, at) {
      const result = await db
        .update(orgInvite)
        .set({ acceptedBy: userId, acceptedAt: at })
        .where(and(eq(orgInvite.id, id), isNull(orgInvite.acceptedAt), isNull(orgInvite.revokedAt)))
        .returning({ id: orgInvite.id });
      return result.length > 0;
    },

    async revoke(id, at) {
      await db.update(orgInvite).set({ revokedAt: at }).where(eq(orgInvite.id, id));
    },
  };
}

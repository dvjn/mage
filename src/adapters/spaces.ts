// Spaces and their members kept in the space and space_member tables, with ULID ids.

import { and, asc, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Space, SpaceStore } from "@/ports/spaces.ts";

import type { Db } from "./db.ts";
import { space, spaceMember } from "./schema.ts";

const columns = {
  id: space.id,
  orgId: space.organizationId,
  kind: space.kind,
  name: space.name,
  primary: space.primary,
  createdBy: space.createdBy,
  createdAt: space.createdAt,
  updatedAt: space.updatedAt,
};

export function createSpaceStore(db: Db): SpaceStore {
  return {
    create({ orgId, createdBy, ...rest }) {
      return db.transaction((tx) => {
        const created = tx
          .insert(space)
          .values({ id: ulid(), organizationId: orgId, createdBy, ...rest })
          .returning(columns)
          .get();
        tx.insert(spaceMember)
          .values({ spaceId: created.id, userId: createdBy, role: "owner", source: "direct" })
          .run();
        return created;
      });
    },

    find(id): Space | null {
      return db.select(columns).from(space).where(eq(space.id, id)).get() ?? null;
    },

    listForMember(orgId, userId) {
      return db
        .select({ ...columns, role: spaceMember.role })
        .from(space)
        .innerJoin(
          spaceMember,
          and(eq(spaceMember.spaceId, space.id), eq(spaceMember.userId, userId)),
        )
        .where(eq(space.organizationId, orgId))
        .orderBy(desc(space.primary), asc(space.createdAt), asc(space.id))
        .all();
    },

    roleOf(spaceId, userId) {
      const row = db
        .select({ role: spaceMember.role })
        .from(spaceMember)
        .where(and(eq(spaceMember.spaceId, spaceId), eq(spaceMember.userId, userId)))
        .get();
      return row?.role ?? null;
    },

    rename(id, name) {
      return db
        .update(space)
        .set({ name, updatedAt: new Date() })
        .where(eq(space.id, id))
        .returning(columns)
        .get() as Space;
    },

    delete(id) {
      db.delete(space).where(eq(space.id, id)).run();
    },
  };
}

import { asc, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";

import type { ToolPolicyRecord, ToolPolicyStore } from "./tools.ts";
import { orgToolSetting, spaceToolSetting, toolPolicy } from "./schema.ts";

function recordOf(row: typeof toolPolicy.$inferSelect): ToolPolicyRecord {
  return {
    id: row.id,
    orgId: row.organizationId,
    spaceId: row.spaceId,
    name: row.name,
    color: row.color,
    use: row.use,
    users: row.users,
    approvers: row.approvers,
    independent: row.independent,
    createdAt: row.createdAt,
  };
}

export function createToolPolicyStore(db: Db): ToolPolicyStore {
  return {
    inOrg(orgId) {
      return db
        .select()
        .from(toolPolicy)
        .where(eq(toolPolicy.organizationId, orgId))
        .orderBy(asc(toolPolicy.createdAt), asc(toolPolicy.id))
        .all()
        .map(recordOf);
    },

    find(id) {
      const row = db.select().from(toolPolicy).where(eq(toolPolicy.id, id)).get();
      return row ? recordOf(row) : null;
    },

    create({ orgId, spaceId, ...fields }) {
      const row = db
        .insert(toolPolicy)
        .values({ id: ulid(), organizationId: orgId, spaceId, ...fields })
        .returning()
        .get();
      return recordOf(row);
    },

    update(id, fields) {
      db.update(toolPolicy).set(fields).where(eq(toolPolicy.id, id)).run();
    },

    delete(id) {
      db.transaction(() => {
        db.delete(orgToolSetting).where(eq(orgToolSetting.policyId, id)).run();
        db.delete(spaceToolSetting).where(eq(spaceToolSetting.policyId, id)).run();
        db.delete(toolPolicy).where(eq(toolPolicy.id, id)).run();
      });
    },
  };
}

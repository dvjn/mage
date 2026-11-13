import { asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";

import type { ToolPolicyFields, ToolPolicyRecord, ToolPolicyStore } from "./tools.ts";
import { toolPolicy, toolPolicyMember } from "./schema.ts";

export function createToolPolicyStore(db: Db): ToolPolicyStore {
  // The policies with whom they name.
  function recordsOf(rows: (typeof toolPolicy.$inferSelect)[]): ToolPolicyRecord[] {
    if (rows.length === 0) return [];
    const members = db
      .select()
      .from(toolPolicyMember)
      .where(
        inArray(
          toolPolicyMember.policyId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(toolPolicyMember.position))
      .all();
    const keysOf = (id: string, role: "user" | "approver") =>
      members.filter((one) => one.policyId === id && one.role === role).map((one) => one.key);
    return rows.map(({ organizationId, ...row }) => ({
      ...row,
      orgId: organizationId,
      users: keysOf(row.id, "user"),
      approvers: keysOf(row.id, "approver"),
    }));
  }

  function setMembers(policyId: string, { users, approvers }: ToolPolicyFields) {
    db.delete(toolPolicyMember).where(eq(toolPolicyMember.policyId, policyId)).run();
    const rows = [
      ...users.map((key, position) => ({ policyId, role: "user" as const, key, position })),
      ...approvers.map((key, position) => ({ policyId, role: "approver" as const, key, position })),
    ];
    if (rows.length > 0) db.insert(toolPolicyMember).values(rows).onConflictDoNothing().run();
  }

  return {
    inOrg(orgId) {
      return recordsOf(
        db
          .select()
          .from(toolPolicy)
          .where(eq(toolPolicy.organizationId, orgId))
          .orderBy(asc(toolPolicy.createdAt), asc(toolPolicy.id))
          .all(),
      );
    },

    find(id) {
      const row = db.select().from(toolPolicy).where(eq(toolPolicy.id, id)).get();
      return row ? recordsOf([row])[0]! : null;
    },

    create({ orgId, spaceId, users, approvers, ...fields }) {
      return db.transaction(() => {
        const row = db
          .insert(toolPolicy)
          .values({ id: ulid(), organizationId: orgId, spaceId, ...fields })
          .returning()
          .get();
        setMembers(row.id, { ...fields, users, approvers });
        return recordsOf([row])[0]!;
      });
    },

    update(id, { users, approvers, ...fields }) {
      db.transaction(() => {
        db.update(toolPolicy).set(fields).where(eq(toolPolicy.id, id)).run();
        setMembers(id, { ...fields, users, approvers });
      });
    },

    // Its members and the settings that name it go with it.
    delete(id) {
      db.delete(toolPolicy).where(eq(toolPolicy.id, id)).run();
    },
  };
}

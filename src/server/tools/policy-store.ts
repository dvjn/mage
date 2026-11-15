import { asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";

import type { ToolPolicyFields, ToolPolicyRecord, ToolPolicyStore } from "./registry.ts";
import { toolPolicy, toolPolicyMember } from "./schema.ts";

export function createToolPolicyStore(db: Db): ToolPolicyStore {
  // The policies with whom they name.
  async function recordsOf(rows: (typeof toolPolicy.$inferSelect)[]): Promise<ToolPolicyRecord[]> {
    if (rows.length === 0) return [];
    const members = await db
      .select()
      .from(toolPolicyMember)
      .where(
        inArray(
          toolPolicyMember.policyId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(toolPolicyMember.position));
    const keysOf = (id: string, role: "user" | "approver") =>
      members.filter((one) => one.policyId === id && one.role === role).map((one) => one.key);
    return rows.map(({ organizationId, ...row }) => ({
      ...row,
      orgId: organizationId,
      users: keysOf(row.id, "user"),
      approvers: keysOf(row.id, "approver"),
    }));
  }

  async function setMembers(policyId: string, { users, approvers }: ToolPolicyFields) {
    await db.delete(toolPolicyMember).where(eq(toolPolicyMember.policyId, policyId));
    const rows = [
      ...users.map((key, position) => ({ policyId, role: "user" as const, key, position })),
      ...approvers.map((key, position) => ({ policyId, role: "approver" as const, key, position })),
    ];
    if (rows.length > 0) await db.insert(toolPolicyMember).values(rows).onConflictDoNothing();
  }

  return {
    async inOrg(orgId) {
      return recordsOf(
        await db
          .select()
          .from(toolPolicy)
          .where(eq(toolPolicy.organizationId, orgId))
          .orderBy(asc(toolPolicy.createdAt), asc(toolPolicy.id)),
      );
    },

    async find(id) {
      const row = (await db.select().from(toolPolicy).where(eq(toolPolicy.id, id)).limit(1))[0];
      return row ? (await recordsOf([row]))[0]! : null;
    },

    async create({ orgId, spaceId, users, approvers, ...fields }) {
      return db.transaction(async () => {
        const row = (
          await db
            .insert(toolPolicy)
            .values({ id: ulid(), organizationId: orgId, spaceId, ...fields })
            .returning()
        )[0]!;
        await setMembers(row.id, { ...fields, users, approvers });
        return (await recordsOf([row]))[0]!;
      });
    },

    async update(id, { users, approvers, ...fields }) {
      await db.transaction(async () => {
        await db.update(toolPolicy).set(fields).where(eq(toolPolicy.id, id));
        await setMembers(id, { ...fields, users, approvers });
      });
    },

    // Its members and the settings that name it go with it.
    async delete(id) {
      await db.delete(toolPolicy).where(eq(toolPolicy.id, id));
    },
  };
}

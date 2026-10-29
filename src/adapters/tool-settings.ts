// What orgs and spaces set their tools to, kept in the org_tool_setting and space_tool_setting
// tables, one row per org or space and tool once it sets one: a policy, or off as a row with no
// policy. Their toolset switches are kept beside them.

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { ToolSettingStore } from "@/ports/tools.ts";
import { TOOL_OFF } from "@/shared/tools.ts";

import type { Db } from "./db.ts";
import {
  orgToolSetting,
  orgToolsetSetting,
  space,
  spaceToolSetting,
  spaceToolsetSetting,
} from "./schema.ts";

function assignmentOf(policyId: string | null) {
  return policyId ?? TOOL_OFF;
}

function policyIdOf(assignment: string) {
  return assignment === TOOL_OFF ? null : assignment;
}

export function createToolSettingStore(db: Db): ToolSettingStore {
  return {
    toolsetsInOrg(orgId) {
      const rows = db
        .select()
        .from(orgToolsetSetting)
        .where(eq(orgToolsetSetting.organizationId, orgId))
        .all();
      return new Map(rows.map((row) => [row.toolsetId, row.enabled]));
    },
    setToolsetInOrg(orgId, toolsetId, enabled) {
      db.insert(orgToolsetSetting)
        .values({ organizationId: orgId, toolsetId, enabled })
        .onConflictDoUpdate({
          target: [orgToolsetSetting.organizationId, orgToolsetSetting.toolsetId],
          set: { enabled },
        })
        .run();
    },
    toolsetsInSpace(spaceId) {
      const rows = db
        .select()
        .from(spaceToolsetSetting)
        .where(eq(spaceToolsetSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.toolsetId, row.enabled]));
    },
    setToolsetInSpace(spaceId, toolsetId, enabled) {
      db.insert(spaceToolsetSetting)
        .values({ spaceId, toolsetId, enabled })
        .onConflictDoUpdate({
          target: [spaceToolsetSetting.spaceId, spaceToolsetSetting.toolsetId],
          set: { enabled },
        })
        .run();
    },

    inOrg(orgId) {
      const rows = db
        .select({ toolId: orgToolSetting.toolId, policyId: orgToolSetting.policyId })
        .from(orgToolSetting)
        .where(eq(orgToolSetting.organizationId, orgId))
        .all();
      return new Map(rows.map((row) => [row.toolId, assignmentOf(row.policyId)]));
    },

    setInOrg(orgId, toolIds, assignment) {
      if (toolIds.length === 0) return;
      if (assignment === null) {
        db.delete(orgToolSetting)
          .where(
            and(
              eq(orgToolSetting.organizationId, orgId),
              inArray(orgToolSetting.toolId, [...toolIds]),
            ),
          )
          .run();
        return;
      }
      const policyId = policyIdOf(assignment);
      db.insert(orgToolSetting)
        .values(toolIds.map((toolId) => ({ organizationId: orgId, toolId, policyId })))
        .onConflictDoUpdate({
          target: [orgToolSetting.organizationId, orgToolSetting.toolId],
          set: { policyId },
        })
        .run();
    },

    inSpace(spaceId) {
      const rows = db
        .select({ toolId: spaceToolSetting.toolId, policyId: spaceToolSetting.policyId })
        .from(spaceToolSetting)
        .where(eq(spaceToolSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.toolId, assignmentOf(row.policyId)]));
    },

    setInSpace(spaceId, toolIds, assignment) {
      if (toolIds.length === 0) return;
      if (assignment === null) {
        db.delete(spaceToolSetting)
          .where(
            and(
              eq(spaceToolSetting.spaceId, spaceId),
              inArray(spaceToolSetting.toolId, [...toolIds]),
            ),
          )
          .run();
        return;
      }
      const policyId = policyIdOf(assignment);
      db.insert(spaceToolSetting)
        .values(toolIds.map((toolId) => ({ spaceId, toolId, policyId })))
        .onConflictDoUpdate({
          target: [spaceToolSetting.spaceId, spaceToolSetting.toolId],
          set: { policyId },
        })
        .run();
    },

    policyUses(orgId) {
      const inOrg = db
        .select({ toolId: orgToolSetting.toolId, policyId: orgToolSetting.policyId })
        .from(orgToolSetting)
        .where(and(eq(orgToolSetting.organizationId, orgId), isNotNull(orgToolSetting.policyId)))
        .all()
        .map((row) => ({ spaceId: null, toolId: row.toolId, policyId: row.policyId! }));
      const inSpaces = db
        .select({
          spaceId: spaceToolSetting.spaceId,
          toolId: spaceToolSetting.toolId,
          policyId: spaceToolSetting.policyId,
        })
        .from(spaceToolSetting)
        .innerJoin(space, eq(space.id, spaceToolSetting.spaceId))
        .where(and(eq(space.organizationId, orgId), isNotNull(spaceToolSetting.policyId)))
        .all()
        .map((row) => ({ spaceId: row.spaceId, toolId: row.toolId, policyId: row.policyId! }));
      return [...inOrg, ...inSpaces];
    },
  };
}

// Tool switches and levels kept in the org_tool_setting and space_tool_setting tables, one row per
// org or space and tool once it sets anything.

import { and, eq } from "drizzle-orm";

import type { ToolSettingStore } from "@/ports/tools.ts";

import type { Db } from "./db.ts";
import { orgToolSetting, spaceToolSetting } from "./schema.ts";

export function createToolSettingStore(db: Db): ToolSettingStore {
  return {
    offInOrg(orgId) {
      const rows = db
        .select({ toolId: orgToolSetting.toolId })
        .from(orgToolSetting)
        .where(and(eq(orgToolSetting.organizationId, orgId), eq(orgToolSetting.enabled, false)))
        .all();
      return new Set(rows.map((row) => row.toolId));
    },

    setInOrg(orgId, toolId, enabled) {
      db.insert(orgToolSetting)
        .values({ organizationId: orgId, toolId, enabled })
        .onConflictDoUpdate({
          target: [orgToolSetting.organizationId, orgToolSetting.toolId],
          set: { enabled },
        })
        .run();
    },

    inSpace(spaceId) {
      const rows = db
        .select({
          toolId: spaceToolSetting.toolId,
          enabled: spaceToolSetting.enabled,
          messager: spaceToolSetting.messagerLevel,
          guest: spaceToolSetting.guestLevel,
        })
        .from(spaceToolSetting)
        .where(eq(spaceToolSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.toolId, row]));
    },

    setInSpace(spaceId, toolId, changes) {
      const set = {
        ...(changes.enabled !== undefined && { enabled: changes.enabled }),
        ...(changes.messager !== undefined && { messagerLevel: changes.messager }),
        ...(changes.guest !== undefined && { guestLevel: changes.guest }),
      };
      if (Object.keys(set).length === 0) return;
      db.insert(spaceToolSetting)
        .values({ spaceId, toolId, ...set })
        .onConflictDoUpdate({
          target: [spaceToolSetting.spaceId, spaceToolSetting.toolId],
          set,
        })
        .run();
    },
  };
}

// Tool modes kept in the org_tool_setting and space_tool_setting tables, one row per org or space
// and tool once it sets one.

import { eq } from "drizzle-orm";

import type { ToolSettingStore } from "@/ports/tools.ts";

import type { Db } from "./db.ts";
import { orgToolSetting, spaceToolSetting } from "./schema.ts";

export function createToolSettingStore(db: Db): ToolSettingStore {
  return {
    inOrg(orgId) {
      const rows = db
        .select({ toolId: orgToolSetting.toolId, mode: orgToolSetting.mode })
        .from(orgToolSetting)
        .where(eq(orgToolSetting.organizationId, orgId))
        .all();
      return new Map(rows.map((row) => [row.toolId, row.mode]));
    },

    setInOrg(orgId, toolIds, mode) {
      if (toolIds.length === 0) return;
      db.insert(orgToolSetting)
        .values(toolIds.map((toolId) => ({ organizationId: orgId, toolId, mode })))
        .onConflictDoUpdate({
          target: [orgToolSetting.organizationId, orgToolSetting.toolId],
          set: { mode },
        })
        .run();
    },

    inSpace(spaceId) {
      const rows = db
        .select({ toolId: spaceToolSetting.toolId, mode: spaceToolSetting.mode })
        .from(spaceToolSetting)
        .where(eq(spaceToolSetting.spaceId, spaceId))
        .all();
      return new Map(rows.map((row) => [row.toolId, row.mode]));
    },

    setInSpace(spaceId, toolIds, mode) {
      if (toolIds.length === 0) return;
      db.insert(spaceToolSetting)
        .values(toolIds.map((toolId) => ({ spaceId, toolId, mode })))
        .onConflictDoUpdate({
          target: [spaceToolSetting.spaceId, spaceToolSetting.toolId],
          set: { mode },
        })
        .run();
    },
  };
}

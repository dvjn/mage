import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { TOOL_OFF } from "@/shared/tools.ts";
import type { Db } from "@/server/db/db.ts";
import { type SettingScope, scopedOn } from "@/server/spaces/scope.ts";

import type { ToolSettingStore } from "./tools.ts";
import { toolSetting, toolsetOption, toolsetSetting } from "./schema.ts";

function assignmentOf(policyId: string | null) {
  return policyId ?? TOOL_OFF;
}

function policyIdOf(assignment: string) {
  return assignment === TOOL_OFF ? null : assignment;
}

const tools = scopedOn(toolSetting);
const toolsets = scopedOn(toolsetSetting);
const options = scopedOn(toolsetOption);

export function createToolSettingStore(db: Db): ToolSettingStore {
  async function toolsetsIn(scope: SettingScope) {
    const rows = await db.select().from(toolsetSetting).where(toolsets.at(scope));
    return new Map(rows.map((row) => [row.toolsetId, row.enabled]));
  }

  async function setToolsetIn(scope: SettingScope, toolsetId: string, enabled: boolean) {
    await db
      .insert(toolsetSetting)
      .values({ ...toolsets.of(scope), toolsetId, enabled })
      .onConflictDoUpdate({
        ...toolsets.conflict(scope, toolsetSetting.toolsetId),
        set: { enabled },
      });
  }

  // Options by toolset, then option.
  async function optionsIn(scope: SettingScope) {
    const found = new Map<string, Map<string, boolean>>();
    for (const row of await db.select().from(toolsetOption).where(options.at(scope))) {
      const set = found.get(row.toolsetId) ?? new Map<string, boolean>();
      set.set(row.option, row.enabled);
      found.set(row.toolsetId, set);
    }
    return found;
  }

  async function setOptionIn(
    scope: SettingScope,
    toolsetId: string,
    option: string,
    enabled: boolean,
  ) {
    await db
      .insert(toolsetOption)
      .values({ ...options.of(scope), toolsetId, option, enabled })
      .onConflictDoUpdate({
        ...options.conflict(scope, toolsetOption.toolsetId, toolsetOption.option),
        set: { enabled },
      });
  }

  async function toolsIn(scope: SettingScope) {
    const rows = await db
      .select({ toolId: toolSetting.toolId, policyId: toolSetting.policyId })
      .from(toolSetting)
      .where(tools.at(scope));
    return new Map(rows.map((row) => [row.toolId, assignmentOf(row.policyId)]));
  }

  async function setToolsIn(
    scope: SettingScope,
    toolIds: readonly string[],
    assignment: string | null,
  ) {
    if (toolIds.length === 0) return;
    if (assignment === null) {
      await db
        .delete(toolSetting)
        .where(and(tools.at(scope), inArray(toolSetting.toolId, [...toolIds])));
      return;
    }
    const policyId = policyIdOf(assignment);
    await db
      .insert(toolSetting)
      .values(toolIds.map((toolId) => ({ ...tools.of(scope), toolId, policyId })))
      .onConflictDoUpdate({ ...tools.conflict(scope, toolSetting.toolId), set: { policyId } });
  }

  return {
    toolsetsInOrg: async (orgId) => toolsetsIn({ orgId }),
    setToolsetInOrg: async (orgId, ...setting) => setToolsetIn({ orgId }, ...setting),
    toolsetsInSpace: async (spaceId) => toolsetsIn({ spaceId }),
    setToolsetInSpace: async (spaceId, ...setting) => setToolsetIn({ spaceId }, ...setting),

    optionsInOrg: async (orgId) => optionsIn({ orgId }),
    setOptionInOrg: async (orgId, ...setting) => setOptionIn({ orgId }, ...setting),
    optionsInSpace: async (spaceId) => optionsIn({ spaceId }),
    setOptionInSpace: async (spaceId, ...setting) => setOptionIn({ spaceId }, ...setting),

    inOrg: async (orgId) => toolsIn({ orgId }),
    setInOrg: async (orgId, ...setting) => setToolsIn({ orgId }, ...setting),
    inSpace: async (spaceId) => toolsIn({ spaceId }),
    setInSpace: async (spaceId, ...setting) => setToolsIn({ spaceId }, ...setting),

    async policyUses(orgId) {
      return (
        await db
          .select({
            spaceId: toolSetting.spaceId,
            toolId: toolSetting.toolId,
            policyId: toolSetting.policyId,
          })
          .from(toolSetting)
          .where(and(eq(toolSetting.organizationId, orgId), isNotNull(toolSetting.policyId)))
      ).map((row) => ({ ...row, policyId: row.policyId! }));
    },
  };
}

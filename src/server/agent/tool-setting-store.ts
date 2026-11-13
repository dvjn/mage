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
  function toolsetsIn(scope: SettingScope) {
    const rows = db.select().from(toolsetSetting).where(toolsets.at(scope)).all();
    return new Map(rows.map((row) => [row.toolsetId, row.enabled]));
  }

  function setToolsetIn(scope: SettingScope, toolsetId: string, enabled: boolean) {
    db.insert(toolsetSetting)
      .values({ ...toolsets.of(scope), toolsetId, enabled })
      .onConflictDoUpdate({
        ...toolsets.conflict(scope, toolsetSetting.toolsetId),
        set: { enabled },
      })
      .run();
  }

  // Options by toolset, then option.
  function optionsIn(scope: SettingScope) {
    const found = new Map<string, Map<string, boolean>>();
    for (const row of db.select().from(toolsetOption).where(options.at(scope)).all()) {
      const set = found.get(row.toolsetId) ?? new Map<string, boolean>();
      set.set(row.option, row.enabled);
      found.set(row.toolsetId, set);
    }
    return found;
  }

  function setOptionIn(scope: SettingScope, toolsetId: string, option: string, enabled: boolean) {
    db.insert(toolsetOption)
      .values({ ...options.of(scope), toolsetId, option, enabled })
      .onConflictDoUpdate({
        ...options.conflict(scope, toolsetOption.toolsetId, toolsetOption.option),
        set: { enabled },
      })
      .run();
  }

  function toolsIn(scope: SettingScope) {
    const rows = db
      .select({ toolId: toolSetting.toolId, policyId: toolSetting.policyId })
      .from(toolSetting)
      .where(tools.at(scope))
      .all();
    return new Map(rows.map((row) => [row.toolId, assignmentOf(row.policyId)]));
  }

  function setToolsIn(scope: SettingScope, toolIds: readonly string[], assignment: string | null) {
    if (toolIds.length === 0) return;
    if (assignment === null) {
      db.delete(toolSetting)
        .where(and(tools.at(scope), inArray(toolSetting.toolId, [...toolIds])))
        .run();
      return;
    }
    const policyId = policyIdOf(assignment);
    db.insert(toolSetting)
      .values(toolIds.map((toolId) => ({ ...tools.of(scope), toolId, policyId })))
      .onConflictDoUpdate({ ...tools.conflict(scope, toolSetting.toolId), set: { policyId } })
      .run();
  }

  return {
    toolsetsInOrg: (orgId) => toolsetsIn({ orgId }),
    setToolsetInOrg: (orgId, ...setting) => setToolsetIn({ orgId }, ...setting),
    toolsetsInSpace: (spaceId) => toolsetsIn({ spaceId }),
    setToolsetInSpace: (spaceId, ...setting) => setToolsetIn({ spaceId }, ...setting),

    optionsInOrg: (orgId) => optionsIn({ orgId }),
    setOptionInOrg: (orgId, ...setting) => setOptionIn({ orgId }, ...setting),
    optionsInSpace: (spaceId) => optionsIn({ spaceId }),
    setOptionInSpace: (spaceId, ...setting) => setOptionIn({ spaceId }, ...setting),

    inOrg: (orgId) => toolsIn({ orgId }),
    setInOrg: (orgId, ...setting) => setToolsIn({ orgId }, ...setting),
    inSpace: (spaceId) => toolsIn({ spaceId }),
    setInSpace: (spaceId, ...setting) => setToolsIn({ spaceId }, ...setting),

    policyUses(orgId) {
      return db
        .select({
          spaceId: toolSetting.spaceId,
          toolId: toolSetting.toolId,
          policyId: toolSetting.policyId,
        })
        .from(toolSetting)
        .where(and(eq(toolSetting.organizationId, orgId), isNotNull(toolSetting.policyId)))
        .all()
        .map((row) => ({ ...row, policyId: row.policyId! }));
    },
  };
}

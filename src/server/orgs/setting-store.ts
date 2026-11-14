// An org has a row once it sets anything.

import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { OrgSettings, OrgSettingStore } from "./service.ts";
import { orgSetting } from "./schema.ts";

export function createOrgSettingStore(db: Db): OrgSettingStore {
  async function set(orgId: string, changes: Partial<OrgSettings>) {
    await db
      .insert(orgSetting)
      .values({ organizationId: orgId, ...changes })
      .onConflictDoUpdate({
        target: orgSetting.organizationId,
        set: { ...changes, updatedAt: new Date() },
      });
  }

  return {
    async get(orgId) {
      const row = (
        await db
          .select({
            defaultModel: orgSetting.defaultModel,
            titleModel: orgSetting.titleModel,
            defaultEffort: orgSetting.defaultEffort,
            spaceCreation: orgSetting.spaceCreation,
            memberSpaces: orgSetting.memberSpaces,
            spaceMcpServers: orgSetting.spaceMcpServers,
            spaceSkills: orgSetting.spaceSkills,
            agentName: orgSetting.agentName,
          })
          .from(orgSetting)
          .where(eq(orgSetting.organizationId, orgId))
          .limit(1)
      )[0];
      return {
        defaultModel: row?.defaultModel ?? null,
        titleModel: row?.titleModel ?? null,
        defaultEffort: row?.defaultEffort ?? null,
        spaceCreation: row?.spaceCreation ?? "members",
        memberSpaces: row?.memberSpaces ?? false,
        spaceMcpServers: row?.spaceMcpServers ?? true,
        spaceSkills: row?.spaceSkills ?? true,
        agentName: row?.agentName ?? null,
      };
    },

    async setDefaultModel(orgId, ref) {
      await set(orgId, { defaultModel: ref });
    },

    async setTitleModel(orgId, ref) {
      await set(orgId, { titleModel: ref });
    },

    async setDefaultEffort(orgId, effort) {
      await set(orgId, { defaultEffort: effort });
    },

    async setTeamSettings(orgId, changes) {
      await set(orgId, changes);
    },

    async setSpaceMcpServers(orgId, allowed) {
      await set(orgId, { spaceMcpServers: allowed });
    },

    async setSpaceSkills(orgId, allowed) {
      await set(orgId, { spaceSkills: allowed });
    },

    async setAgentName(orgId, name) {
      await set(orgId, { agentName: name });
    },
  };
}

// An org has a row once it sets anything.

import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { OrgSettings, OrgSettingStore } from "./service.ts";
import { orgSetting } from "./schema.ts";

export function createOrgSettingStore(db: Db): OrgSettingStore {
  function set(orgId: string, changes: Partial<OrgSettings>) {
    db.insert(orgSetting)
      .values({ organizationId: orgId, ...changes })
      .onConflictDoUpdate({
        target: orgSetting.organizationId,
        set: { ...changes, updatedAt: new Date() },
      })
      .run();
  }

  return {
    get(orgId) {
      const row = db
        .select({
          defaultModel: orgSetting.defaultModel,
          titleModel: orgSetting.titleModel,
          defaultEffort: orgSetting.defaultEffort,
          spaceCreation: orgSetting.spaceCreation,
          memberSpaces: orgSetting.memberSpaces,
          spaceMcpServers: orgSetting.spaceMcpServers,
          spaceSkills: orgSetting.spaceSkills,
        })
        .from(orgSetting)
        .where(eq(orgSetting.organizationId, orgId))
        .get();
      return {
        defaultModel: row?.defaultModel ?? null,
        titleModel: row?.titleModel ?? null,
        defaultEffort: row?.defaultEffort ?? null,
        spaceCreation: row?.spaceCreation ?? "members",
        memberSpaces: row?.memberSpaces ?? true,
        spaceMcpServers: row?.spaceMcpServers ?? true,
        spaceSkills: row?.spaceSkills ?? true,
      };
    },

    setDefaultModel(orgId, ref) {
      set(orgId, { defaultModel: ref });
    },

    setTitleModel(orgId, ref) {
      set(orgId, { titleModel: ref });
    },

    setDefaultEffort(orgId, effort) {
      set(orgId, { defaultEffort: effort });
    },

    setTeamSettings(orgId, changes) {
      set(orgId, changes);
    },

    setSpaceMcpServers(orgId, allowed) {
      set(orgId, { spaceMcpServers: allowed });
    },

    setSpaceSkills(orgId, allowed) {
      set(orgId, { spaceSkills: allowed });
    },
  };
}

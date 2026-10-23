// Org settings kept in the org_setting table, one row per org once it sets anything.

import { eq } from "drizzle-orm";

import type { OrgSettings, OrgSettingStore } from "@/ports/org-settings.ts";

import type { Db } from "./db.ts";
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
        })
        .from(orgSetting)
        .where(eq(orgSetting.organizationId, orgId))
        .get();
      return {
        defaultModel: row?.defaultModel ?? null,
        titleModel: row?.titleModel ?? null,
        defaultEffort: row?.defaultEffort ?? null,
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
  };
}

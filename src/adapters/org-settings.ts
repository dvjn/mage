// Org settings kept in the org_setting table, one row per org once it sets anything.

import { eq } from "drizzle-orm";

import type { OrgSettingStore } from "@/ports/org-settings.ts";

import type { Db } from "./db.ts";
import { orgSetting } from "./schema.ts";

export function createOrgSettingStore(db: Db): OrgSettingStore {
  return {
    get(orgId) {
      const row = db
        .select({ defaultModel: orgSetting.defaultModel })
        .from(orgSetting)
        .where(eq(orgSetting.organizationId, orgId))
        .get();
      return { defaultModel: row?.defaultModel ?? null };
    },

    setDefaultModel(orgId, ref) {
      db.insert(orgSetting)
        .values({ organizationId: orgId, defaultModel: ref })
        .onConflictDoUpdate({
          target: orgSetting.organizationId,
          set: { defaultModel: ref, updatedAt: new Date() },
        })
        .run();
    },
  };
}

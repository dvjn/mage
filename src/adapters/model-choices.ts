// Model choices kept in the connection_model table, one row per connection and model.

import { eq } from "drizzle-orm";

import type { ModelChoice, ModelChoiceStore } from "@/ports/model-choices.ts";

import type { Db } from "./db.ts";
import { connectionModel } from "./schema.ts";

export function createModelChoiceStore(db: Db): ModelChoiceStore {
  return {
    sync(connectionId, modelIds, enableNew, now) {
      if (modelIds.length > 0) {
        db.insert(connectionModel)
          .values(
            modelIds.map((modelId) => ({
              connectionId,
              modelId,
              enabled: enableNew,
              firstSeenAt: now,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      const rows = db
        .select({
          modelId: connectionModel.modelId,
          enabled: connectionModel.enabled,
          firstSeenAt: connectionModel.firstSeenAt,
        })
        .from(connectionModel)
        .where(eq(connectionModel.connectionId, connectionId))
        .all();
      return new Map<string, ModelChoice>(rows.map(({ modelId, ...choice }) => [modelId, choice]));
    },

    set(connectionId, modelIds, enabled, now) {
      if (modelIds.length === 0) return;
      db.insert(connectionModel)
        .values(modelIds.map((modelId) => ({ connectionId, modelId, enabled, firstSeenAt: now })))
        .onConflictDoUpdate({
          target: [connectionModel.connectionId, connectionModel.modelId],
          set: { enabled },
        })
        .run();
    },
  };
}

import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import type { InstructionStore } from "./service.ts";
import { instruction } from "./schema.ts";

export function createInstructionStore(db: Db): InstructionStore {
  return {
    async get(orgId, spaceId) {
      const row = (
        await db
          .select({ text: instruction.text, updatedAt: instruction.updatedAt })
          .from(instruction)
          .where(eq(instruction.scopeId, spaceId ?? orgId))
          .limit(1)
      )[0];
      return row ?? null;
    },

    async set(orgId, spaceId, text, userId) {
      await db
        .insert(instruction)
        .values({
          scopeId: spaceId ?? orgId,
          organizationId: orgId,
          spaceId,
          text,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: instruction.scopeId,
          set: { text, updatedBy: userId, updatedAt: new Date() },
        });
    },
  };
}

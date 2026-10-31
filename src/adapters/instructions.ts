// Agent instructions kept in the instruction table by the org's or the space's id.

import { eq } from "drizzle-orm";

import type { InstructionStore } from "@/ports/instructions.ts";

import type { Db } from "./db.ts";
import { instruction } from "./schema.ts";

export function createInstructionStore(db: Db): InstructionStore {
  return {
    get(orgId, spaceId) {
      const row = db
        .select({ text: instruction.text, updatedAt: instruction.updatedAt })
        .from(instruction)
        .where(eq(instruction.scopeId, spaceId ?? orgId))
        .get();
      return row ?? null;
    },

    set(orgId, spaceId, text, userId) {
      db.insert(instruction)
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
        })
        .run();
    },
  };
}

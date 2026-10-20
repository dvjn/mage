// Pending browser sign-ins kept in the sign_in_attempt table.

import { and, eq, lte } from "drizzle-orm";

import type { SignInAttemptStore } from "@/ports/sign-in-attempts.ts";

import type { Db } from "./db.ts";
import { signInAttempt } from "./schema.ts";

export function createSignInAttemptStore(db: Db): SignInAttemptStore {
  return {
    create({ orgId, ...attempt }) {
      db.insert(signInAttempt)
        .values({ ...attempt, organizationId: orgId })
        .run();
    },

    take({ kind, state, orgId, userId }) {
      const row = db
        .delete(signInAttempt)
        .where(
          and(
            eq(signInAttempt.kind, kind),
            eq(signInAttempt.state, state),
            eq(signInAttempt.organizationId, orgId),
            eq(signInAttempt.userId, userId),
          ),
        )
        .returning()
        .get();
      if (!row) return null;
      const { organizationId, ...attempt } = row;
      return { ...attempt, orgId: organizationId };
    },

    deleteExpired(now) {
      db.delete(signInAttempt).where(lte(signInAttempt.expiresAt, now)).run();
    },
  };
}

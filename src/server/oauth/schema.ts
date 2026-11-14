// Sign-ins under way with an OAuth provider, for an MCP server or a model provider: one row per
// attempt, by the state the provider sends back, until it completes, fails or runs out of time.

import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { at, bytes, NOW } from "@/server/db/columns.ts";
import { leaseColumns } from "@/server/sync/lease.ts";
import { machine } from "@/server/sync/machine.ts";

export const ATTEMPT_STATES = ["pending", "completed", "failed", "expired"] as const;

export const attemptMachine = machine({
  states: ATTEMPT_STATES,
  transitions: {
    complete: { from: ["pending"], to: "completed" },
    fail: { from: ["pending"], to: "failed" },
    expire: { from: ["pending"], to: "expired" },
  },
});

export const oauthAttempt = pgTable(
  "oauth_attempt",
  {
    state: text("state").primaryKey(),
    kind: text("kind", { enum: ["mcp", "model"] }).notNull(),
    // Where the person goes back with a code: a redirect to the server, a code they paste, or a
    // device code the server asks about until it is approved.
    flow: text("flow", { enum: ["redirect", "code", "device"] }).notNull(),
    // The server or provider signed in to, and whose secrets the sign-in fills.
    subjectId: text("subject_id").notNull(),
    holder: text("holder").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // What finishing needs, sealed: a verifier, a device code, where to go back to.
    sealed: bytes("sealed").notNull(),
    keyVersion: integer("key_version").notNull(),
    status: text("status", { enum: ATTEMPT_STATES }).notNull(),
    // What it made once completed, or why it failed.
    resultId: text("result_id"),
    error: text("error"),
    // For a device sign-in, when the provider is asked next, and the instance asking.
    nextPollAt: at("next_poll_at"),
    ...leaseColumns(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    index("oauth_attempt_due_idx")
      .on(table.nextPollAt)
      .where(sql`${table.status} = 'pending' and ${table.flow} = 'device'`),
    attemptMachine.check("oauth_attempt_status_check", table.status),
  ],
);

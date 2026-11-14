// The one owner of sign-ins under way with OAuth providers, for MCP servers and model providers
// alike, kept in the database so a sign-in begun through one instance finishes through any. What
// an attempt needs to finish is sealed. Each change is one guarded statement: finishing moves it
// from pending once, before the provider is asked, so a callback handled twice exchanges once. A
// device sign-in is asked about by whichever instance holds its lease for one ask; the ask itself
// happens outside any transaction, and what follows is written under the lease's fence.

import { and, eq, lte, type SQL, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import { type Lease, leasesOn } from "@/server/sync/lease.ts";

import { attemptMachine, oauthAttempt } from "./schema.ts";

type Row = typeof oauthAttempt.$inferSelect;

export type Flow = Row["flow"];

// An attempt with its secrets opened. Whether it is past its time is the caller's to say, by its
// own clock.
export interface Attempt<Secrets = unknown> {
  state: string;
  kind: Row["kind"];
  flow: Flow;
  subjectId: string;
  holder: string;
  orgId: string;
  userId: string;
  secrets: Secrets;
  status: Row["status"];
  resultId: string | null;
  error: string | null;
  nextPollAt: Date | null;
  expiresAt: Date;
  leaseEpoch: number;
}

// How long an attempt past its time is kept, for its status to be read, before a new one deletes it.
const KEEP_MS = 10 * 60_000;

export type OAuthAttempts = ReturnType<typeof createOAuthAttempts>;

export function createOAuthAttempts(options: { db: Db; cipher: Cipher }) {
  const { db, cipher } = options;
  const leases = leasesOn(oauthAttempt);
  // What the sealed secrets are bound to: the attempt.
  const context = (state: string) => `oauth_attempt:${state}`;

  function opened<Secrets>(row: Row): Attempt<Secrets> {
    const secrets = JSON.parse(
      cipher.open({ keyVersion: row.keyVersion, data: row.sealed }, context(row.state)).toString(),
    ) as Secrets;
    return {
      state: row.state,
      kind: row.kind,
      flow: row.flow,
      subjectId: row.subjectId,
      holder: row.holder,
      orgId: row.orgId,
      userId: row.userId,
      secrets,
      status: row.status,
      resultId: row.resultId,
      error: row.error,
      nextPollAt: row.nextPollAt,
      expiresAt: row.expiresAt,
      leaseEpoch: row.leaseEpoch,
    };
  }

  function sealed(state: string, secrets: unknown) {
    const { keyVersion, data } = cipher.seal(Buffer.from(JSON.stringify(secrets)), context(state));
    return { keyVersion, sealed: data };
  }

  async function move(state: string, event: "complete" | "fail", fields: Partial<Row>, also?: SQL) {
    const [row] = await db
      .update(oauthAttempt)
      .set({ ...attemptMachine.to(event), ...fields })
      .where(
        and(eq(oauthAttempt.state, state), attemptMachine.from(event, oauthAttempt.status), also),
      )
      .returning();
    return row ? opened(row) : null;
  }

  return {
    // Keeps the attempt, first deleting those long past their time.
    async begin(a: {
      state: string;
      kind: Row["kind"];
      flow: Flow;
      subjectId: string;
      holder: string;
      orgId: string;
      userId: string;
      secrets: unknown;
      expiresAt: Date;
      nextPollAt?: Date;
      // The caller's clock, by which attempts long past their time are deleted.
      now: Date;
    }) {
      await db
        .delete(oauthAttempt)
        .where(sql`${oauthAttempt.expiresAt} < ${new Date(a.now.getTime() - KEEP_MS)}`);
      const { secrets, nextPollAt, now: _now, ...rest } = a;
      await db.insert(oauthAttempt).values({
        ...rest,
        ...sealed(a.state, secrets),
        status: "pending",
        nextPollAt: nextPollAt ?? null,
      });
    },

    async find<Secrets = unknown>(state: string): Promise<Attempt<Secrets> | null> {
      const [row] = await db
        .select()
        .from(oauthAttempt)
        .where(eq(oauthAttempt.state, state))
        .limit(1);
      return row ? opened<Secrets>(row) : null;
    },

    // The person's attempts still pending of the kind and subject, newest first.
    async pendingOf(kind: Row["kind"], subjectId: string, orgId: string, userId: string) {
      const rows = await db
        .select()
        .from(oauthAttempt)
        .where(
          and(
            eq(oauthAttempt.kind, kind),
            eq(oauthAttempt.subjectId, subjectId),
            eq(oauthAttempt.orgId, orgId),
            eq(oauthAttempt.userId, userId),
            eq(oauthAttempt.status, "pending"),
          ),
        );
      return rows.map((row) => opened(row));
    },

    // Finished, before the provider is asked; null when it was no longer pending or ran out.
    complete: async (state: string, resultId?: string) =>
      move(state, "complete", { ...(resultId && { resultId }) }),

    fail: async (state: string, error: string) => move(state, "fail", { error }, undefined),

    // A device sign-in under its lease: completed with what it made, or failed.
    completeHeld: async (lease: Lease & { state: string }, resultId: string) =>
      move(lease.state, "complete", { resultId }, leases.held(lease)),
    // Failed, or with `expired` run out of time, under its lease.
    failHeld: async (lease: Lease & { state: string }, error: string, expired = false) =>
      db
        .update(oauthAttempt)
        .set({ ...attemptMachine.to(expired ? "expire" : "fail"), error })
        .where(
          and(
            eq(oauthAttempt.state, lease.state),
            attemptMachine.from(expired ? "expire" : "fail", oauthAttempt.status),
            leases.held(lease),
          ),
        )
        .returning()
        .then((rows) => rows.length > 0),

    // The device sign-ins whose next ask has come and that nobody is asking about now.
    async due(now: Date, limit: number) {
      const rows = await db
        .select({ state: oauthAttempt.state })
        .from(oauthAttempt)
        .where(
          and(
            eq(oauthAttempt.status, "pending"),
            eq(oauthAttempt.flow, "device"),
            lte(oauthAttempt.nextPollAt, now),
            leases.expired(),
          ),
        )
        .limit(limit);
      return rows.map((row) => row.state);
    },

    // Takes the device sign-in for one ask, if its ask has come and nobody holds it.
    async hold(state: string, now: Date, owner: string, ms: number) {
      const [row] = await db
        .update(oauthAttempt)
        .set(leases.take(owner, ms))
        .where(
          and(
            eq(oauthAttempt.state, state),
            eq(oauthAttempt.status, "pending"),
            lte(oauthAttempt.nextPollAt, now),
            leases.expired(),
          ),
        )
        .returning();
      if (!row) return null;
      const attempt = opened(row);
      return { attempt, lease: { state, owner, epoch: row.leaseEpoch } };
    },

    // Asked and still pending: asked again at `next`, with the secrets as they stand now, and let
    // go; false when the lease no longer held.
    async polled(lease: Lease & { state: string }, next: Date, secrets?: unknown) {
      const rows = await db
        .update(oauthAttempt)
        .set({
          nextPollAt: next,
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(secrets !== undefined && sealed(lease.state, secrets)),
        })
        .where(and(eq(oauthAttempt.state, lease.state), leases.held(lease)))
        .returning({ state: oauthAttempt.state });
      return rows.length > 0;
    },
  };
}

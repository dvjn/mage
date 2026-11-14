// Rows of webhooks. Each change of where one stands is one guarded statement through the webhook
// machine, answering the row it moved or nothing when it had moved already. A signing secret is
// sealed to its webhook and never leaves the server.

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import { user } from "@/server/orgs/schema.ts";

import { webhook, webhookMachine } from "./schema.ts";

export type WebhookRow = typeof webhook.$inferSelect;
export type NewWebhook = Omit<
  WebhookRow,
  "status" | "secret" | "secretKeyVersion" | "deliveryHeader" | "lastReceivedAt" | "createdAt"
>;

// What a sealed signing secret is bound to, its webhook: kept as it is, or no stored secret opens.
const secretContext = (id: string) => `thread_trigger.secret:${id}`;

export type WebhookStore = ReturnType<typeof createWebhookStore>;

export function createWebhookStore(db: Db, cipher: Cipher) {
  async function move(id: string, event: Parameters<typeof webhookMachine.to>[0]) {
    return (
      (
        await db
          .update(webhook)
          .set(webhookMachine.to(event))
          .where(and(eq(webhook.id, id), webhookMachine.from(event, webhook.status)))
          .returning()
      )[0] ?? null
    );
  }

  return {
    async create(row: NewWebhook) {
      return (
        await db
          .insert(webhook)
          .values({ ...row, status: "active" })
          .returning()
      )[0]!;
    },

    async find(id: string) {
      return (await db.select().from(webhook).where(eq(webhook.id, id)).limit(1))[0] ?? null;
    },

    // Where it stands, its row held until the transaction ends, so a pause or a delete waits for a
    // delivery under way, and a delivery for one that committed first.
    async statusHeld(id: string) {
      const [row] = await db
        .select({ status: webhook.status })
        .from(webhook)
        .where(eq(webhook.id, id))
        .for("update");
      return row?.status ?? null;
    },

    async findByToken(token: string) {
      return (await db.select().from(webhook).where(eq(webhook.token, token)).limit(1))[0] ?? null;
    },

    // The thread's that are active or paused, oldest first.
    async inThread(threadId: string) {
      return await db
        .select()
        .from(webhook)
        .where(and(eq(webhook.threadId, threadId), inArray(webhook.status, ["active", "paused"])))
        .orderBy(asc(webhook.createdAt), asc(webhook.id));
    },

    // The thread's that the calls made, whatever they stand at.
    async ofCalls(threadId: string, callIds: readonly string[]) {
      if (callIds.length === 0) return [];
      return await db
        .select()
        .from(webhook)
        .where(and(eq(webhook.threadId, threadId), inArray(webhook.callId, [...callIds])));
    },

    pause: async (id: string) => move(id, "pause"),
    resume: async (id: string) => move(id, "resume"),
    remove: async (id: string) => move(id, "remove"),

    // Notes a post taken while it listens.
    async received(id: string, at: Date) {
      await db
        .update(webhook)
        .set({ lastReceivedAt: at })
        .where(and(eq(webhook.id, id), eq(webhook.status, "active")));
    },

    // Sets its signing secret, sealed, or clears it.
    async setSecret(id: string, secret: string | null) {
      const sealed = secret ? cipher.seal(Buffer.from(secret), secretContext(id)) : null;
      await db
        .update(webhook)
        .set({ secretKeyVersion: sealed?.keyVersion ?? null, secret: sealed?.data ?? null })
        .where(eq(webhook.id, id));
    },

    // Names the header its sender gives a delivery's id in, or with null goes back to the usual
    // ones.
    async setDeliveryHeader(id: string, header: string | null) {
      await db.update(webhook).set({ deliveryHeader: header }).where(eq(webhook.id, id));
    },

    // Its signing secret, opened.
    openSecret(row: WebhookRow) {
      if (!row.secret || row.secretKeyVersion === null) return null;
      return cipher
        .open({ keyVersion: row.secretKeyVersion, data: row.secret }, secretContext(row.id))
        .toString();
    },

    async userName(userId: string) {
      return (
        (await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0]
          ?.name ?? null
      );
    },
  };
}

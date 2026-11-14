// Webhooks a thread's agent made: the address outside services post to, its signing secret, where
// it stands, and whose words it carries to the agent with each post.

import { sql } from "drizzle-orm";
import { index, integer, json, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { at, bytes, NOW } from "@/server/db/columns.ts";
import { machine } from "@/server/sync/machine.ts";
import { thread } from "@/server/threads/schema.ts";
import type { Steering } from "@/shared/threads/events.ts";

export const WEBHOOK_STATES = ["active", "paused", "deleted"] as const;

export type WebhookStatus = (typeof WEBHOOK_STATES)[number];

export const webhookMachine = machine({
  states: WEBHOOK_STATES,
  transitions: {
    pause: { from: ["active"], to: "paused" },
    resume: { from: ["paused"], to: "active" },
    remove: { from: ["active", "paused"], to: "deleted" },
  },
});

export const webhook = pgTable(
  "webhook",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // The call that made it.
    callId: text("call_id"),
    name: text("name").notNull(),
    // The note the agent is told with each post.
    prompt: text("prompt").notNull(),
    // Whose words the model had read when it made it.
    influence: json("influence").$type<Steering[]>().notNull(),
    status: text("status", { enum: WEBHOOK_STATES }).notNull(),
    // The unguessable address token, and the signing secret sealed by the cipher, when a person set
    // one.
    token: text("token").notNull(),
    secret: bytes("secret"),
    secretKeyVersion: integer("secret_key_version"),
    // The header its sender gives a delivery's id in, where a person named one.
    deliveryHeader: text("delivery_header"),
    lastReceivedAt: at("last_received_at"),
    createdAt: at("created_at").default(NOW).notNull(),
  },
  (table) => [
    uniqueIndex("webhook_token_idx").on(table.token),
    uniqueIndex("webhook_call_idx")
      .on(table.threadId, table.callId)
      .where(sql`${table.callId} is not null`),
    index("webhook_thread_idx").on(table.threadId, table.createdAt),
    webhookMachine.check("webhook_status_check", table.status),
  ],
);

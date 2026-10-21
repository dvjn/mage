// Reply pieces kept in the message_delta table, one row per piece.

import { asc, eq } from "drizzle-orm";

import type { DeltaStore } from "@/ports/deltas.ts";
import type { DeltaBatch } from "@/shared/threads.ts";

import type { Db } from "./db.ts";
import { messageDelta } from "./schema.ts";

export function createDeltaStore(db: Db): DeltaStore {
  return {
    append(threadId, { messageId, index, texts }) {
      if (texts.length === 0) return;
      db.insert(messageDelta)
        .values(texts.map((text, offset) => ({ threadId, messageId, index: index + offset, text })))
        .run();
    },

    inThread(threadId) {
      const batches = new Map<string, DeltaBatch>();
      const rows = db
        .select()
        .from(messageDelta)
        .where(eq(messageDelta.threadId, threadId))
        .orderBy(asc(messageDelta.messageId), asc(messageDelta.index))
        .all();
      for (const row of rows) {
        const batch = batches.get(row.messageId) ?? {
          messageId: row.messageId,
          index: 0,
          texts: [],
        };
        batch.texts.push(row.text);
        batches.set(row.messageId, batch);
      }
      return [...batches.values()];
    },

    textOf(messageId) {
      return db
        .select({ text: messageDelta.text })
        .from(messageDelta)
        .where(eq(messageDelta.messageId, messageId))
        .orderBy(asc(messageDelta.index))
        .all()
        .map((row) => row.text)
        .join("");
    },

    remove(messageId) {
      db.delete(messageDelta).where(eq(messageDelta.messageId, messageId)).run();
    },
  };
}

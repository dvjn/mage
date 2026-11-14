import { and, asc, eq, gte } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import type { DeltaBatch } from "@/shared/threads/events.ts";

import { messageDelta } from "./schema.ts";
import type { DeltaStore } from "./service.ts";

// Pieces in order, each run of one reply's pieces of one part as one batch.
function batched(rows: (typeof messageDelta.$inferSelect)[]) {
  const batches: DeltaBatch[] = [];
  for (const row of rows) {
    const part = row.part === "reasoning" ? row.part : undefined;
    const last = batches.at(-1);
    if (last?.messageId === row.messageId && last.part === part) {
      last.texts.push(row.text);
    } else {
      batches.push({
        messageId: row.messageId,
        index: row.index,
        texts: [row.text],
        ...(part && { part }),
      });
    }
  }
  return batches;
}

export function createDeltaStore(db: Db): DeltaStore {
  return {
    async append(threadId, { messageId, index, texts, part }) {
      if (texts.length === 0) return;
      await db.insert(messageDelta).values(
        texts.map((text, offset) => ({
          threadId,
          messageId,
          index: index + offset,
          text,
          part: part ?? ("text" as const),
        })),
      );
    },

    async inThread(threadId) {
      return batched(
        await db
          .select()
          .from(messageDelta)
          .where(eq(messageDelta.threadId, threadId))
          .orderBy(asc(messageDelta.messageId), asc(messageDelta.index)),
      );
    },

    async from(messageId, index) {
      return batched(
        await db
          .select()
          .from(messageDelta)
          .where(and(eq(messageDelta.messageId, messageId), gte(messageDelta.index, index)))
          .orderBy(asc(messageDelta.index)),
      );
    },

    async partsOf(messageId) {
      const rows = await db
        .select({ text: messageDelta.text, part: messageDelta.part })
        .from(messageDelta)
        .where(eq(messageDelta.messageId, messageId))
        .orderBy(asc(messageDelta.index));
      const join = (part: string) =>
        rows
          .filter((row) => row.part === part)
          .map((row) => row.text)
          .join("");
      return { text: join("text"), reasoning: join("reasoning") };
    },

    async remove(messageId) {
      await db.delete(messageDelta).where(eq(messageDelta.messageId, messageId));
    },
  };
}

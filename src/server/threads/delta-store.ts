import { asc, eq } from "drizzle-orm";

import type { DeltaBatch } from "@/shared/threads.ts";
import type { Db } from "@/server/db/db.ts";

import type { DeltaStore } from "./service.ts";
import { messageDelta } from "./schema.ts";

export function createDeltaStore(db: Db): DeltaStore {
  return {
    append(threadId, { messageId, index, texts, part }) {
      if (texts.length === 0) return;
      db.insert(messageDelta)
        .values(
          texts.map((text, offset) => ({
            threadId,
            messageId,
            index: index + offset,
            text,
            part: part ?? ("text" as const),
          })),
        )
        .run();
    },

    inThread(threadId) {
      const batches: DeltaBatch[] = [];
      const rows = db
        .select()
        .from(messageDelta)
        .where(eq(messageDelta.threadId, threadId))
        .orderBy(asc(messageDelta.messageId), asc(messageDelta.index))
        .all();
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
    },

    partsOf(messageId) {
      const rows = db
        .select({ text: messageDelta.text, part: messageDelta.part })
        .from(messageDelta)
        .where(eq(messageDelta.messageId, messageId))
        .orderBy(asc(messageDelta.index))
        .all();
      const join = (part: string) =>
        rows
          .filter((row) => row.part === part)
          .map((row) => row.text)
          .join("");
      return { text: join("text"), reasoning: join("reasoning") };
    },

    remove(messageId) {
      db.delete(messageDelta).where(eq(messageDelta.messageId, messageId)).run();
    },
  };
}

// How far each person has seen each thread, which their reading moves on and so does what they post,
// never back; and when they last saw each kind of a thread's activity, so what ended before then
// leaves their tray.

import type { Signals } from "@/server/sync/signals.ts";
import type { Reader as AccessReader } from "@/server/access/access.ts";

import type { ThreadReadStore } from "./read-store.ts";

export interface ReadsOptions {
  store: ThreadReadStore;
  signals: Pick<Signals, "changed">;
  now?: () => Date;
}

export type Reads = ReturnType<typeof createReads>;

export function createReads(options: ReadsOptions) {
  const { store, signals } = options;
  const now = options.now ?? (() => new Date());
  return {
    // Records the reader saw the thread up to `seq`, at most its newest event, never moving back,
    // and tells their feeds.
    async mark(reader: Pick<AccessReader, "principal" | "thread">, seq: number) {
      const { principal, thread } = reader;
      const seen = await store.mark(
        principal.userId,
        thread.id,
        Math.min(seq, thread.lastEventSeq),
      );
      signals.changed({ threadId: thread.id, read: { userId: principal.userId, seq: seen } });
      return { seq: seen };
    },

    // The seq each of the threads was seen up to by the person, for those they have seen.
    seen: async (userId: string, threadIds: string[]) => store.seen(userId, threadIds),

    // When the person last saw each kind of the thread's activity, by kind.
    activitySeen: async (userId: string, threadId: string) => store.activitySeen(userId, threadId),

    // Records the person saw the kind of the thread's activity now.
    markActivity: async (userId: string, threadId: string, kind: string) =>
      store.markActivity(userId, threadId, kind, now()),

    // The author of a post has seen what they answered, in the write that stores it.
    posted: async (post: { by: string; threadId: string; seq: number }) => {
      await store.mark(post.by, post.threadId, post.seq);
    },
  };
}

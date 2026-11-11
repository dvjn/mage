// Side questions people ask about a row of a thread: kept per person, and asked as the thread's
// own next request would be were the branch to end at the row, the side conversation after it,
// so that the provider reads what its prompt cache holds of the thread. Nothing in them is ever
// read by the thread's agent, and no tool may be called for them.

import { asc, eq, inArray, and } from "drizzle-orm";
import { ulid } from "ulid";

import type { ThreadRequest } from "@/server/agent/compaction.ts";
import type { Db } from "@/server/db/db.ts";
import { user } from "@/server/orgs/schema.ts";
import type { ModelMessage, ModelRequest } from "@/server/models/gateway.ts";
import type { Aside } from "@/shared/threads/history.ts";

import { aside, asideTurn } from "./schema.ts";

export interface AsideStore {
  // The person's side questions in the thread, oldest first, each with its turns in order.
  of(threadId: string, userId: string): Aside[];
  // With who asked it, by name.
  find(id: string): (Aside & { threadId: string; userId: string; name: string }) | null;
  create(input: { threadId: string; branchId: string; rowId: string; userId: string }): string;
  addTurn(
    asideId: string,
    turn: {
      role: "question" | "answer";
      text: string;
      model?: string | null;
      failure?: "stopped" | "error";
      error?: string;
    },
  ): void;
}

const STOPPED = "Stopped";

// A failed turn as stored: stopped, or failed with what was said, if anything.
function failureOf(text: string) {
  if (text === STOPPED) return { failure: "stopped" as const };
  return { failure: "error" as const, ...(text && { error: text }) };
}

export function createAsideStore(db: Db): AsideStore {
  function turnsOf(ids: string[]) {
    if (ids.length === 0) return new Map<string, Aside["turns"]>();
    const turns = new Map<string, Aside["turns"]>();
    const rows = db
      .select()
      .from(asideTurn)
      .where(inArray(asideTurn.asideId, ids))
      .orderBy(asc(asideTurn.createdAt), asc(asideTurn.id))
      .all();
    for (const row of rows) {
      turns.set(row.asideId, [
        ...(turns.get(row.asideId) ?? []),
        {
          id: row.id,
          role: row.role,
          text: row.failed ? "" : row.text,
          at: row.createdAt.toISOString(),
          model: row.model,
          ...(row.failed && failureOf(row.text)),
        },
      ]);
    }
    return turns;
  }

  function shown(row: typeof aside.$inferSelect, turns: Map<string, Aside["turns"]>) {
    return {
      id: row.id,
      branchId: row.branchId,
      rowId: row.rowId,
      createdAt: row.createdAt.toISOString(),
      turns: turns.get(row.id) ?? [],
    };
  }

  return {
    of(threadId, userId) {
      const rows = db
        .select()
        .from(aside)
        .where(and(eq(aside.threadId, threadId), eq(aside.userId, userId)))
        .orderBy(asc(aside.createdAt), asc(aside.id))
        .all();
      const turns = turnsOf(rows.map((row) => row.id));
      return rows.map((row) => shown(row, turns));
    },

    find(id) {
      const found = db
        .select({ aside, name: user.name })
        .from(aside)
        .innerJoin(user, eq(user.id, aside.userId))
        .where(eq(aside.id, id))
        .get();
      if (!found) return null;
      const { aside: row, name } = found;
      return { ...shown(row, turnsOf([id])), threadId: row.threadId, userId: row.userId, name };
    },

    create(input) {
      const id = ulid();
      db.insert(aside)
        .values({ id, ...input })
        .run();
      return id;
    },

    addTurn(asideId, { failure, error, ...turn }) {
      db.insert(asideTurn)
        .values({
          id: ulid(),
          asideId,
          ...turn,
          // A failed turn keeps what went wrong in its text: "Stopped" marks one that was stopped.
          text: failure === "stopped" ? STOPPED : failure ? (error ?? "") : turn.text,
          failed: !!failure,
        })
        .run();
    },
  };
}

// What heads the first side question, so that the model knows it is asked aside.
export function asideHeading(name: string) {
  return `[${name}] Asked aside about the conversation so far; only ${name} sees this and the answer. Answer it directly; do not call tools.`;
}

// The thread's request with the side conversation after it, for one answer and no tool calls.
export function asideRequest(
  thread: ThreadRequest,
  turns: readonly Pick<Aside["turns"][number], "role" | "text" | "failure">[],
  name: string,
): Omit<ModelRequest, "model"> {
  const said = turns.filter((turn) => !turn.failure);
  const messages: ModelMessage[] = said.map((turn, index) =>
    turn.role === "answer"
      ? { role: "assistant", text: turn.text }
      : {
          role: "user",
          text: index === 0 ? `${asideHeading(name)}\n\n${turn.text}` : `[${name}] ${turn.text}`,
        },
  );
  return {
    ...thread,
    messages: [...thread.messages, ...messages],
    maxSteps: 1,
    answerOnly: true,
  };
}

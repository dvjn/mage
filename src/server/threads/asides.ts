// Side questions people ask about a row of a thread: kept per person, and asked as the thread's
// own next request would be were the branch to end at the row, the side conversation after it,
// so that the provider reads what its prompt cache holds of the thread. Nothing in them is ever
// read by the thread's agent, and no tool may be called for them. An answer is written a piece at
// a time; its asker may stop it, and asks more only once it is done.

import { asc, eq, inArray, and } from "drizzle-orm";
import { ulid } from "ulid";

import type { ThreadAccess } from "@/server/access/access.ts";
import { modelPart, type ThreadRequest } from "@/server/execution/compaction.ts";
import type { Db } from "@/server/db/db.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import { user } from "@/server/orgs/schema.ts";
import type { ModelMessage, ModelRequest } from "@/server/models/gateway.ts";
import type { Aside } from "@/shared/threads/history.ts";

import type { Branches } from "./branches.ts";
import { rowActions } from "./history.ts";
import { aside, asideTurn } from "./schema.ts";
import type { Transcripts } from "./transcripts.ts";
import type { Asking, ThreadAsk } from "./types.ts";

export interface AsideStore {
  // The person's side questions in the thread, oldest first, each with its turns in order.
  of(threadId: string, userId: string): Promise<Aside[]>;
  // With who asked it, by name.
  find(id: string): Promise<(Aside & { threadId: string; userId: string; name: string }) | null>;
  create(input: {
    threadId: string;
    branchId: string;
    rowId: string;
    userId: string;
  }): Promise<string>;
  addTurn(
    asideId: string,
    turn: {
      role: "question" | "answer";
      text: string;
      model?: string | null;
      failure?: "stopped" | "error";
      error?: string;
    },
  ): Promise<void>;
}

const STOPPED = "Stopped";

// A failed turn as stored: stopped, or failed with what was said, if anything.
function failureOf(text: string) {
  if (text === STOPPED) return { failure: "stopped" as const };
  return { failure: "error" as const, ...(text && { error: text }) };
}

export function createAsideStore(db: Db): AsideStore {
  async function turnsOf(ids: string[]) {
    if (ids.length === 0) return new Map<string, Aside["turns"]>();
    const turns = new Map<string, Aside["turns"]>();
    const rows = await db
      .select()
      .from(asideTurn)
      .where(inArray(asideTurn.asideId, ids))
      .orderBy(asc(asideTurn.createdAt), asc(asideTurn.id));
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
    async of(threadId, userId) {
      const rows = await db
        .select()
        .from(aside)
        .where(and(eq(aside.threadId, threadId), eq(aside.userId, userId)))
        .orderBy(asc(aside.createdAt), asc(aside.id));
      const turns = await turnsOf(rows.map((row) => row.id));
      return rows.map((row) => shown(row, turns));
    },

    async find(id) {
      const found = (
        await db
          .select({ aside, name: user.name })
          .from(aside)
          .innerJoin(user, eq(user.id, aside.userId))
          .where(eq(aside.id, id))
          .limit(1)
      )[0];
      if (!found) return null;
      const { aside: row, name } = found;
      return {
        ...shown(row, await turnsOf([id])),
        threadId: row.threadId,
        userId: row.userId,
        name,
      };
    },

    async create(input) {
      const id = ulid();
      await db.insert(aside).values({ id, ...input });
      return id;
    },

    async addTurn(asideId, { failure, error, ...turn }) {
      await db.insert(asideTurn).values({
        id: ulid(),
        asideId,
        ...turn,
        // A failed turn keeps what went wrong in its text: "Stopped" marks one that was stopped.
        text: failure === "stopped" ? STOPPED : failure ? (error ?? "") : turn.text,
        failed: !!failure,
      });
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
    ...modelPart(thread),
    messages: [...thread.messages, ...messages],
    maxSteps: 1,
    answerOnly: true,
  };
}

export interface AsidesOptions {
  store: AsideStore;
  access: Pick<ThreadAccess, "require">;
  transcripts: Pick<Transcripts, "of">;
  branches: Pick<Branches, "branchIn" | "abilitiesIn">;
  // The thread's model and request, for answering; no side question is answered without it.
  ask?: ThreadAsk;
}

export type Asides = ReturnType<typeof createAsides>;

export function createAsides(options: AsidesOptions) {
  const { store, access, transcripts, branches, ask } = options;

  // The side questions being answered, each with what stops its answer.
  const answering = new Map<string, AbortController>();

  // The reader's own side question in the thread.
  async function asideOf(principal: Principal, threadId: string, asideId: string) {
    await access.require(principal, threadId);
    const found = await store.find(asideId);
    if (!found || found.threadId !== threadId || found.userId !== principal.userId) {
      throw new ServiceError(404, "Side question not found");
    }
    return found;
  }

  // The side question as its asker sees it.
  async function shownAside(asideId: string): Promise<Aside> {
    const {
      threadId: _thread,
      userId: _user,
      name: _name,
      ...shown
    } = (await store.find(asideId))!;
    return shown;
  }

  // Answers the side question's last question with the thread's model, the thread as its branch
  // was up to the row, each piece written as it comes. An answer stopped keeps what was written;
  // what went wrong is kept as the answer when it fails.
  async function asking(asideId: string): Promise<Asking> {
    const stop = new AbortController();
    answering.set(asideId, stop);
    return {
      aside: await shownAside(asideId),
      async answer(write, signal) {
        const side = (await store.find(asideId))!;
        const stopped = AbortSignal.any([signal, stop.signal]);
        let model: string | null = null;
        let text = "";
        try {
          const asked = await ask!(side.threadId, side.branchId, side.rowId);
          model = asked.ref;
          const request = asideRequest(asked.request, side.turns, side.name);
          const ends = AbortSignal.any([stopped, AbortSignal.timeout(120_000)]);
          for await (const event of asked.model.stream(request, ends)) {
            if (event.type !== "delta") continue;
            text += event.text;
            write(event.text);
          }
          if (!text.trim()) throw new Error("The model wrote no answer.");
          await store.addTurn(asideId, { role: "answer", text: text.trim(), model });
        } catch (err) {
          if (stopped.aborted && text.trim()) {
            await store.addTurn(asideId, { role: "answer", text: text.trim(), model });
          } else {
            await store.addTurn(asideId, {
              role: "answer",
              text: "",
              model,
              ...(stopped.aborted
                ? { failure: "stopped" as const }
                : {
                    failure: "error" as const,
                    ...(err instanceof Error && err.message && { error: err.message }),
                  }),
            });
          }
        } finally {
          if (answering.get(asideId) === stop) answering.delete(asideId);
        }
        return shownAside(asideId);
      },
    };
  }

  return {
    // Whether side questions are answered here.
    answered: !!ask,

    // The reader's side questions in the thread.
    async of(principal: Principal, id: string): Promise<Aside[]> {
      await access.require(principal, id);
      return store.of(id, principal.userId);
    },

    // Asks a side question about a row of a branch, the current one when none is named, to be
    // answered.
    async ask(
      principal: Principal,
      id: string,
      input: { rowId: string; branchId?: string; text: string },
    ): Promise<Asking> {
      const { thread } = await access.require(principal, id);
      const branchId = await branches.branchIn(thread, input.branchId);
      const fold = await transcripts.of(id, branchId);
      const { rows } = fold.transcript();
      const index = fold.indexOf(input.rowId);
      if (index === -1) throw new ServiceError(404, "Message not found");
      const abilities = await branches.abilitiesIn(principal, thread, branchId, rows);
      if (!rowActions(rows, index, abilities).includes("aside")) {
        throw new ServiceError(403, "Only people who can post here can ask aside");
      }
      if (!ask) throw new ServiceError(409, "Side questions can't be asked here");
      const asideId = await store.create({
        threadId: id,
        branchId,
        rowId: input.rowId,
        userId: principal.userId,
      });
      await store.addTurn(asideId, { role: "question", text: input.text });
      return asking(asideId);
    },

    // Asks the reader's side question more, to be answered once the answer before is done.
    async followUp(principal: Principal, id: string, asideId: string, text: string) {
      await asideOf(principal, id, asideId);
      if (answering.has(asideId)) throw new ServiceError(409, "The answer is still being written");
      await store.addTurn(asideId, { role: "question", text });
      return asking(asideId);
    },

    // Stops the answer being written to the reader's side question.
    async stop(principal: Principal, id: string, asideId: string) {
      await asideOf(principal, id, asideId);
      answering.get(asideId)?.abort();
    },
  };
}

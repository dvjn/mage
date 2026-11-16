// The one way into a thread's agent: people's messages and notices from anywhere else are
// enqueued here, each an event in the thread's log and a row saying where it stands on its branch,
// in one write with whatever the listeners do about it. An input waits until a run takes it in,
// its author takes it back, or it is dropped. A delivery with a key is made once: the same key
// again returns what the first made. A message sent as an aside between people is shown at once
// and is never an input. A new branch has a row for each notice it reads and has not taken in, and
// is told again those waiting on the branch left whose source it holds, or that have none. What an
// input says is its event's, as the thread's fold reads it with any changes since. Whose words the
// agent read is kept as it reads them: a message's author and a notice's people where a run takes
// them in, an aside's author and the people of a notice that does not wake it where they are told,
// and an answer's writer where it is given.

import { ServiceError } from "@/server/kernel/errors.ts";
import type { Reader, ThreadAccess } from "@/server/access/access.ts";
import type { SpaceStore } from "@/server/spaces/service.ts";
import type { Signals } from "@/server/sync/signals.ts";
import { type Append, eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { ThreadStore } from "@/server/threads/types.ts";
import type { Delivery, Influencer, ThreadEventSummary } from "@/shared/threads/events.ts";
import { personLabel } from "@/shared/people.ts";
import {
  asksToCompact,
  type PendingMessage,
  type NoticeMessage,
  type SentCommand,
  waitingIn,
} from "@/shared/transcript.ts";

import { actorOf, type Notice } from "./notices.ts";
import type { INPUT_STATES, ORIGIN_KINDS } from "./schema.ts";
import type { InputRow, QueueStore } from "./store.ts";

export type InputStatus = (typeof INPUT_STATES)[number];

export type Origin = { kind: (typeof ORIGIN_KINDS)[number]; id: string };

export type Input =
  | {
      kind: "message";
      by: string;
      text: string;
      delivery: Delivery;
      quiet?: boolean;
      guest?: boolean;
      command?: SentCommand;
    }
  | { kind: "notice"; notice: Notice };

export interface QueuedInput {
  id: string;
  threadId: string;
  branchId: string;
  seq: number;
  kind: "message" | "notice";
  status: InputStatus;
  wake: boolean;
  delivery: Delivery | null;
  authorId: string | null;
  origin: Origin;
  key: string | null;
  // The call that made what sent it, for a notice.
  sourceCallId: string | null;
  // What it says as the fold reads it now; set while it waits.
  message?: PendingMessage;
  notice?: NoticeMessage;
}

// Whose words the thread's agent read, where its log put them before it.
export type Word = Influencer & { seq: number };

// The run that takes inputs in.
export interface RunRef {
  id: string;
  threadId: string;
  branchId: string;
}

export interface EnqueueOptions {
  origin?: Origin;
  key?: string;
  // The call that made what sends the notice: a branch is told it only while it holds that call.
  source?: { callId: string };
  // The branch it goes to; the thread's current one when not given.
  branchId?: string;
  // Names the thread when it has no title yet.
  title?: string;
  // Leaves the listeners untold, for a caller that acts on the input itself.
  quietly?: boolean;
}

export interface QueueOptions {
  store: QueueStore;
  log: ThreadLog;
  threads: Pick<ThreadStore, "find" | "eventAt" | "eventsAt" | "changesOf">;
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "can">;
  signals: Pick<Signals, "wake">;
  // Whether the caller is inside a write already.
  inTransaction?: () => boolean;
}

export type Queue = ReturnType<typeof createQueue>;

const AGENT = { kind: "agent" } as const;

function queuedOf(row: InputRow): QueuedInput {
  return {
    id: row.id,
    threadId: row.threadId,
    branchId: row.branchId,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    wake: row.wake,
    delivery: row.delivery,
    authorId: row.authorId,
    origin: { kind: row.originKind, id: row.originId },
    key: row.key,
    sourceCallId: row.sourceCallId,
  };
}

// The origin of an input whose producer named none.
function originOf(threadId: string, input: Input): Origin {
  if (input.kind === "message") return { kind: "person", id: input.by };
  const { notice } = input;
  if (notice.actor?.kind === "person") return { kind: "person", id: notice.actor.userId };
  if (notice.source.threadId !== threadId) return { kind: "subagent", id: notice.source.threadId };
  return { kind: "system", id: threadId };
}

export function createQueue(options: QueueOptions) {
  const { store, log, threads, spaceStore, access, signals } = options;
  const listeners: ((input: QueuedInput) => Promise<void>)[] = [];

  // The rows with what each says now: read from its event and, for a person's message, the
  // changes made to it on the branch since.
  async function withContent(rows: InputRow[], threadId: string, branchId?: string) {
    if (rows.length === 0) return [];
    const changed = rows.filter((row) => row.kind === "message").map((row) => row.id);
    const events = [
      ...(await threads.eventsAt(
        threadId,
        rows.map((row) => row.seq),
      )),
      ...(await threads.changesOf(threadId, changed, branchId)),
    ].toSorted((one, other) => one.seq - other.seq);
    const waiting = waitingIn(events.map(eventSummary));
    const messages = new Map(waiting.messages.map((message) => [message.id, message]));
    const notices = new Map(waiting.notices.map((notice) => [notice.id, notice]));
    return rows.map((row): QueuedInput => {
      const queued = queuedOf(row);
      const message = messages.get(row.id);
      const notice = notices.get(row.id);
      return { ...queued, ...(message && { message }), ...(notice && { notice }) };
    });
  }

  // Drops the branch's waiting messages whose authors can no longer post in the thread, each
  // author asked once, inside the write under way; answers the inputs still waiting.
  async function dropRefusedIn(threadId: string, append: Append, branchId?: string) {
    const waiting = await store.waiting(threadId, branchId);
    const messages = waiting.filter((row) => row.kind === "message");
    if (messages.length === 0) return waiting;
    const thread = await threads.find(threadId);
    const space = thread && (await spaceStore.find(thread.spaceId));
    const allowed = new Map<string, boolean>();
    const refused: string[] = [];
    for (const row of messages) {
      const author = row.authorId!;
      if (!allowed.has(author)) {
        allowed.set(
          author,
          !!thread &&
            !!space &&
            (await access.can({ userId: author, orgId: space.orgId }, thread, "post")),
        );
      }
      if (!allowed.get(author)) refused.push(row.id);
    }
    const dropped = new Set<string>();
    for (const row of await store.drop(refused, messages[0]!.branchId)) {
      dropped.add(row.id);
      await append({ type: "message.dropped", actor: AGENT, data: { messageId: row.id } });
    }
    return waiting.filter((row) => !dropped.has(row.id));
  }

  // Changes one of the reader's own messages that waits, inside one write.
  async function changeWaiting(
    reader: Reader,
    inputId: string,
    change: (append: Append, message: PendingMessage, branchId: string) => Promise<void>,
  ) {
    const threadId = reader.thread.id;
    const { events } = await log.write(threadId, async (append) => {
      const branchId = (await threads.find(threadId))?.currentBranchId ?? "";
      const row = await store.find(inputId, branchId);
      const message =
        row?.threadId === threadId && row.status === "waiting" && row.kind === "message"
          ? (await withContent([row], threadId, branchId))[0]?.message
          : undefined;
      if (!message) throw new ServiceError(409, "The agent has already taken this message in");
      if (message.author.userId !== reader.principal.userId) {
        throw new ServiceError(403, "Only its author can change a message");
      }
      await change(append, message, branchId);
    });
    signals.wake(threadId);
    return events[0]!;
  }

  const admission = {
    // Takes the run's waiting inputs in: every message ("all") or those sent to steer
    // ("steering"), never one asking to compact, then every notice; or those named. Unless they are
    // named, messages whose authors may no longer post are dropped first. `kept` are inputs an
    // earlier run took in that this one takes in again, named first. One event names them all,
    // messages before notices; `before` runs first when there is any. Answers what was taken in,
    // with what each says.
    async admit(
      run: RunRef,
      which: "all" | "steering" | { ids: readonly string[] },
      opts: { kept?: readonly string[]; before?: () => Promise<void> } = {},
    ): Promise<QueuedInput[]> {
      const kept = opts.kept ?? [];
      if (typeof which === "object" && which.ids.length === 0 && kept.length === 0) return [];
      return (
        await log.write(
          run.threadId,
          async (append) => {
            // Those named were just sent, or are taken in by the run that was asked for them.
            const rows =
              typeof which === "object"
                ? await store.waiting(run.threadId, run.branchId)
                : await dropRefusedIn(run.threadId, append, run.branchId);
            const waiting = await withContent(rows, run.threadId, run.branchId);
            const chosen = waiting.filter((input) => {
              if (typeof which === "object") return which.ids.includes(input.id);
              if (input.kind === "notice") return true;
              if (input.message && asksToCompact(input.message)) return false;
              return which === "all" || input.delivery === "steer";
            });
            const ordered = [
              ...chosen.filter((input) => input.kind === "message"),
              ...chosen.filter((input) => input.kind === "notice"),
            ];
            if (ordered.length === 0 && kept.length === 0) return [];
            await opts.before?.();
            const moved = new Set(
              (
                await store.admit(
                  ordered.map((input) => input.id),
                  run.id,
                  run.branchId,
                )
              ).map((row) => row.id),
            );
            await store.readmit(run.threadId, kept, run.id, run.branchId);
            const taken = ordered.filter((input) => moved.has(input.id));
            const ids = [...kept, ...taken.map((input) => input.id)];
            if (ids.length === 0) return [];
            const admitted = await append({
              type: "message.admitted",
              actor: AGENT,
              data: { runId: run.id, messageIds: ids },
            });
            await store.spoke(run.threadId, [admitted.seq]);
            return taken.map((input) => ({
              ...input,
              status: "admitted" as const,
            }));
          },
          run.branchId,
        )
      ).result;
    },

    // Drops the thread's waiting messages whose authors may no longer post in it.
    async dropRefused(threadId: string) {
      await log.write(threadId, async (append) => dropRefusedIn(threadId, append));
    },

    // What waits on the branch once the messages of authors who may no longer post are dropped,
    // oldest first, with what each says.
    async admissible(threadId: string, branchId?: string) {
      return (
        await log.write(
          threadId,
          async (append) =>
            withContent(await dropRefusedIn(threadId, append, branchId), threadId, branchId),
          branchId,
        )
      ).result;
    },

    // A new current branch, made from the branch left, in the write that makes it: it has a row
    // waiting for each notice it reads and has not taken in; each notice waiting or taken in on the
    // branch left that it does not read is told again on it, as a copy, when the branch holds the
    // call that sent it or none did. Messages waiting on the branch left are dropped; every other
    // row there stays as it stands. A copy that wakes the agent starts it on the worker's next
    // pass, unless the run that made the branch takes it in first.
    async branched(threadId: string, branchId: string, left: string) {
      await log.write(
        threadId,
        async (append) => {
          await store.fillCurrent(threadId);
          const carried = await store.carried(threadId, left, branchId);
          for (const row of carried) {
            const event = await threads.eventAt(threadId, row.seq);
            if (event?.type !== "notice") continue;
            const copy = await append({ type: "notice", actor: AGENT, data: event.data });
            await store.insert({
              id: copy.id,
              threadId,
              branchId: copy.branchId,
              seq: copy.seq,
              kind: "notice",
              wake: row.wake,
              delivery: null,
              authorId: null,
              originKind: row.originKind,
              originId: row.originId,
              key: null,
              copyOf: row.id,
              sourceCallId: row.sourceCallId,
            });
            if (!row.wake) await store.spoke(threadId, [copy.seq]);
          }
          const messages = (await store.waiting(threadId, left)).filter(
            (row) => row.kind === "message",
          );
          await store.drop(
            messages.map((row) => row.id),
            left,
          );
          if (carried.length > 0) signals.wake(threadId);
        },
        branchId,
      );
    },
  };

  return {
    // Puts the input in the thread with its event, then tells the listeners in the same write and
    // wakes the thread. With a key already used in the thread, answers what that made and adds
    // nothing. An aside has an event and no row. `added` says whether an input was added.
    async enqueue(
      threadId: string,
      input: Input,
      opts: EnqueueOptions = {},
    ): Promise<{ event: ThreadEventSummary; input: QueuedInput | null; added: boolean }> {
      // A subagent's starter is held with it when this is the outermost write, so what the input
      // sets going may start the subagent's run under its starter's limit.
      const starter = options.inTransaction?.()
        ? null
        : ((await threads.find(threadId))?.parentThreadId ?? null);
      return (
        await log.write(
          threadId,
          async (append) => {
            if (opts.key) {
              const found = await store.byKey(threadId, opts.key);
              if (found) {
                const event = await threads.eventAt(threadId, found.seq);
                return { event: eventSummary(event!), input: queuedOf(found), added: false };
              }
            }
            const stored =
              input.kind === "message"
                ? await append(
                    {
                      type: "message",
                      actor: { kind: "user", userId: input.by },
                      data: {
                        parts: [{ type: "text", text: input.text }],
                        quiet: !!input.quiet,
                        mode: input.delivery,
                        ...(input.guest && { guest: input.guest }),
                        ...(input.command && { command: input.command }),
                      },
                    },
                    opts.title,
                  )
                : await append({
                    type: "notice",
                    actor: AGENT,
                    data: (() => {
                      const actor = actorOf(input.notice);
                      return { ...input.notice, ...(actor && { actor }) };
                    })(),
                  });
            const event = eventSummary(stored);
            // An aside, and a notice that does not wake the agent, are read as soon as they are
            // shown.
            if (
              input.kind === "message"
                ? input.quiet
                : input.notice.wake === false && input.notice.influence.length > 0
            ) {
              await store.spoke(threadId, [stored.seq]);
            }
            if (input.kind === "message" && input.quiet)
              return { event, input: null, added: false };
            const origin = opts.origin ?? originOf(threadId, input);
            const row = await store.insert({
              id: stored.id,
              threadId,
              branchId: stored.branchId,
              seq: stored.seq,
              kind: input.kind,
              wake: input.kind === "message" || input.notice.wake !== false,
              delivery: input.kind === "message" ? input.delivery : null,
              authorId: input.kind === "message" ? input.by : null,
              originKind: origin.kind,
              originId: origin.id,
              key: opts.key ?? null,
              sourceCallId: opts.source?.callId ?? null,
            });
            const queued = queuedOf(row);
            if (!opts.quietly) for (const listener of listeners) await listener(queued);
            signals.wake(threadId);
            return { event, input: queued, added: true };
          },
          opts.branchId,
          starter ? [starter] : [],
        )
      ).result;
    },

    // Changes the text of the reader's own waiting message, or whether it steers or waits for the
    // next run.
    async change(
      reader: Reader,
      inputId: string,
      change: { text?: string; delivery?: "steer" | "queue" },
    ) {
      return changeWaiting(reader, inputId, async (append, message, branchId) => {
        if (change.text !== undefined && message.command) {
          throw new ServiceError(409, "A command can't be edited; remove it and send it again");
        }
        await append({
          type: "message.changed",
          actor: { kind: "user", userId: reader.principal.userId },
          data: {
            messageId: inputId,
            ...(change.text !== undefined && { parts: [{ type: "text", text: change.text }] }),
            ...(change.delivery && { mode: change.delivery }),
          },
        });
        if (change.delivery) await store.setDelivery(inputId, branchId, change.delivery);
      });
    },

    // Takes back the reader's own waiting message.
    async withdraw(reader: Reader, inputId: string) {
      return changeWaiting(reader, inputId, async (append, _message, branchId) => {
        await store.withdraw(inputId, branchId);
        await append({
          type: "message.withdrawn",
          actor: { kind: "user", userId: reader.principal.userId },
          data: { messageId: inputId },
        });
      });
    },

    // The inputs waiting on the branch, the thread's current one when none is named, oldest
    // first, with what each says.
    async waiting(threadId: string, branchId?: string) {
      return withContent(await store.waiting(threadId, branchId), threadId, branchId);
    },

    // Whether a person's message waits on the branch.
    messageWaits: async (threadId: string, branchId?: string) =>
      store.messageWaits(threadId, branchId),

    // Whether an input that starts the agent waits on the branch.
    wakes: async (threadId: string, branchId?: string) => store.wakes(threadId, branchId),
    wakesIn: async (threadIds: readonly string[]) => store.wakesIn(threadIds),

    // Threads whose agent has an input to start on and no run under way.
    stranded: async () => store.stranded(),

    // A page of what came to the thread from the origin, newest first, each once however many
    // branches hold it and copies left out, with the event of each; and how many in all.
    async history(threadId: string, origin: Origin, page: { offset: number; limit: number }) {
      const { total, rows } = await store.history(threadId, origin, page);
      const events = await threads.eventsAt(
        threadId,
        rows.map((row) => row.seq),
      );
      const bySeq = new Map(events.map((event) => [event.seq, event]));
      return {
        total,
        entries: rows.flatMap((row) => {
          const event = bySeq.get(row.seq);
          return event?.type === "notice"
            ? [{ ...queuedOf(row), at: event.createdAt, notice: event.data }]
            : [];
        }),
      };
    },

    // How many inputs came to the thread from each origin of the kinds, by origin id, each once.
    counts: async (threadId: string, kinds: readonly Origin["kind"][]) =>
      store.counts(threadId, kinds),

    // Hears of every input enqueued, inside the write that enqueues it.
    onEnqueued(listener: (input: QueuedInput) => Promise<void>) {
      listeners.push(listener);
    },

    // Whose words the branch's agent read, the thread's current one when none is named, oldest
    // first.
    async words(threadId: string, branchId?: string): Promise<Word[]> {
      return (await store.words(threadId, branchId)).map((word) => ({
        seq: word.seq,
        userId: word.userId,
        name: personLabel(word),
        via: word.via,
      }));
    },

    // Records the answer given at the seq as its writer's words.
    async spoke(threadId: string, seq: number) {
      await store.spoke(threadId, [seq]);
    },

    // The rows of a log copied into the thread, as the log says each stands, and whose words it
    // read.
    async fromLog(threadId: string) {
      await store.fromLog(threadId);
    },

    // For the runs alone.
    admission,
  };
}

// Hints passed between requests, the agent worker and the server instances on one database: that a
// thread has new events, reply pieces or call output, that it may have a run to start, that what
// lists show of it changed, that an artifact changed. In this process they go through an event emitter; to the other
// instances, through Postgres notifications on one channel. What is sent inside a transaction goes
// out only once it commits, here and to the others, and never when it rolls back. All of it is a
// hint, carrying ids only: whoever hears it reads what changed for themselves, and reads again
// after a gap in what it heard.

import { EventEmitter } from "node:events";

import type { Logger } from "@/server/kernel/logger.ts";

// A thread whose list entry may read differently now; with `read`, only that someone saw it up to
// a seq; with `gone`, it was deleted from the space, whose members and its guests may hold it;
// with `tasks`, only its task list changed; with `rows`, only what its rows show.
export interface ActivityChange {
  threadId: string;
  tasks?: true;
  // Its rows read differently without a new event, as a schedule on one does when it is paused.
  rows?: true;
  // Only what its activity tray shows changed, as an owner deciding what the thread proposed does.
  background?: true;
  read?: { userId: string; seq: number };
  gone?: { spaceId: string };
}

// What a thread's followers are told: an event appended, a reply's pieces stored below `upto`, or
// a running call's output stored; each read from where it is kept.
export type ThreadHint =
  | { kind: "event"; seq: number }
  | { kind: "delta"; messageId: string; upto: number }
  | { kind: "live"; callId: string };

// What an artifact's open viewers are told: a version was published, its sharing changed, or it
// was deleted; each read from where it is kept.
export type ArtifactHint =
  | { type: "published"; artifactId: string; version: number }
  | { type: "sharing"; artifactId: string }
  | { type: "deleted"; artifactId: string };

// Hears what is notified on a channel, and is told after a lost connection is back, when what was
// notified meanwhile is lost. Answers how to stop listening. `check` makes sure the connection
// still answers.
export interface Listen {
  (
    channel: string,
    onMessage: (payload: string) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>>;
  check?(): Promise<void>;
}

export interface Signals {
  publish(threadId: string, hint: ThreadHint): void;
  // Calls `listener` with each hint published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (hint: ThreadHint) => void): () => void;
  // Says the thread may have a run to start or stop.
  wake(threadId: string): void;
  // Calls `listener` with each woken thread until unsubscribed.
  onWake(listener: (threadId: string) => void): () => void;
  // Says what a thread holds for its readers may have changed.
  activity(change: ActivityChange): void;
  // Calls `listener` with each change until unsubscribed.
  onActivity(listener: (change: ActivityChange) => void): () => void;
  // Says people left an org, so what names them may read differently.
  peopleLeft(): void;
  onPeopleLeft(listener: () => void): () => void;
  // Says what happened to an artifact.
  artifactChanged(hint: ArtifactHint): void;
  // Calls `listener` with each hint about the artifact until unsubscribed.
  subscribeArtifact(artifactId: string, listener: (hint: ArtifactHint) => void): () => void;
  // Calls `listener` whenever hints from other instances may have been missed.
  onGap(listener: () => void): () => void;
}

// The Postgres channel every signal goes through.
export const CHANNEL = "signals";
// Notifications carry under 8,000 bytes; a signal anywhere near that is not a hint.
const MAX_BYTES = 7000;

// Thread ids are ULIDs, so no thread's channel is named as these are.
const WAKE = "wake";
const ACTIVITY = "activity";
const PEOPLE = "people";
const GAP = "gap";
const ARTIFACT = "artifact:";

export interface SignalsOptions {
  instanceId: string;
  logger: Logger;
  listen?: Listen;
  // Keeps the encoded signal for the transaction under way to notify as it commits; false outside
  // one.
  queue: (message: string) => boolean;
  afterCommit: (run: () => void) => void;
  // Notifies the encoded signal at once, outside any transaction.
  notify: (message: string) => Promise<unknown>;
}

export function createSignals(options: SignalsOptions) {
  const { instanceId, logger } = options;
  const emitter = new EventEmitter();
  // Every open thread view is a listener.
  emitter.setMaxListeners(0);
  let subscriptions = 0;
  let unlisten: (() => Promise<void>) | undefined;
  // Signals sent outside a transaction go out one after another, in the order sent.
  let notifying: Promise<unknown> = Promise.resolve();

  const encode = (channel: string, payload: unknown) =>
    JSON.stringify({ o: instanceId, c: channel, p: payload });

  // A signal too large for a notification is never refused: a smaller one goes in its place that
  // has whoever hears it read again, a thread's change cut to the thread, anything else a gap.
  function smaller(channel: string, payload: unknown): [string, unknown] {
    if (channel === ACTIVITY) {
      const { threadId, gone } = payload as ActivityChange;
      return [channel, { threadId, ...(gone && { gone: { spaceId: gone.spaceId } }) }];
    }
    return [GAP, null];
  }

  function send(channel: string, payload: unknown) {
    let message = encode(channel, payload);
    if (Buffer.byteLength(message) > MAX_BYTES) {
      logger.warn({ channel, bytes: Buffer.byteLength(message) }, "signal too large; read again");
      [channel, payload] = smaller(channel, payload);
      if (Buffer.byteLength(encode(channel, payload)) > MAX_BYTES) [channel, payload] = [GAP, null];
      message = encode(channel, payload);
    }
    if (options.queue(message)) {
      options.afterCommit(() => emitter.emit(channel, payload));
      return;
    }
    emitter.emit(channel, payload);
    // A signal that is not notified is a hint the others miss, which they make up for.
    notifying = notifying
      .then(() => options.notify(message))
      .catch((err: unknown) => logger.debug({ err, channel }, "signal not notified"));
  }

  function receive(raw: string) {
    let message: { o: string; c: string; p: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.o === instanceId) return;
    emitter.emit(message.c, message.p);
  }

  function on<T>(channel: string, listener: (payload: T) => void) {
    emitter.on(channel, listener);
    return () => {
      emitter.off(channel, listener);
    };
  }

  return {
    publish(threadId: string, hint: ThreadHint) {
      send(threadId, hint);
    },
    subscribe(threadId: string, listener: (hint: ThreadHint) => void) {
      subscriptions += 1;
      const off = on(threadId, listener);
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        subscriptions -= 1;
        off();
      };
    },
    // How many thread subscriptions are open.
    subscriptions: () => subscriptions,
    wake(threadId: string) {
      send(WAKE, threadId);
    },
    onWake: (listener: (threadId: string) => void) => on(WAKE, listener),
    activity(change: ActivityChange) {
      send(ACTIVITY, change);
    },
    onActivity: (listener: (change: ActivityChange) => void) => on(ACTIVITY, listener),
    peopleLeft() {
      send(PEOPLE, null);
    },
    onPeopleLeft: (listener: () => void) => on(PEOPLE, listener),
    artifactChanged(hint: ArtifactHint) {
      send(`${ARTIFACT}${hint.artifactId}`, hint);
    },
    subscribeArtifact: (artifactId: string, listener: (hint: ArtifactHint) => void) =>
      on(`${ARTIFACT}${artifactId}`, listener),
    onGap: (listener: () => void) => on(GAP, listener),

    // Hears the other instances from now on; what is sent here reaches this process without it.
    async start() {
      if (unlisten || !options.listen) return;
      unlisten = await options.listen(CHANNEL, receive, () => emitter.emit(GAP));
    },

    async stop() {
      const stopping = unlisten;
      unlisten = undefined;
      await stopping?.();
    },

    // Resolves once the signals sent outside a transaction so far are notified.
    async settled() {
      await notifying;
    },
  } satisfies Signals & Record<string, unknown>;
}

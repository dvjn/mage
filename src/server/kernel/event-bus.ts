// Thread feed items, wake-ups and changes for inboxes passed between requests and the agent
// worker. In this process they go through an event emitter. Every server instance on the database
// also writes what it sends to a feed there, and reads what the others wrote, in order, so a
// change made through one instance reaches the streams and workers of every other. What is sent
// inside a transaction is in the feed only once it commits.

import { EventEmitter } from "node:events";

import type { ThreadFeedItem } from "@/shared/threads/events.ts";

// A thread whose list entry may read differently now; with `read`, only that someone saw it up to
// a seq; with `gone`, it was deleted, and who could read it: its space's members and its guests;
// with `tasks`, only its task list changed; with `rows`, only what its rows show.
export interface ActivityChange {
  threadId: string;
  tasks?: true;
  // Its rows read differently without a new event, as a schedule on one does when it is paused.
  rows?: true;
  // Only what its activity tray shows changed, as an owner deciding what the thread proposed does.
  background?: true;
  read?: { userId: string; seq: number };
  gone?: { spaceId: string; guests: string[] };
}

// A call a person asked to move to the background, for whichever instance runs it.
export interface MoveCall {
  threadId: string;
  callId: string;
}

export interface EventBus {
  publish(threadId: string, item: ThreadFeedItem): void;
  // Calls `listener` with each item published for the thread until unsubscribed.
  subscribe(threadId: string, listener: (item: ThreadFeedItem) => void): () => void;
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
  // Asks whichever instance runs the call to move it to the background.
  moveCall(move: MoveCall): void;
  onMoveCall(listener: (move: MoveCall) => void): () => void;
}

// Where the instances on a database leave what they send, for each other.
export interface BusFeed {
  append(channel: string, payload: unknown): void;
  // What other instances left after the seq, oldest first.
  after(seq: number): { seq: number; channel: string; payload: unknown }[];
  // The newest seq in the feed.
  last(): number;
  // Forgets what was left before the time.
  prune(before: Date): void;
}

// Thread ids are ULIDs, so no thread's channel is named as these are.
const WAKE = "wake";
const ACTIVITY = "activity";
const PEOPLE = "people";
const MOVE = "move";

// How often the feed is read, and how long what is left there is kept.
const POLL_MS = 200;
const KEEP_MS = 60_000;

export function createEventBus(feed?: BusFeed, options: { pollMs?: number } = {}) {
  const emitter = new EventEmitter();
  // Every open thread view is a listener.
  emitter.setMaxListeners(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;
  let polls = 0;

  function send(channel: string, payload: unknown) {
    emitter.emit(channel, payload);
    feed?.append(channel, payload);
  }

  function on<T>(channel: string, listener: (payload: T) => void) {
    emitter.on(channel, listener);
    return () => {
      emitter.off(channel, listener);
    };
  }

  // Delivers here what the other instances sent since last read.
  function poll() {
    if (!feed) return;
    for (const message of feed.after(cursor)) {
      cursor = message.seq;
      emitter.emit(message.channel, message.payload);
    }
    polls += 1;
    if (polls % Math.ceil(KEEP_MS / (options.pollMs ?? POLL_MS)) === 0) {
      feed.prune(new Date(Date.now() - KEEP_MS));
    }
  }

  const bus = {
    publish(threadId: string, item: ThreadFeedItem) {
      send(threadId, item);
    },
    subscribe: (threadId: string, listener: (item: ThreadFeedItem) => void) =>
      on(threadId, listener),
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
    moveCall(move: MoveCall) {
      send(MOVE, move);
    },
    onMoveCall: (listener: (move: MoveCall) => void) => on(MOVE, listener),

    // Reads the feed from now on, as often as set; a no-op without one.
    start() {
      if (!feed || timer) return;
      cursor = feed.last();
      timer = setInterval(() => {
        try {
          poll();
        } catch {
          // The next poll reads from where this one stopped.
        }
      }, options.pollMs ?? POLL_MS);
      timer.unref();
    },

    stop() {
      clearInterval(timer);
      timer = undefined;
    },

    // Reads the feed now, as a poll would.
    poll,
  } satisfies EventBus & Record<string, unknown>;
  return bus;
}

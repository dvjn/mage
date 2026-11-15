// The threads a reader's lists show, in a space, among those shared with them, and found by
// title: each with its model and its provider, who has written in it and what it holds for the
// reader: what the agent is doing in it, whether they may decide on the call it waits for, its
// newest notable event, its last run's failure, how far they have seen it, and the one status all
// that shows them. A subagent's thread is listed under the thread whose agent started it, which
// takes in the most pressing of its subagents' statuses. The list feed follows those changes for
// every thread the reader can read. Threads of an archived space stay out of search and the feed.

import { filterAsync } from "@/server/kernel/async.ts";
import type { Subagents } from "@/server/subagents/subagents.ts";
import type { Run, RunReads } from "@/server/execution/execution.ts";
import type { GuestStore, GuestThread } from "@/server/guests/service.ts";

import type { Signals } from "@/server/sync/signals.ts";
import type { Models, OrgModels } from "@/server/models/service.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import { type Space, type SpaceStore, type Spaces } from "@/server/spaces/service.ts";
import type { Access, ThreadAccess } from "@/server/access/access.ts";
import type { SharedThread } from "@/shared/guests.ts";
import type { Page, PageParams } from "@/shared/paging.ts";
import { statusOf, type ThreadShow, type ThreadStatus } from "@/shared/thread-status.ts";
import type { ListChange } from "@/shared/threads/list-feed.ts";
import {
  type ListedSubagent,
  type ThreadStanding,
  type ThreadListItem,
  type ThreadParticipants,
  type ThreadSidebar,
  SIDEBAR_LIMIT,
  type ShownModel,
} from "@/shared/threads/list.ts";
import type { ThreadSearchResult } from "@/shared/threads/search.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import type {
  ListedThread,
  Listed,
  ListWindow,
  Thread,
  ThreadListFilter,
  ThreadStore,
  ThreadWriters,
} from "@/server/threads/types.ts";

import { threadSummary } from "@/server/threads/threads.ts";
import type { Needs } from "./needs.ts";
import type { Reads } from "./reads.ts";

export interface ListsOptions {
  spaces: Spaces;
  // Reads a thread's space for its defaults, whoever reads the thread.
  spaceStore: Pick<SpaceStore, "find">;
  access: Pick<ThreadAccess, "of">;
  guests: Pick<GuestStore, "threadsOf" | "sharedListed">;
  threads: ThreadStore;
  runs: Pick<RunReads, "activeIn" | "activeInSpace">;
  models: Pick<Models, "inOrg" | "shownModels">;
  signals: Signals;
  needs: Pick<Needs, "of" | "standing">;
  reads: Pick<Reads, "seen">;
  // The subagents threads' agents start, when given.
  subagents?: Pick<Subagents, "ofParents">;
  now?: () => Date;
}

export type Lists = ReturnType<typeof createLists>;

export const SEARCH_LIMIT = 200;
// How long an feed gathers changes before telling them.
const INBOX_DELAY_MS = 50;
// How far back the feed's next ask is held by a write still open. A run's writes are held no longer
// than its lease (30 s by default): an instance that stalls past it has its run taken over and what
// it writes after refused, so a transaction open longer holds back nothing that is still to be told.
const WRITE_HELD_MS = 30_000;

// How pressing each status is that a thread takes in from its subagents.
const PRESSING: ThreadStatus[] = ["waiting", "working", "paused"];

// The thread's own status, or the most pressing of its subagents' where that presses more.
function withSubagents(own: ThreadStatus, subagents: readonly ListedSubagent[]): ThreadStatus {
  if (own === "waiting" || own === "failed") return own;
  const shown = subagents.filter((subagent) => subagent.state !== "archived");
  const pressing = PRESSING.find((status) => shown.some((subagent) => subagent.status === status));
  if (!pressing) return own;
  return own === "working" && pressing === "paused" ? own : pressing;
}

// The most people a list names of those who have written in a thread.
const PARTICIPANT_LIMIT = 3;

// The few who wrote in the thread most recently, each saying whether they wrote as a guest, and how
// many have.
function participantsOf(writers: ThreadWriters = []): ThreadParticipants {
  return {
    people: writers.slice(0, PARTICIPANT_LIMIT).map(({ userId, name, former, guest }) => ({
      userId,
      name,
      former: former || name === null,
      guest,
    })),
    total: writers.length,
  };
}

export function createLists(options: ListsOptions) {
  const {
    spaces,
    spaceStore,
    access,
    guests,
    threads,
    runs,
    models,
    signals,
    needs,
    reads,
    subagents,
  } = options;
  const now = options.now ?? (() => new Date());

  // The model each thread's row shows, its own or the default it follows; reads each space, each
  // org's settings and each org's connections once, however many threads ask at once.
  function shownModelOf() {
    const spacesById = new Map<string, Promise<Space | null>>();
    const orgs = new Map<string, Promise<OrgModels>>();
    const shownIn = new Map<string, Promise<(ref: string) => ShownModel>>();
    const once = <T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
      const known = map.get(key) ?? read();
      map.set(key, known);
      return known;
    };
    return async (thread: Thread): Promise<ShownModel | null> => {
      const space = await once(spacesById, thread.spaceId, async () =>
        spaceStore.find(thread.spaceId),
      );
      if (!space) return null;
      const org = await once(orgs, space.orgId, async () => models.inOrg(space.orgId));
      const ref = thread.model ?? org.defaults(space).model;
      if (!ref) return null;
      const shown = await once(shownIn, space.orgId, async () => models.shownModels(space.orgId));
      return shown(ref);
    };
  }

  // The subagents the threads' agents started, as the reader's lists show them under each.
  async function subagentsUnder(
    userId: string,
    list: Thread[],
  ): Promise<Map<string, ListedSubagent[]>> {
    const under = new Map<string, ListedSubagent[]>();
    const found = (await subagents?.ofParents(list.map((thread) => thread.id))) ?? [];
    if (found.length === 0) return under;
    const byId = new Map(
      (await threads.findAll(found.map(({ record }) => record.threadId))).map((one) => [
        one.id,
        one,
      ]),
    );
    // In the order they were started.
    const childThreads = found.flatMap(({ record }) => byId.get(record.threadId) ?? []);
    const items = new Map(
      (
        await itemsOf(
          userId,
          childThreads,
          await runs.activeIn(childThreads.map((thread) => thread.id)),
          false,
        )
      ).map((item) => [item.id, item]),
    );
    for (const { record, summary } of found) {
      const item = items.get(record.threadId);
      if (!item) continue;
      const listed = under.get(record.parentThreadId) ?? [];
      listed.push({
        ...summary,
        // A subagent goes by its label, whatever its thread is called.
        title: record.name,
        untitled: false,
        updatedAt: item.updatedAt,
        shownModel: item.shownModel,
        participants: item.participants,
        standing: item.standing,
        status: item.status,
      });
      under.set(record.parentThreadId, listed);
    }
    return under;
  }

  // The threads as the reader's lists show them: each with its model, who has written in it, what
  // it holds for them, and its subagents.
  async function itemsOf(
    userId: string,
    list: Thread[],
    active: Run[],
    nested = true,
  ): Promise<ThreadListItem[]> {
    const ids = list.map((thread) => thread.id);
    const shownModel = shownModelOf();
    const facts = await threads.facts(ids);
    const writers = await threads.writers(ids);
    const seen = await reads.seen(userId, ids);
    const runOf = new Map(active.map((run) => [run.threadId, run]));
    const waiting = await needs.of({ userId }, ids);
    const under = nested ? await subagentsUnder(userId, list) : new Map<string, ListedSubagent[]>();
    return await Promise.all(
      list.map(async (thread) => {
        // Nobody is expected to read a subagent's thread, so nothing in it is ever new to them.
        const fact = thread.parentThreadId
          ? { ...facts.get(thread.id), notable: null }
          : facts.get(thread.id);
        const standing: ThreadStanding = {
          ...needs.standing(runOf.get(thread.id), waiting.get(thread.id) ?? []),
          lastNotableSeq: fact?.notable?.seq ?? 0,
          lastNotableBy: fact?.notable?.by ?? null,
          failed: fact?.failed ?? null,
          lastSeenSeq: seen.get(thread.id) ?? 0,
        };
        const subagentsOf = under.get(thread.id);
        const status = statusOf(standing, userId);
        return {
          ...threadSummary(thread),
          shownModel: await shownModel(thread),
          participants: participantsOf(writers.get(thread.id)),
          standing,
          status: subagentsOf ? withSubagents(status, subagentsOf) : status,
          ...(subagentsOf && { subagents: subagentsOf }),
        };
      }),
    );
  }

  // How the reader comes to the thread, when they can read it and its space is not archived.
  async function listedAccess(principal: Principal, thread: Thread) {
    const read = await access.of(principal, thread);
    return read && !read.space?.archived ? read.via : null;
  }

  // How the reader comes to each thread, when they can read it and its space is not archived; read
  // once per space for a member of it, whose standing there holds for all its threads, and per
  // thread for a guest.
  async function listedAccessOf(principal: Principal, list: readonly Thread[]) {
    const vias = new Map<string, Access | null>();
    for (const inSpace of Map.groupBy(list, (thread) => thread.spaceId).values()) {
      const [first, ...rest] = inSpace;
      const read = await access.of(principal, first!);
      if (read?.space?.archived || read?.via?.via === "space") {
        const via = read.space?.archived ? null : read.via;
        for (const thread of inSpace) vias.set(thread.id, via);
        continue;
      }
      vias.set(first!.id, read?.via ?? null);
      for (const thread of rest) vias.set(thread.id, await listedAccess(principal, thread));
    }
    return vias;
  }

  // The threads as the reader's list feed tells them, by the id asked for, or null for one not in
  // their lists. A subagent's thread is told as the thread its subagents are listed under.
  async function feedItems(principal: Principal, ids: readonly string[]) {
    const found = new Map((await threads.findAll(ids)).map((thread) => [thread.id, thread]));
    const roots = new Map(
      (
        await threads.findAll([...found.values()].flatMap((thread) => thread.rootThreadId ?? []))
      ).map((thread) => [thread.id, thread]),
    );
    const told = new Map<string, Thread>();
    for (const id of ids) {
      const thread = found.get(id);
      const shown = thread?.rootThreadId ? roots.get(thread.rootThreadId) : thread;
      if (shown) told.set(id, shown);
    }
    const shown = [...new Map([...told.values()].map((thread) => [thread.id, thread])).values()];
    const vias = await listedAccessOf(principal, shown);
    const listed = shown.filter((thread) => vias.get(thread.id));
    const items = new Map(
      (
        await itemsOf(
          principal.userId,
          listed,
          await runs.activeIn(listed.map((thread) => thread.id)),
        )
      ).map((item) => [item.id, item]),
    );
    return new Map(
      ids.map((id): [string, ListChange | null] => {
        const thread = told.get(id);
        const via = thread && vias.get(thread.id);
        const item = thread && items.get(thread.id);
        return [
          id,
          via && item ? { kind: "thread", thread: item, shared: via.via === "guest" } : null,
        ];
      }),
    );
  }

  // The space's threads, each with who has written in it.
  async function listIn(principal: Principal, spaceId: string): Promise<ThreadListItem[]> {
    await spaces.require(principal, spaceId);
    return itemsOf(
      principal.userId,
      await threads.listInSpace(spaceId),
      await runs.activeInSpace(spaceId),
    );
  }

  // The threads the principal is a guest in, as their lists show them, with their spaces' and orgs'
  // names.
  async function sharedItems(principal: Principal, shared: GuestThread[]): Promise<SharedThread[]> {
    const items = await itemsOf(
      principal.userId,
      shared.map(({ thread }) => thread),
      await runs.activeIn(shared.map(({ thread }) => thread.id)),
    );
    return shared.map((shared, index) => {
      const { shownModel, participants, standing, status } = items[index]!;
      return {
        ...threadSummary(shared.thread),
        spaceName: shared.spaceName,
        orgName: shared.orgName,
        place: shared.spaceNamedForOrg
          ? shared.spaceName
          : `${shared.spaceName} · ${shared.orgName}`,
        accessUntil: shared.accessUntil?.toISOString() ?? null,
        shownModel,
        participants,
        standing,
        status,
      };
    });
  }

  // Those of a list's threads, each with whether its run waits and whether it failed since the
  // reader looked, that the page asks for, and how many match in all. Whether the reader may decide
  // on a waiting run, which makes it need them, is worked out here, for the few that wait.
  async function pageOfListed<T extends ListedThread>(
    userId: string,
    params: PageParams & { show?: ThreadShow },
    read: (filter: ThreadListFilter, window?: ListWindow) => Promise<Listed<T>>,
  ): Promise<Listed<T>> {
    const window = { limit: params.limit, offset: params.offset ?? 0 };
    const text = params.q;
    if (params.show !== "needs-you") {
      return read({ ...(text && { text }), ...(params.show && { show: params.show }) }, window);
    }
    const { rows } = await read({ ...(text && { text }), show: "maybe-needs-you" });
    const asking = rows.filter((row) => row.waiting && !row.failed).map((row) => row.thread);
    const yours = new Set(
      (await itemsOf(userId, asking, await runs.activeIn(asking.map((thread) => thread.id))))
        .filter((item) => item.status === "waiting")
        .map((item) => item.id),
    );
    const needing = rows.filter((row) => row.failed || yours.has(row.thread.id));
    return {
      rows: needing.slice(window.offset, window.offset + window.limit),
      total: needing.length,
    };
  }

  return {
    inSpace: listIn,

    // A page of the space's threads, by when they were last active, narrowed to those whose title
    // or newest message contains the text, and to those the reader's status shows.
    async page(
      principal: Principal,
      spaceId: string,
      params: PageParams & { show?: ThreadShow },
    ): Promise<Page<ThreadListItem>> {
      await spaces.require(principal, spaceId);
      const { rows, total } = await pageOfListed(principal.userId, params, async (filter, window) =>
        threads.listed(principal.userId, spaceId, filter, window),
      );
      const list = rows.map((row) => row.thread);
      return {
        items: await itemsOf(
          principal.userId,
          list,
          await runs.activeIn(list.map((thread) => thread.id)),
        ),
        nextCursor: null,
        total,
      };
    },

    // The space's threads for the reader's sidebar: the newest few, with those that need the
    // reader; how many the space holds; and how many need the reader in all.
    async sidebar(principal: Principal, spaceId: string): Promise<ThreadSidebar> {
      await spaces.require(principal, spaceId);
      const { rows, total, failed } = await threads.sidebar(
        principal.userId,
        spaceId,
        SIDEBAR_LIMIT,
      );
      const list = rows.map((row) => row.thread);
      const items = await itemsOf(
        principal.userId,
        list,
        await runs.activeIn(list.map((thread) => thread.id)),
      );
      const waitingOnYou = items.filter((item) => item.status === "waiting").length;
      return { threads: items, total, needsYou: failed + waitingOnYou };
    },

    // Threads whose titles contain the text, ignoring case, untitled ones as "Untitled", every one
    // without text, in every space the principal can see and among those they are a guest in: the
    // most recently active first, at most 200, each with the model it shows and what it holds for
    // them.
    async search(principal: Principal, text: string): Promise<ThreadSearchResult[]> {
      const names = new Map(
        (
          await filterAsync(
            await spaces.list(principal),
            async (space) => !space.archived && (await spaces.canSee(principal, space)),
          )
        ).map((space) => [space.id, space.name]),
      );
      const needle = text.toLowerCase();
      const shared = (
        await filterAsync(
          (await guests.threadsOf(principal.userId, now())).filter(
            ({ thread }) => !names.has(thread.spaceId),
          ),
          async ({ thread }) => !(await spaces.isArchived(thread.spaceId)),
        )
      )
        .filter(({ thread }) => (thread.title ?? UNTITLED).toLowerCase().includes(needle))
        .map(({ thread, spaceName }) => ({ thread, spaceName, shared: true }));
      const found = [
        ...(await threads.search([...names.keys()], text, SEARCH_LIMIT, UNTITLED)).map(
          (thread) => ({ thread, spaceName: names.get(thread.spaceId) ?? "", shared: false }),
        ),
        ...shared,
      ]
        .toSorted(
          (a, b) =>
            b.thread.updatedAt.getTime() - a.thread.updatedAt.getTime() ||
            b.thread.id.localeCompare(a.thread.id),
        )
        .slice(0, SEARCH_LIMIT);
      const list = found.map(({ thread }) => thread);
      const items = await itemsOf(
        principal.userId,
        list,
        await runs.activeIn(list.map(({ id }) => id)),
      );
      return found.map(({ thread, spaceName, shared }, index) => ({
        ...threadSummary(thread),
        spaceName,
        shared,
        shownModel: items[index]!.shownModel,
        standing: items[index]!.standing,
        status: items[index]!.status,
      }));
    },

    // The threads the principal is a guest in, most recently active first.
    async shared(principal: Principal): Promise<SharedThread[]> {
      return sharedItems(principal, await guests.threadsOf(principal.userId, now()));
    },

    // A page of the threads the principal is a guest in, narrowed to those whose title or place
    // contains the text, and to those their status shows.
    async sharedPage(
      principal: Principal,
      params: PageParams & { show?: ThreadShow },
    ): Promise<Page<SharedThread>> {
      const { rows, total } = await pageOfListed(principal.userId, params, async (filter, window) =>
        guests.sharedListed(principal.userId, now(), filter, window),
      );
      return { items: await sharedItems(principal, rows), nextCursor: null, total };
    },

    // Delivers what changes for the principal in the threads they can read: each such thread as it
    // now reads for them, a few at a time, how far they saw a thread, then that thread again with the
    // status it now has for them, and each thread they can no
    // longer read, deleted, with their access ended or in a space now archived. `recheck` finds the
    // threads they lost without anything happening in them. Returns the function that stops it.
    async feed(principal: Principal, deliver: (item: ListChange) => void) {
      // The threads they could read when last looked at; their shared ones from the start.
      const known = new Set(
        (await guests.threadsOf(principal.userId, now())).map(({ thread }) => thread.id),
      );
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The spaces whose threads they see, and the threads they are a guest in.
      const readableNow = async () => ({
        spaceIds: (
          await filterAsync(
            await spaces.list(principal),
            async (space) => !space.archived && (await spaces.canSee(principal, space)),
          )
        ).map((space) => space.id),
        threadIds: (await guests.threadsOf(principal.userId, now())).map(({ thread }) => thread.id),
      });
      // Where the next beat asks from: the database's time when the feed opened, then at each beat,
      // held back by writes still open; what the last beat found, so one found again unchanged is
      // not told twice.
      let lastFound = new Map<string, string>();
      let since = (
        await threads.changedSince({
          spaceIds: [],
          threadIds: [],
          userId: principal.userId,
          since: new Date(),
          heldAtMost: WRITE_HELD_MS,
        })
      ).at;
      // What is delivered is worked out one thing at a time, in the order it came.
      let turn: Promise<void> = Promise.resolve();
      const later = (work: () => Promise<void>) => {
        turn = turn.then(work).catch(() => {});
      };
      async function flush() {
        timer = undefined;
        // What changes while these are read waits for the next time.
        const ids = [...pending];
        pending.clear();
        let items: Awaited<ReturnType<typeof feedItems>>;
        try {
          items = await feedItems(principal, ids);
        } catch (err) {
          // Told at the next flush, as the beat that found them does not find them again.
          for (const id of ids) pending.add(id);
          throw err;
        }
        for (const id of ids) {
          const item = items.get(id);
          if (item) {
            known.add(id);
            deliver(item);
          } else if (known.delete(id)) {
            deliver({ kind: "gone", threadId: id });
          }
        }
      }
      const soon = () => {
        timer ??= setTimeout(() => later(flush), INBOX_DELAY_MS);
      };
      const unsubscribe = signals.onChanged((change) => {
        const { threadId, read, gone } = change;
        if (change.tasks || change.rows || change.activity) return;
        if (read) {
          if (read.userId !== principal.userId) return;
          later(async () => deliver({ kind: "read", threadId, seq: read.seq }));
          // Its status for them follows from how far they saw it.
          pending.add(threadId);
          soon();
          return;
        }
        if (gone) {
          pending.delete(threadId);
          later(async () => {
            // Its guests knew it from the start, or once it reached them; members see its space.
            const had =
              known.delete(threadId) || !!(await spaces.findVisible(principal, gone.spaceId));
            if (had) deliver({ kind: "gone", threadId });
          });
          return;
        }
        pending.add(threadId);
        // Changes that come together, as a run's steps do, are told once.
        soon();
      });
      // After a gap in what this instance heard, every thread told of is looked at again.
      const stopGap = signals.onGap(() => {
        for (const id of known) pending.add(id);
        soon();
      });
      return {
        stop() {
          unsubscribe();
          stopGap();
          clearTimeout(timer);
        },
        async recheck() {
          const found = await threads.findAll([...known]);
          const vias = await listedAccessOf(principal, found);
          for (const id of known) {
            if (vias.get(id)) continue;
            known.delete(id);
            deliver({ kind: "gone", threadId: id });
          }
          // What changed for them since the last beat, by the database's clock, as a hint may be
          // lost; each goes through the flush as a hint's thread does.
          const changed = await threads.changedSince({
            ...(await readableNow()),
            userId: principal.userId,
            since,
            heldAtMost: WRITE_HELD_MS,
          });
          since = changed.at;
          const fresh = [...changed.changes].filter(([id, stamp]) => lastFound.get(id) !== stamp);
          lastFound = changed.changes;
          for (const [id] of fresh) pending.add(id);
          if (pending.size > 0) soon();
        },
      };
    },
  };
}

// A reader's lists of threads as their clients meet them: what each item says, for an owner, a
// member who may not decide and a guest; the pages that show only what needs the reader or is
// new to them, the sidebar, search and the shared page; and what the list feed tells as threads
// change. Everything is arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import { eventually, expect, type Person, type World, world } from "@/server/testing/contract.ts";
import type { SharedThread } from "@/shared/guests.ts";
import type { ListedSubagent, ThreadListItem, ThreadSidebar } from "@/shared/threads/list.ts";
import type { ThreadSearchResult } from "@/shared/threads/search.ts";

type Page<T> = { items: T[]; nextCursor: string | null; total: number };

// What an item tells its reader, in a few words: its status, what its run does and whether the
// reader may decide for it, who wrote last, its failure, its model and who has written in it.
function told(item: ThreadListItem | SharedThread | ListedSubagent, w: World) {
  const names = new Map([
    [w.ada.userId, "Ada"],
    [w.grace.userId, "Grace"],
    [w.alan.userId, "Alan"],
  ]);
  const { standing, participants } = item;
  return {
    status: item.status,
    run: standing.run?.status ?? null,
    needsYou: standing.needsYou,
    lastNotableBy: standing.lastNotableBy && (names.get(standing.lastNotableBy) ?? "someone"),
    failed: standing.failed?.error ?? null,
    model: item.shownModel && `${item.shownModel.name} by ${item.shownModel.maker}`,
    participants: [
      ...participants.people.map((one) => `${one.name}${one.guest ? " (guest)" : ""}`),
      `${participants.total} in all`,
    ],
  };
}

// The thread as the reader's list shows it: their space's for members, the shared one for a guest.
async function item(w: World, who: Person, guest: boolean, threadId = w.threadId) {
  if (!guest) return w.listed(who, threadId);
  const shared = await w.json<SharedThread[]>(await w.api("GET", "/shared-threads", who.cookie));
  const found = shared.find((one) => one.id === threadId);
  if (!found) throw new Error("the thread is not shared with them");
  return found;
}

// The thread as the owner, the member who may not decide and the guest read it in their lists.
async function readers(w: World, guest: Person, threadId = w.threadId) {
  return {
    owner: told(await item(w, w.ada, false, threadId), w),
    viewer: told(await item(w, w.alan, false, threadId), w),
    guest: told(await item(w, guest, true, threadId), w),
  };
}

const MODEL = "gpt-big by openai";

// Answers the thread's agent until nothing runs or waits there.
async function answered(w: World) {
  for (;;) {
    const { asked } = await eventually(
      async () => ({ asked: w.waitsForModel(), shown: await w.shown() }),
      ({ asked, shown }) => asked || (shown.run === null && shown.waiting.length === 0),
    );
    if (!asked) return;
    await w.answers(w.threadId, "Noted.");
  }
}

describe("a list item", () => {
  it("tells each reader the status the thread has for them, as it goes through each", async () => {
    const w = await world();
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");

    await w.post(w.grace, "// For everyone");
    const written = {
      run: null,
      needsYou: false,
      lastNotableBy: "Grace",
      failed: null,
      model: MODEL,
      participants: ["Grace Hopper", "1 in all"],
    };
    expect(await readers(w, hedy)).toEqual({
      owner: { ...written, status: "unread" },
      viewer: { ...written, status: "unread" },
      guest: { ...written, status: "unread" },
    });
    expect(told(await w.listed(w.grace), w).status).toBe("read");

    expect(await w.act(w.ada, "PUT", "/read", { seq: 1000 })).toBe(200);
    expect((await readers(w, hedy)).owner.status).toBe("read");

    await w.post(w.ada, "Do the guarded thing");
    const call = await w.next(w.threadId);
    call.startStep();
    await call.drained();
    const working = {
      run: "running",
      needsYou: false,
      lastNotableBy: "Ada",
      failed: null,
      model: MODEL,
      participants: ["Ada Lovelace", "Grace Hopper", "2 in all"],
      status: "working",
    };
    expect(await readers(w, hedy)).toEqual({ owner: working, viewer: working, guest: working });

    call.toolCall("call-guarded", "probe.guarded", { label: "a" });
    call.endStep();
    call.end();
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );
    // The agent's reply before the call is the newest notable thing, by nobody.
    const waiting = { ...working, run: "waiting", lastNotableBy: null };
    expect(await readers(w, hedy)).toEqual({
      owner: { ...waiting, needsYou: true, status: "waiting" },
      viewer: { ...waiting, status: "paused" },
      guest: { ...waiting, needsYou: true, status: "waiting" },
    });

    expect(await w.decide(w.ada, "call-guarded", true)).toBe(200);
    (await w.next(w.threadId)).fail("The provider said no.");
    await w.settled();
    const failed = {
      ...waiting,
      run: null,
      failed: expect.stringContaining("The provider said no."),
    };
    expect(await readers(w, hedy)).toEqual({
      owner: { ...failed, status: "failed" },
      viewer: { ...failed, status: "failed" },
      guest: { ...failed, status: "failed" },
    });
  });

  it("holds the subagents its agent started, each as its own item, and takes in the most pressing status", async () => {
    const w = await world();
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    await w.post(w.ada, "Get help");
    await w.asks(
      w.threadId,
      ["subagents.start", { name: "Asker", task: "Ask" }],
      ["subagents.start", { name: "Quiet", task: "Rest" }],
    );
    await w.answers(w.threadId, "Started.");
    const asker = await w.subagentNamed("Asker");
    const quiet = await w.subagentNamed("Quiet");
    await w.answers(quiet, "Resting.");
    const { ids } = await w.asks(asker, ["probe.guarded", { label: "sub" }]);
    await eventually(
      () => w.shown(w.ada, asker),
      (shown) => shown.run === "decision",
    );
    await eventually(
      () => w.shown(w.ada, quiet),
      (shown) => shown.run === null,
    );
    await answered(w);

    const subagents = async (who: Person, guest: boolean) => {
      const listed = await item(w, who, guest);
      return {
        status: listed.status,
        subagents: ("subagents" in listed ? (listed.subagents ?? []) : []).map((one) => ({
          name: one.name,
          state: one.state,
          title: one.title,
          ...told(one, w),
        })),
      };
    };
    const sub = {
      lastNotableBy: null,
      failed: null,
      model: MODEL,
      participants: ["0 in all"],
    };
    expect(await subagents(w.ada, false)).toEqual({
      status: "waiting",
      subagents: [
        {
          ...sub,
          name: "Asker",
          state: "working",
          title: "Asker",
          status: "waiting",
          run: "waiting",
          needsYou: true,
        },
        {
          ...sub,
          name: "Quiet",
          state: "idle",
          title: "Quiet",
          status: "read",
          run: null,
          needsYou: false,
        },
      ],
    });
    expect((await subagents(w.alan, false)).status).toBe("paused");
    expect(await subagents(hedy, true)).toMatchObject({ status: "waiting" });
    // A subagent is listed under its starter, never as a thread of its own.
    const list = await w.json<ThreadListItem[]>(
      await w.api("GET", `/spaces/${w.spaceId}/threads`, w.ada.cookie),
    );
    expect(list.map((one) => one.id)).toEqual([w.threadId]);

    expect(await w.decide(w.ada, ids[0]!, true, "once", asker)).toBe(200);
    await w.answers(asker, "Asked.");
    await eventually(
      () => w.shown(w.ada, asker),
      (shown) => shown.run === null,
    );
    await answered(w);
    await w.settled();
  });
});

// Has the reader start a thread in the space, named so.
async function another(w: World, title: string, who: Person = w.ada, spaceId = w.spaceId) {
  const { id } = await w.json<{ id: string }>(
    await w.api("POST", `/spaces/${spaceId}/threads`, who.cookie, {}),
  );
  expect(await w.act(who, "PATCH", "", { title }, id)).toBe(200);
  return id;
}

describe("a list's pages", () => {
  // One thread waits on a decision, one has news from Grace, one holds only Ada's own note.
  async function three() {
    const w = await world();
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    expect(await w.act(w.ada, "PATCH", "", { title: "Needs a decision" })).toBe(200);
    await w.post(w.ada, "Do the guarded thing");
    await w.asks(w.threadId, ["probe.guarded", { label: "a" }]);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === "decision",
    );
    const news = await another(w, "News from Grace");
    await w.post(w.grace, "// News", "steer", news);
    const notes = await another(w, "Quiet notes");
    await w.post(w.ada, "// Mine", "steer", notes);
    return { w, hedy };
  }

  const page = async (w: World, who: Person, path: string, query: string) => {
    const read = await w.json<Page<{ title: string }>>(
      await w.api("GET", `${path}?${query}`, who.cookie),
    );
    return { titles: read.items.map((one) => one.title), total: read.total };
  };

  it("shows what needs the reader or is new to them, with the text asked for, and counts them", async () => {
    const { w, hedy } = await three();
    const space = `/spaces/${w.spaceId}/threads/page`;
    expect(await page(w, w.ada, space, "")).toEqual({
      titles: ["Quiet notes", "News from Grace", "Needs a decision"],
      total: 3,
    });
    expect(await page(w, w.ada, space, "show=needs-you")).toEqual({
      titles: ["Needs a decision"],
      total: 1,
    });
    expect(await page(w, w.ada, space, "show=unread")).toEqual({
      titles: ["News from Grace"],
      total: 1,
    });
    expect(await page(w, w.ada, space, "q=news")).toEqual({
      titles: ["News from Grace"],
      total: 1,
    });
    expect(await page(w, w.ada, space, "show=unread&q=decision")).toEqual({ titles: [], total: 0 });

    expect(await page(w, w.alan, space, "show=needs-you")).toEqual({ titles: [], total: 0 });
    expect(await page(w, w.alan, space, "show=unread")).toEqual({
      titles: ["Quiet notes", "News from Grace"],
      total: 2,
    });

    expect(await page(w, hedy, "/shared-threads/page", "show=needs-you")).toEqual({
      titles: ["Needs a decision"],
      total: 1,
    });
    expect(await page(w, hedy, "/shared-threads/page", "show=unread")).toEqual({
      titles: [],
      total: 0,
    });
  });

  it("has a sidebar that counts the space's threads and those that need the reader", async () => {
    const { w } = await three();
    const sidebar = async (who: Person) => {
      const read = await w.json<ThreadSidebar>(
        await w.api("GET", `/spaces/${w.spaceId}/threads/sidebar`, who.cookie),
      );
      return {
        titles: read.threads.map((one) => one.title),
        total: read.total,
        needsYou: read.needsYou,
      };
    };
    expect(await sidebar(w.ada)).toEqual({
      titles: ["Quiet notes", "News from Grace", "Needs a decision"],
      total: 3,
      needsYou: 1,
    });
    expect(await sidebar(w.alan)).toMatchObject({ total: 3, needsYou: 0 });
  });
});

describe("search and the shared page", () => {
  it("finds threads by title across the reader's spaces and the threads shared with them", async () => {
    const w = await world();
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    const later = await w.guest("Katherine Johnson", "katherine@example.com", "1d");
    expect(await w.act(w.ada, "PATCH", "", { title: "Findable first" })).toBe(200);
    const second = await w.json<{ id: string }>(
      await w.api("POST", "/spaces", w.ada.cookie, { name: "Second" }),
    );
    await another(w, "Findable second", w.ada, second.id);
    await another(w, "Something else");

    const search = async (who: Person, q: string) =>
      (
        await w.json<ThreadSearchResult[]>(await w.api("GET", `/threads/search?q=${q}`, who.cookie))
      ).map((one) => `${one.title} in ${one.spaceName}${one.shared ? " (shared)" : ""}`);
    // A person's own space is named for them to everyone else.
    const home = "Ada Lovelace's Space";
    expect((await search(w.ada, "findable")).toSorted()).toEqual([
      "Findable first in Personal Space",
      "Findable second in Second",
    ]);
    expect(await search(w.alan, "findable")).toEqual([`Findable first in ${home}`]);
    expect(await search(hedy, "findable")).toEqual([`Findable first in ${home} (shared)`]);
    expect(await search(hedy, "else")).toEqual([]);

    const shared = async (who: Person) =>
      (await w.json<Page<SharedThread>>(await w.api("GET", "/shared-threads/page", who.cookie)))
        .items;
    const [forHedy] = await shared(hedy);
    expect(forHedy).toMatchObject({
      id: w.threadId,
      title: "Findable first",
      spaceName: home,
      place: expect.stringContaining(home),
      accessUntil: null,
    });
    const [forLater] = await shared(later);
    expect(forLater!.place).toBe(forHedy!.place);
    expect(Date.parse(forLater!.accessUntil!) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});

describe("the list feed", () => {
  const thread =
    (id: string, holds: (item: ThreadListItem) => boolean = () => true) =>
    (item: { event: string; data: Record<string, any> }) =>
      item.event === "thread" && item.data.thread.id === id && holds(item.data.thread);

  it("tells of a post, a run as it starts, waits and ends, a decision, a rename and the reader's own read", async () => {
    const w = await world();
    const feed = await w.feed(w.ada);
    await feed.ready();

    await w.post(w.grace, "// Hello");
    expect((await feed.nextThat(thread(w.threadId))).data.thread).toMatchObject({
      status: "unread",
      standing: { lastNotableBy: w.grace.userId },
    });

    await w.post(w.ada, "Do the guarded thing");
    const call = await w.next(w.threadId);
    await feed.nextThat(thread(w.threadId, (item) => item.status === "working"));
    call.startStep();
    call.toolCall("call-guarded", "probe.guarded", { label: "a" });
    call.endStep();
    call.end();
    await feed.nextThat(thread(w.threadId, (item) => item.status === "waiting"));

    expect(await w.decide(w.ada, "call-guarded", true)).toBe(200);
    const after = await w.next(w.threadId);
    await feed.nextThat(thread(w.threadId, (item) => item.status === "working"));
    after.reply("Done.");
    await feed.nextThat(thread(w.threadId, (item) => item.standing.run === null));
    await w.settled();

    expect(await w.act(w.ada, "PATCH", "", { title: "Renamed" })).toBe(200);
    await feed.nextThat(thread(w.threadId, (item) => item.title === "Renamed"));

    const { lastEventSeq } = (await w.detail()).thread;
    expect(await w.act(w.ada, "PUT", "/read", { seq: lastEventSeq })).toBe(200);
    expect(await feed.nextThat((item) => item.event === "thread-read")).toEqual({
      event: "thread-read",
      data: { threadId: w.threadId, seq: lastEventSeq },
    });
    await feed.close();
  });

  it("tells a thread is gone once it is deleted, the guest's access ended or its space archived", async () => {
    const w = await world();
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    const gone = (id: string) => (item: { event: string; data: Record<string, any> }) =>
      item.event === "thread-gone" && item.data.threadId === id;

    const ada = await w.feed(w.ada);
    await ada.ready();
    const doomed = await another(w, "Doomed");
    await w.post(w.ada, "// Soon gone", "steer", doomed);
    await ada.nextThat(thread(doomed));
    expect(await w.act(w.ada, "DELETE", "", undefined, doomed)).toBe(200);
    await ada.nextThat(gone(doomed));
    await ada.close();

    const guest = await w.feed(hedy);
    await guest.ready();
    expect(await w.act(w.ada, "DELETE", `/guests/${hedy.userId}`)).toBe(200);
    await guest.nextThat(gone(w.threadId));
    await guest.close();

    const team = await w.teamThread();
    const grace = await w.feed(team.grace, team.grace.orgId);
    await grace.ready();
    expect(await team.post("// In the team")).toBe(202);
    await grace.nextThat(thread(team.threadId));
    expect(await team.archive()).toBe(200);
    await grace.nextThat(gone(team.threadId));
    await grace.close();
  });

  it("tells a subagent's change as its starter's item", async () => {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Helper", task: "Help" }]);
    await w.answers(w.threadId, "Started.");
    const helper = await w.subagentNamed("Helper");
    const call = await w.next(helper);
    await eventually(
      () => w.shown(),
      (shown) => shown.run === null,
    );
    const feed = await w.feed(w.ada);
    await feed.ready();

    call.startStep();
    call.toolCall("call-sub", "probe.guarded", { label: "sub" });
    call.endStep();
    call.end();
    const told = await feed.nextThat(
      thread(w.threadId, (item) => item.subagents?.[0]?.status === "waiting"),
    );
    expect(told.data.thread).toMatchObject({
      id: w.threadId,
      status: "waiting",
      subagents: [{ threadId: helper, name: "Helper", status: "waiting" }],
    });
    await feed.close();

    expect(await w.decide(w.ada, "call-sub", true, "once", helper)).toBe(200);
    await w.answers(helper, "Helped.");
    await eventually(
      () => w.shown(w.ada, helper),
      (shown) => shown.run === null,
    );
    await answered(w);
    await w.settled();
  });
});
